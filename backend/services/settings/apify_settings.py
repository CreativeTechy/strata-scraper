"""Dashboard-editable Apify settings: which actor each platform uses, how many
posts it may return, and how long to wait for it - plus a read-only look at
each actor's published price on Apify.

Overrides live in the `app_settings` table as text. `app.core.settings` holds
the live values and the env/default baseline each one falls back to; this
module validates input, persists it, and re-applies it.
"""

from __future__ import annotations

import re
import threading
import time

import requests

from api.errors import ValidationError
from app.core import db
from app.core import settings as config

# One row per actor the app can call. `max_key` is shared where several
# actors draw on one cap (LinkedIn's two actors, Facebook's pages/groups/
# search), so editing it in one row moves them together.
TIERS = [
    {"id": "twitter", "platform": "twitter", "kind": "search",
     "actor_key": "APIFY_TWITTER_SEARCH_ACTOR", "max_key": "APIFY_TWITTER_MAX_TWEETS",
     "timeout_key": "APIFY_TWITTER_SEARCH_TIMEOUT_SECONDS"},
    {"id": "reddit", "platform": "reddit", "kind": "search",
     "actor_key": "APIFY_REDDIT_SEARCH_ACTOR", "max_key": "APIFY_REDDIT_MAX_ITEMS",
     "timeout_key": "APIFY_REDDIT_SEARCH_TIMEOUT_SECONDS"},
    {"id": "linkedin_posts", "platform": "linkedin", "kind": "posts",
     "actor_key": "APIFY_LINKEDIN_POSTS_ACTOR", "max_key": "APIFY_LINKEDIN_MAX_POSTS",
     "timeout_key": "APIFY_LINKEDIN_POSTS_TIMEOUT_SECONDS"},
    {"id": "linkedin_search", "platform": "linkedin", "kind": "search",
     "actor_key": "APIFY_LINKEDIN_SEARCH_ACTOR", "max_key": "APIFY_LINKEDIN_MAX_POSTS",
     "timeout_key": "APIFY_LINKEDIN_SEARCH_TIMEOUT_SECONDS"},
    {"id": "threads", "platform": "threads", "kind": "posts",
     "actor_key": "APIFY_THREADS_ACTOR", "max_key": "APIFY_THREADS_MAX_POSTS",
     "timeout_key": "APIFY_THREADS_TIMEOUT_SECONDS"},
    {"id": "instagram", "platform": "instagram", "kind": "posts",
     "actor_key": "APIFY_INSTAGRAM_ACTOR", "max_key": "APIFY_INSTAGRAM_MAX_POSTS",
     "timeout_key": "APIFY_INSTAGRAM_TIMEOUT_SECONDS"},
    {"id": "facebook_pages", "platform": "facebook", "kind": "pages",
     "actor_key": "APIFY_FACEBOOK_PAGES_ACTOR", "max_key": "APIFY_FACEBOOK_MAX_POSTS",
     "timeout_key": "APIFY_FACEBOOK_PAGES_TIMEOUT_SECONDS"},
    {"id": "facebook_groups", "platform": "facebook", "kind": "groups",
     "actor_key": "APIFY_FACEBOOK_GROUPS_ACTOR", "max_key": "APIFY_FACEBOOK_MAX_POSTS",
     "timeout_key": "APIFY_FACEBOOK_GROUPS_TIMEOUT_SECONDS"},
    {"id": "facebook_search", "platform": "facebook", "kind": "search",
     "actor_key": "APIFY_FACEBOOK_SEARCH_ACTOR", "max_key": "APIFY_FACEBOOK_MAX_POSTS",
     "timeout_key": "APIFY_FACEBOOK_SEARCH_TIMEOUT_SECONDS"},
    {"id": "facebook_profile", "platform": "facebook", "kind": "profile",
     "actor_key": "APIFY_FACEBOOK_PROFILE_ACTOR", "max_key": "APIFY_FACEBOOK_PROFILE_MAX_POSTS",
     "timeout_key": "APIFY_FACEBOOK_PROFILE_TIMEOUT_SECONDS"},
]

MAX_POSTS_RANGE = (1, 1000)
TIMEOUT_RANGE = (10, 1800)

_ACTOR_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

_PRICING_TTL_SECONDS = 600
_ACTOR_URL = "https://api.apify.com/v2/acts/{actor}"
_pricing_cache: dict[str, tuple[float, dict]] = {}
_pricing_lock = threading.Lock()


def _validate(key: str, raw) -> str:
    """Return the normalized text to store for `key`, or raise ValidationError."""
    text = str(raw).strip()
    if key.endswith("_ACTOR"):
        if not _ACTOR_RE.match(text):
            raise ValidationError(
                f"{key} must look like 'username/actor-name'.",
                code="settings.invalid_actor", params={"key": key},
            )
        return text
    low, high = MAX_POSTS_RANGE if "_MAX_" in key else TIMEOUT_RANGE
    try:
        number = int(text)
    except ValueError:
        number = None
    if number is None or not low <= number <= high:
        raise ValidationError(
            f"{key} must be a whole number between {low} and {high}.",
            code="settings.out_of_range", params={"key": key, "min": low, "max": high},
        )
    return str(number)


def get_overrides() -> dict[str, str]:
    return {row["key"]: row["value"] for row in db.fetch_all("select key, value from app_settings")}


