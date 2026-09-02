"""Per-configured-source fetch diagnostics: read the side-channel file
scraper/spiders/source_rss.py writes on spider close, and turn it into
plain-language notes.

Kept separate from pipeline_runs.py (DB access) and pipeline.py (subprocess
orchestration) so this is a small set of pure functions - no DB, no
subprocess, easy to unit test and reused by both collect.py (per-source rows)
and pipeline.py (the run's top-level message).
"""

import json
import re
from pathlib import Path

DIAGNOSTICS_FILENAME = "source_diagnostics.json"
MAX_TECHNICAL_DETAIL_LENGTH = 600


def _clean_technical_detail(value):
    """Keep diagnostics useful without sending response headers or HTML
    previews to the UI. Those can be extremely long and are rarely actionable
    for an operator."""
    text = " ".join(str(value or "").split())
    text = re.split(r"\s+(?:Headers|Body preview):", text, maxsplit=1, flags=re.IGNORECASE)[0]
    if len(text) > MAX_TECHNICAL_DETAIL_LENGTH:
        return f"{text[:MAX_TECHNICAL_DETAIL_LENGTH - 1].rstrip()}…"
    return text


def classify_fetch_issue(fetch_note, *, http_status=None, network_blocked=False, source_type=None):
    """Convert a low-level fetch note into stable, user-facing issue data.

    The original note remains available as a short technical detail, while
    callers can consistently render a title, explanation, and next action.
    Unknown errors deliberately fall back to a neutral message rather than
    leaking exception text into the main interface.
    """
    detail = _clean_technical_detail(fetch_note)
    text = detail.lower()
    source_type = str(source_type or "").strip().lower()
    is_x = source_type in {"hashtag", "username", "tweet", "twitter", "x"}

    def issue(code, title, message, action, severity="error"):
        return {
            "code": code,
            "title": title,
            "message": message,
            "action": action,
            "severity": severity,
            "technical_detail": detail,
        }

    if not detail and not http_status and not network_blocked:
        return None

    if "apify_api_token not set" in text or "requires apify" in text:
        platform = "LinkedIn" if source_type == "linkedin" or "linkedin" in text else "this source"
        return issue(
            "setup_required",
            f"{platform} setup required" if platform != "this source" else "Additional setup required",
            f"{platform} cannot be collected until its scraping integration is configured." if platform != "this source" else "This source needs an external scraping integration.",
            "Ask an administrator to configure the Apify API token, then run the pipeline again.",
            "warning",
        )
    if "google_cse_api_key" in text or "google_cse_engine_id" in text:
        return issue(
            "setup_required",
            "X search setup required" if is_x or "hashtag" in text else "Search setup required",
            "This source needs a search integration to discover public posts.",
            "Configure Google Custom Search or Apify, then run the pipeline again.",
            "warning",
        )
    if any(value in text for value in ("unrecognized", "invalid url", "malformed url", "unsupported url")):
        return issue(
            "invalid_source",
            "Invalid source",
            "The source address or type is not recognized.",
            "Check the source format and update it before the next run.",
        )
    if int(http_status or 0) == 404 or "http 404" in text:
        return issue(
            "not_found",
            "X account not found" if source_type == "username" else "Source not found",
            "The account or page does not exist, was renamed, or is no longer public.",
            "Check the spelling or URL, then update or remove this source.",
        )
    if int(http_status or 0) == 429 or "rate limit" in text or "too many requests" in text:
        return issue(
            "rate_limited",
            "Temporarily rate limited",
            "The platform temporarily limited collection requests.",
            "Wait a while and run the pipeline again.",
            "warning",
        )
    if network_blocked or int(http_status or 0) == 403 or "blocked" in text or "forbidden" in text:
        return issue(
            "access_blocked",
            "Access blocked",
            "The platform rejected requests from the scraper's current network.",
            "Try authenticated access or a scraping proxy, then run the pipeline again.",
        )
    if int(http_status or 0) in {401, 407} or "unauthorized" in text or "authentication failed" in text:
        return issue(
            "authentication_failed",
            "Authentication required",
            "The configured credentials were missing, rejected, or expired.",
            "Check the integration credentials and run the pipeline again.",
        )
    if int(http_status or 0) >= 500:
        return issue(
            "service_unavailable",
            "Platform temporarily unavailable",
            "The source platform returned a server error.",
            "Try the source again later.",
            "warning",
        )
    if any(value in text for value in ("timeout", "timed out", "deadline exceeded")):
        return issue(
            "timed_out",
            "Request timed out",
            "The source did not respond within the allowed time.",
            "Try again; if it continues, review the network or timeout configuration.",
            "warning",
        )
    if any(value in text for value in ("dns", "name resolution", "connection refused", "connection failed", "unreachable", "ssl", "tls")):
        return issue(
            "connection_failed",
            "Connection failed",
            "The scraper could not establish a reliable connection to this source.",
            "Check the URL and network connection, then try again.",
            "warning",
        )
    if any(value in text for value in ("deleted", "private", "protected", "banned", "quarantined")):
        return issue(
            "source_unavailable",
            "Source unavailable",
            "The source is private, protected, deleted, or otherwise unavailable.",
            "Confirm that the source is public or remove it from the project.",
        )
    if "returned 0 articles" in text or "0 articles" in text:
        return issue(
            "no_results",
            "No articles found",
            "The source was reached successfully but produced no usable articles in this run.",
            "Check the project date window and source activity before trying again.",
            "warning",
        )
    if http_status:
        return issue(
            "http_error",
            "Source could not be fetched",
            f"The source returned HTTP {http_status} and could not be collected.",
            "Try again later or review the source configuration.",
        )
    return issue(
        "fetch_failed",
        "Source could not be collected",
        "An unexpected problem prevented this source from being collected.",
        "Try again; if it continues, review the technical details.",
        "warning",
    )


