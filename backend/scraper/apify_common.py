"""Shared Apify actor-run helper, used by apify_twitter.py, apify_linkedin.py,
and apify_reddit.py.

Apify's one-shot "run-sync-get-dataset-items" convenience endpoint (used by
all three tiers until now) can return HTTP 200/201 with a placeholder dataset
even when the actor never actually ran - confirmed live: a rental actor whose
free monthly quota is exhausted still reports its run as SUCCEEDED, with a
dataset of bare `{"noResults": true}` stand-in items, and the real reason
("Monthly run limit exceeded... subscribe to a paid plan on Apify") only
appears on the run's own `statusMessage` - a field that convenience endpoint
never returns. So this instead starts the run directly, polls
`actor-runs/{id}` until it finishes, and inspects `statusMessage` before
fetching the dataset - the only way to tell a genuine subscription/billing
block (worth surfacing to the user, since nothing on this app's side fixes
it) apart from an ordinary empty result (not worth surfacing, same as every
other best-effort tier's silent-failure contract).
"""

import time

import requests

from app.core import settings as config

_RUNS_URL = "https://api.apify.com/v2/acts/{actor}/runs"
_RUN_STATUS_URL = "https://api.apify.com/v2/actor-runs/{run_id}"
_DATASET_ITEMS_URL = "https://api.apify.com/v2/datasets/{dataset_id}/items"

_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}

_POLL_INTERVAL_SECONDS = 2.0

# Substrings observed (or documented by Apify) on a run's `statusMessage`
# when the block is a subscription/credit problem rather than an ordinary
# actor/network failure - matched case-insensitively.
_BILLING_KEYWORDS = (
    "monthly run limit",
    "subscribe to a paid plan",
    "usage hard limit",
    "insufficient credit",
    "insufficient balance",
    "insufficient funds",
    "not enough credit",
    "out of credit",
    "payment required",
    "rental fee",
    "free tier",
    "upgrade your plan",
    "trial has ended",
)


class ApifyBillingError(Exception):
    """The one Apify failure worth surfacing to the user: the configured
    account can't run this actor for a subscription/credit reason, which no
    change on this app's side can fix."""


def _actor_path(actor):
    # Apify's REST API takes an actor id as a single path segment - a store
    # slug's "username/actor-name" form must have its slash swapped for "~",
    # or the extra "/" is parsed as a second path segment and 404s.
    return actor.strip("/").replace("/", "~")


def _billing_message(status_message):
    lowered = (status_message or "").lower()
    if any(keyword in lowered for keyword in _BILLING_KEYWORDS):
        return status_message.strip()
    return None


def run_actor_sync(actor, payload, actor_label=None, timeout=None):
    """Run an Apify actor to completion and return its dataset items (a
    list of dicts, possibly empty).

    Returns [] for `actor`/token unconfigured, or any ordinary failure (bad
    token, actor error, timeout, network hiccup) - the same best-effort
    contract every Apify tier already had. Raises ApifyBillingError only
    when the finished run's own statusMessage names a subscription/credit
    problem.

    `timeout` (seconds) bounds both the HTTP requests and the total poll
    budget; defaults to config.APIFY_TIMEOUT_SECONDS but callers whose actor
    routinely runs longer (e.g. apify_reddit.py's real-subreddit scrapes,
    observed taking 180s+ against the shared tier's 120s default) should
    pass their own, larger value - otherwise a still-RUNNING run at the
    deadline is indistinguishable here from a genuine failure and this
    returns [] even though the run goes on to succeed with real data.
    """
    if not config.apify_configured() or not actor:
        return []

    token = config.APIFY_API_TOKEN
    timeout = timeout if timeout is not None else config.APIFY_TIMEOUT_SECONDS

    try:
        start_response = requests.post(
            _RUNS_URL.format(actor=_actor_path(actor)),
            params={"token": token},
            json=payload,
            timeout=timeout,
        )
        start_response.raise_for_status()
        run = (start_response.json() or {}).get("data") or {}
        run_id = run.get("id")
        if not run_id:
            return []
    except Exception:
        return []

    deadline = time.monotonic() + timeout
    status = run.get("status")
    status_message = run.get("statusMessage")
    while status not in _TERMINAL_STATUSES and time.monotonic() < deadline:
        time.sleep(_POLL_INTERVAL_SECONDS)
        try:
            poll_response = requests.get(
                _RUN_STATUS_URL.format(run_id=run_id),
                params={"token": token},
                timeout=timeout,
            )
            poll_response.raise_for_status()
            run = (poll_response.json() or {}).get("data") or {}
        except Exception:
            return []
        status = run.get("status")
        status_message = run.get("statusMessage")

    billing_message = _billing_message(status_message)
    if billing_message:
        raise ApifyBillingError(
            f"Apify actor {actor_label or actor!r} could not run: {billing_message}"
        )

    if status != "SUCCEEDED":
        return []

    dataset_id = run.get("defaultDatasetId")
    if not dataset_id:
        return []

    try:
        items_response = requests.get(
            _DATASET_ITEMS_URL.format(dataset_id=dataset_id),
            params={"token": token},
            timeout=timeout,
        )
        items_response.raise_for_status()
        items = items_response.json()
        return items if isinstance(items, list) else []
    except Exception:
        return []