def save_overrides(values: dict, updated_by: str | None = None) -> None:
    """Persist `values` ({KEY: value}); a null/blank value clears that
    override so the key falls back to its env/default baseline."""
    unknown = [key for key in values if key not in config.APIFY_EDITABLE_KEYS]
    if unknown:
        raise ValidationError(
            f"Unknown setting: {unknown[0]}", code="settings.unknown_key", params={"key": unknown[0]},
        )
    # Validate everything before writing anything, so a bad field in the
    # middle of the form doesn't leave half of it saved.
    cleaned = {
        key: (None if raw is None or not str(raw).strip() else _validate(key, raw))
        for key, raw in values.items()
    }
    for key, value in cleaned.items():
        if value is None:
            db.execute("delete from app_settings where key = %s", (key,))
        else:
            db.execute(
                """
                insert into app_settings (key, value, updated_by) values (%s, %s, %s)
                on conflict (key) do update
                set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
                """,
                (key, value, updated_by),
            )
    config.load_apify_overrides()


def view() -> dict:
    overrides = get_overrides()
    rows = []
    for tier in TIERS:
        row = {"id": tier["id"], "platform": tier["platform"], "kind": tier["kind"]}
        for field in ("actor", "max", "timeout"):
            key = tier[f"{field}_key"]
            row[f"{field}_key"] = key
            row[field] = getattr(config, key)
            row[f"{field}_default"] = config.APIFY_BASELINE[key]
            row[f"{field}_overridden"] = key in overrides
        rows.append(row)
    return {
        "token_configured": config.apify_configured(),
        "limits": {
            "max": {"min": MAX_POSTS_RANGE[0], "max": MAX_POSTS_RANGE[1]},
            "timeout": {"min": TIMEOUT_RANGE[0], "max": TIMEOUT_RANGE[1]},
        },
        "tiers": rows,
    }


# Apify prices some actors per plan tier. BRONZE is the standard paid-plan
# price a store listing quotes; FREE-plan prices can differ, so they are only
# a fallback.
_TIER_ORDER = ("BRONZE", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "FREE")
# The event Apify charges once per dataset item, i.e. per scraped result.
_DEFAULT_ITEM_EVENT = "apify-default-dataset-item"


def _tiered(tiers, field):
    if not isinstance(tiers, dict):
        return None
    for name in _TIER_ORDER:
        value = (tiers.get(name) or {}).get(field)
        if value is not None:
            return value
    return None


def _first(*values):
    return next((value for value in values if value is not None), None)


def _normalize_pricing(actor: str, data: dict) -> dict:
    """Boil an Apify actor record's `pricingInfos` down to the current price.

    `per_result_usd` is the cost of one scraped result when the actor charges
    per result (either the older per-dataset-item model or a pay-per-event
    actor's default dataset-item event); `events` lists any other charges."""
    infos = [info for info in (data.get("pricingInfos") or []) if isinstance(info, dict)]
    result = {"actor": actor, "url": f"https://apify.com/{actor}", "title": data.get("title"),
              "model": "FREE", "per_result_usd": None, "unit": None, "monthly_usd": None,
              "trial_minutes": None, "events": []}
    if not infos:
        # Apify omits pricingInfos for an actor that is simply free to run
        # (you pay only for the compute it uses).
        return result
    info = sorted(infos, key=lambda item: str(item.get("startedAt") or ""))[-1]
    model = info.get("pricingModel") or "FREE"
    result.update(model=model, unit=info.get("unitName"), trial_minutes=info.get("trialMinutes"))

    if model == "PRICE_PER_DATASET_ITEM":
        result["per_result_usd"] = _first(
            info.get("pricePerUnitUsd"), _tiered(info.get("tieredPricing"), "tieredPricePerUnitUsd"))
    elif model == "FLAT_PRICE_PER_MONTH":
        # "Rental" actors report the monthly fee as the unit price.
        result["monthly_usd"] = _first(
            info.get("pricePerUnitUsd"), _tiered(info.get("tieredPricing"), "tieredPricePerUnitUsd"))
    elif model == "PAY_PER_EVENT":
        for name, event in ((info.get("pricingPerEvent") or {}).get("actorChargeEvents") or {}).items():
            if not isinstance(event, dict):
                continue
            price = _first(event.get("eventPriceUsd"),
                           _tiered(event.get("eventTieredPricingUsd"), "tieredEventPriceUsd"))
            if price is None:
                continue
            if name == _DEFAULT_ITEM_EVENT:
                result["per_result_usd"] = price
                result["unit"] = event.get("eventTitle") or result["unit"]
            else:
                result["events"].append({"title": event.get("eventTitle"), "price_usd": price})
    return result


def actor_pricing(actor: str, refresh: bool = False) -> dict:
    """List price for one actor, from Apify's public actor endpoint. Cached
    briefly; a failure comes back as {"actor", "error"} so one bad actor id
    doesn't hide the other rows' prices."""
    now = time.monotonic()
    with _pricing_lock:
        hit = _pricing_cache.get(actor)
    if hit and not refresh and now - hit[0] < _PRICING_TTL_SECONDS:
        return hit[1]

    headers = {"Authorization": f"Bearer {config.APIFY_API_TOKEN}"} if config.apify_configured() else {}
    path = actor.strip("/").replace("/", "~")
    try:
        response = requests.get(_ACTOR_URL.format(actor=path), headers=headers, timeout=15)
        if response.status_code == 404:
            return {"actor": actor, "error": "not_found"}
        response.raise_for_status()
        result = _normalize_pricing(actor, (response.json() or {}).get("data") or {})
    except Exception:
        return {"actor": actor, "error": "unreachable"}

    with _pricing_lock:
        _pricing_cache[actor] = (now, result)
    return result


def all_pricing(refresh: bool = False) -> dict:
    actors = sorted({getattr(config, tier["actor_key"]) for tier in TIERS if getattr(config, tier["actor_key"])})
    return {actor: actor_pricing(actor, refresh=refresh) for actor in actors}