def load_source_diagnostics(workdir):
    """Read the list of per-source diagnostic entries the spider wrote, keyed
    by source_name: {source_name, source_url, http_status, network_blocked,
    note}. Missing/unreadable/empty is the common, expected case (nothing
    went wrong) - not an error, just an empty list."""
    if not workdir:
        return []
    path = Path(workdir) / DIAGNOSTICS_FILENAME
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def build_fetch_note(diagnostic, scraped_count):
    """Plain-language note for one source's row in the per-source breakdown.

    Priority: a network-level block or HTTP error is the most actionable
    thing to tell the user, then any other note the spider recorded (e.g. a
    connection failure, or a private/missing Telegram channel), then falling
    back to "0 articles" when the fetch itself didn't error but nothing came
    of it (e.g. a legitimately empty subreddit). "" for a healthy source."""
    diagnostic = diagnostic or {}
    if diagnostic.get("network_blocked"):
        base = (
            f"Blocked (HTTP {diagnostic.get('http_status')}) - likely anti-bot protection "
            "against this server's network, not a problem with the source itself."
        )
        detail = diagnostic.get("note")
        return f"{base} {detail}" if detail else base
    if diagnostic.get("http_status"):
        base = f"HTTP {diagnostic['http_status']} - the source's page could not be fetched."
        detail = diagnostic.get("note")
        return f"{base} {detail}" if detail else base
    if diagnostic.get("note"):
        return diagnostic["note"]
    if not scraped_count:
        return "Returned 0 articles."
    return ""


def summarize_notable_diagnostics(diagnostics):
    """Short addendum for the pipeline run's top-level message - only
    sources with a network-level issue (this runs before collect.py, so it
    can't yet know which sources ended up with 0 articles - see
    build_fetch_note for the fuller per-source picture). "" if nothing to
    report."""
    notable = [d for d in (diagnostics or []) if d.get("http_status") or d.get("note")]
    if not notable:
        return ""
    parts = []
    for entry in notable:
        label = entry.get("source_name") or entry.get("source_url") or "unknown source"
        classified = classify_fetch_issue(
            entry.get("note"),
            http_status=entry.get("http_status"),
            network_blocked=entry.get("network_blocked"),
        )
        parts.append(f"{label} ({classified['title'] if classified else 'Fetch issue'})")
    return f"{len(parts)} source(s) had fetch issues: " + "; ".join(parts) + "."
