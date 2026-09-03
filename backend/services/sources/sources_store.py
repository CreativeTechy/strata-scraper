"""Postgres-backed source management helpers."""

from __future__ import annotations

import os
import re
from urllib.parse import parse_qs, quote_plus, urlparse

from app.core import settings as config
from app.core import db
from content_guard import TWEET_STATUS_RE
from services.projects.projects_store import set_source_projects, list_source_project_ids
from ssrf_guard import check_url_is_safe


SOURCE_SELECT = "id,url,name,enabled,source_type,limited,created_at,updated_at"

TERM_SOURCE_TYPES = {"username", "hashtag", "keyword"}

REDDIT_KINDS = {"subreddit", "user", "search"}

LINKEDIN_KINDS = {"company", "profile", "search"}

THREADS_KINDS = {"profile", "search"}

FACEBOOK_KINDS = {"page", "group", "profile", "search"}


def _default_name(url):
    if not url:
        return "Source"
    host = urlparse(url).netloc or url
    return host.removeprefix("www.")


def _derive_term_url(source_type, term):
    text = (term or "").strip()
    if not text:
        return ""
    if source_type == "username":
        handle = text.lstrip("@").split("/", 1)[0].strip()
        handle = re.sub(r"[^A-Za-z0-9_]", "", handle)
        return f"https://x.com/{handle}" if handle else ""
    if source_type == "hashtag":
        tag = text.lstrip("#").strip()
        tag = re.sub(r"[^A-Za-z0-9_]", "", tag)
        return f"https://x.com/hashtag/{tag}" if tag else ""
    if source_type == "keyword":
        # Use the RSS search endpoint, not the HTML search UI
        # (news.google.com/search). The HTML page is meant for a logged-in
        # browser and frequently serves a cookie/consent interstitial instead
        # of results when scraped, which used to get saved as a fake article
        # ("Before you continue to Google", "Personalization settings &
        # cookies" - see content_guard.py). The RSS feed returns real
        # <item><link> entries that redirect straight to the publisher
        # article, and the spider parses feed-like responses as a feed
        # regardless of source_type, so keyword sources are crawled the same
        # way as any other RSS source.
        return f"https://news.google.com/rss/search?q={quote_plus(text)}"
    return ""


def _derive_tweet_url(term):
    """Canonicalize a single tracked tweet/post - unlike hashtag/keyword/
    username above, there is no bare term to derive a URL from: the user
    supplies the actual tweet URL directly (like reddit/telegram/linkedin's
    URL field), and this just validates it's really a status link and
    normalizes it to the x.com/<handle>/status/<id> shape the spider's
    TWEET_STATUS_RE/_hydrate_tweet expect (see source_rss.py's start()).
    Returns "" for anything that isn't a recognizable tweet URL, same
    reject-don't-silently-save contract as the reddit/telegram/linkedin
    derivers."""
    match = TWEET_STATUS_RE.search((term or "").strip())
    if not match:
        return ""
    handle, tweet_id = match.groups()
    return f"https://x.com/{handle}/status/{tweet_id}"


def _derive_reddit_url(term, kind=None):
    """Turn a full reddit.com URL, a `r/`/`u/` prefixed short form, or a bare
    subreddit/username/search term into a canonical reddit.com URL.

    A bare term (no `r/`/`u/` prefix, not a URL) is ambiguous - it could be a
    subreddit, a username, or a search phrase (see the source-type
    requirements) - so `kind` (from the dashboard's Reddit-kind selector)
    disambiguates it. It only matters for bare terms; an explicit `r/...`,
    `u/.../user/...`, or full URL is unambiguous on its own and `kind` is
    ignored.
    """
    text = (term or "").strip()
    if not text:
        return ""

    if re.match(r"^https?://", text, re.I):
        parsed = urlparse(text)
        host = parsed.netloc.lower().removeprefix("www.")
        if host != "reddit.com" and not host.endswith(".reddit.com"):
            return ""
        path = (parsed.path or "").rstrip("/")
        if path.startswith("/search"):
            # Reddit's search UI appends its own tracking params (cId/iId/type/...)
            # alongside the real query - keep only `q`, don't drop the query
            # string wholesale like the subreddit/user branch below does, or
            # the search term itself (the only thing that matters) is lost.
            query_term = (parse_qs(parsed.query).get("q") or [""])[0].strip()
            return f"https://www.reddit.com/search?q={quote_plus(query_term)}" if query_term else ""
        return f"https://www.reddit.com{path}" if path else ""

    kind = (kind or "").strip().lower()
    if kind not in REDDIT_KINDS:
        kind = "subreddit"

    stripped = text.lstrip("/")
    lowered = stripped.lower()
    if lowered.startswith("r/"):
        sub = re.sub(r"[^A-Za-z0-9_]", "", stripped[2:])
        return f"https://www.reddit.com/r/{sub}" if sub else ""
    if lowered.startswith("u/"):
        handle = re.sub(r"[^A-Za-z0-9_-]", "", stripped[2:])
        return f"https://www.reddit.com/user/{handle}" if handle else ""
    if lowered.startswith("user/"):
        handle = re.sub(r"[^A-Za-z0-9_-]", "", stripped[5:])
        return f"https://www.reddit.com/user/{handle}" if handle else ""

    if kind == "user":
        handle = re.sub(r"[^A-Za-z0-9_-]", "", stripped)
        return f"https://www.reddit.com/user/{handle}" if handle else ""
    if kind == "search":
        return f"https://www.reddit.com/search?q={quote_plus(text)}"
    sub = re.sub(r"[^A-Za-z0-9_]", "", stripped)
    return f"https://www.reddit.com/r/{sub}" if sub else ""


def _derive_telegram_url(term):
    """Turn `https://t.me/channel`, `https://t.me/s/channel`, `@channel`, or
    a bare `channel` into the canonical `https://t.me/s/<channel>` preview
    URL the spider scrapes (see source_rss.py's telegram parser)."""
    text = (term or "").strip()
    if not text:
        return ""

    if re.match(r"^https?://", text, re.I):
        parsed = urlparse(text)
        host = parsed.netloc.lower().removeprefix("www.")
        if host not in {"t.me", "telegram.me"}:
            return ""
        parts = [p for p in parsed.path.split("/") if p]
        if not parts:
            return ""
        channel = parts[1] if parts[0].lower() == "s" and len(parts) > 1 else parts[0]
    else:
        channel = text.lstrip("@").strip()

    channel = re.sub(r"[^A-Za-z0-9_]", "", channel)
    return f"https://t.me/s/{channel}" if channel else ""


def _derive_linkedin_url(term, kind=None):
    """Turn a full linkedin.com URL, or a bare company/profile slug or search
    phrase, into a canonical linkedin.com URL - the same "kind disambiguates a
    bare term" contract as _derive_reddit_url above, since `apify_linkedin.py`
    reads the kind (company/profile/search) straight back off the stored
    URL's path shape (see its linkedin_kind()) rather than a separate column.
    """
    text = (term or "").strip()
    if not text:
        return ""

    if re.match(r"^https?://", text, re.I):
        parsed = urlparse(text)
        host = parsed.netloc.lower().removeprefix("www.")
        if host != "linkedin.com":
            return ""
        path = (parsed.path or "").rstrip("/")
        if path.startswith("/search/results/content"):
            query_term = (parse_qs(parsed.query).get("keywords") or [""])[0].strip()
            return f"https://www.linkedin.com/search/results/content/?keywords={quote_plus(query_term)}" if query_term else ""
        if path.startswith("/company/") or path.startswith("/in/"):
            return f"https://www.linkedin.com{path}"
        return ""

    kind = (kind or "").strip().lower()
    if kind not in LINKEDIN_KINDS:
        kind = "company"

    if kind == "search":
        return f"https://www.linkedin.com/search/results/content/?keywords={quote_plus(text)}"
    slug = re.sub(r"[^A-Za-z0-9_\-]", "", text.lstrip("/"))
    if not slug:
        return ""
    if kind == "profile":
        return f"https://www.linkedin.com/in/{slug}"
    return f"https://www.linkedin.com/company/{slug}"


def _derive_threads_url(term, kind=None):
    """Turn a full threads.com/threads.net URL, or a bare handle or search
    phrase, into a canonical threads.com URL - same "kind disambiguates a
    bare term" contract as _derive_linkedin_url above, since
    `apify_threads.py` reads the kind (profile/search) straight back off the
    stored URL's path shape (see its threads_kind()) rather than a separate
    column. threads.net is accepted as input (Meta's former domain, still
    live as a redirect) but always canonicalized to threads.com.
    """
    text = (term or "").strip()
    if not text:
        return ""

    if re.match(r"^https?://", text, re.I):
        parsed = urlparse(text)
        host = parsed.netloc.lower().removeprefix("www.")
        if host not in {"threads.com", "threads.net"}:
            return ""
        path = (parsed.path or "").rstrip("/")
        if path.startswith("/search"):
            query_term = (parse_qs(parsed.query).get("q") or [""])[0].strip()
            return f"https://www.threads.com/search?q={quote_plus(query_term)}" if query_term else ""
        if path.startswith("/@"):
            return f"https://www.threads.com{path}"
        return ""

    kind = (kind or "").strip().lower()
    if kind not in THREADS_KINDS:
        kind = "profile"

    if kind == "search":
        return f"https://www.threads.com/search?q={quote_plus(text)}"
    handle = re.sub(r"[^A-Za-z0-9_.]", "", text.lstrip("@").lstrip("/"))
    return f"https://www.threads.com/@{handle}" if handle else ""


def _derive_facebook_url(term, kind=None):
    """Turn a full facebook.com/fb.com URL, or a bare page/group/profile slug
    or search phrase, into a canonical facebook.com URL - same "kind
    disambiguates a bare term" contract as _derive_linkedin_url/
    _derive_threads_url above, since `apify_facebook.py` reads the kind
    (page/group/profile/search) straight back off the stored URL's path
    shape (see its facebook_kind()) rather than a separate column.

    Unlike LinkedIn's clean /company/ vs /in/ split, a plain facebook.com/
    <slug> vanity URL is genuinely ambiguous between a page and a personal
    profile - Facebook uses the identical shape for both. `kind="profile"`
    against a bare slug (or a full vanity URL with no other recognizable
    shape) is therefore tagged with an `fb_kind=profile` marker query param
    so facebook_kind() can recover it later; every other kind's URL shape
    (groups/<slug>, people/<name>/<id>, profile.php?id=<id>, search/top/?q=)
    is already unambiguous on its own and needs no marker.
    """
    text = (term or "").strip()
    if not text:
        return ""

    if re.match(r"^https?://", text, re.I):
        parsed = urlparse(text)
        host = parsed.netloc.lower().removeprefix("www.").removeprefix("m.")
        if host not in {"facebook.com", "fb.com"}:
            return ""
        path = (parsed.path or "").rstrip("/")
        if path.startswith("/groups/"):
            return f"https://www.facebook.com{path}"
        if path.startswith("/search"):
            query_term = (parse_qs(parsed.query).get("q") or [""])[0].strip()
            return f"https://www.facebook.com/search/top/?q={quote_plus(query_term)}" if query_term else ""
        if path == "/profile.php":
            fb_id = (parse_qs(parsed.query).get("id") or [""])[0].strip()
            return f"https://www.facebook.com/profile.php?id={fb_id}" if fb_id else ""
        if path.startswith("/people/"):
            return f"https://www.facebook.com{path}"
        if not path:
            return ""
        kind = (kind or "").strip().lower()
        return f"https://www.facebook.com{path}?fb_kind=profile" if kind == "profile" else f"https://www.facebook.com{path}"

    kind = (kind or "").strip().lower()
    if kind not in FACEBOOK_KINDS:
        kind = "page"

    if kind == "search":
        return f"https://www.facebook.com/search/top/?q={quote_plus(text)}"
    if kind == "group":
        slug = re.sub(r"[^A-Za-z0-9_.]", "", text.lstrip("/"))
        return f"https://www.facebook.com/groups/{slug}" if slug else ""
    slug = re.sub(r"[^A-Za-z0-9_.]", "", text.lstrip("@").lstrip("/"))
    if not slug:
        return ""
    if kind == "profile":
        return f"https://www.facebook.com/{slug}?fb_kind=profile"
    return f"https://www.facebook.com/{slug}"


def _normalize_record(row, include_project_ids=False):
    url = (row.get("url") or "").strip()
    name = (row.get("name") or "").strip() or _default_name(url)
    source_type = config._resolve_source_type(row.get("source_type") or "", url)
    return {
        "id": row.get("id"),
        "url": url,
        "name": name,
        "enabled": bool(row.get("enabled", True)),
        "source_type": source_type,
        "limited": bool(row.get("limited", False)),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "source": row.get("source", "database"),
        "project_ids": list_source_project_ids(row.get("id")) if include_project_ids and row.get("id") else [],
    }


def _upsert_payload(source, default_limited=True):
    if isinstance(source, str):
        source = {"url": source}
    elif not isinstance(source, dict):
        source = {}

    raw_url = source.get("url") or source.get("additionalProp1") or source.get("value") or ""
    url = str(raw_url).strip()
    name = (source.get("name") or "").strip()
    source_type_input = str(source.get("source_type") or "").strip().lower()

    if not url and source_type_input in TERM_SOURCE_TYPES and name:
        url = _derive_term_url(source_type_input, name)
    elif source_type_input == "reddit" and (url or name):
        # No `or url` fallback: an input that doesn't resolve to a real
        # reddit.com URL (wrong host, empty after stripping) must fail
        # create/update, not silently save whatever the user typed in as an
        # unusable "reddit" source - see create_source()/update_source()'s
        # `if not payload["url"]: return None`.
        reddit_kind = str(source.get("reddit_kind") or "").strip().lower()
        url = _derive_reddit_url(url or name, reddit_kind)
    elif source_type_input == "telegram" and (url or name):
        # Same reasoning as reddit above - e.g. a web.telegram.org/a/#<chat_id>
        # link (Telegram Web's internal numeric chat-ID deep link, not a
        # public @username/t.me link) must be rejected here, not saved as-is
        # only to silently scrape zero articles later.
        url = _derive_telegram_url(url or name)
    elif source_type_input == "linkedin" and (url or name):
        # Same reasoning as reddit/telegram above - a non-linkedin.com URL
        # must be rejected here, not saved as-is only to silently scrape zero
        # articles later (Apify's actors only accept linkedin.com URLs/queries).
        linkedin_kind = str(source.get("linkedin_kind") or "").strip().lower()
        url = _derive_linkedin_url(url or name, linkedin_kind)
    elif source_type_input == "threads" and (url or name):
        # Same reasoning as reddit/telegram/linkedin above - a non-threads.com
        # URL must be rejected here, not saved as-is only to silently scrape
        # zero articles later (Apify's actor only accepts a Threads handle or
        # search query).
        threads_kind = str(source.get("threads_kind") or "").strip().lower()
        url = _derive_threads_url(url or name, threads_kind)
    elif source_type_input == "facebook" and (url or name):
        # Same reasoning as reddit/telegram/linkedin/threads above - a
        # non-facebook.com URL must be rejected here, not saved as-is only to
        # silently scrape zero articles later (Apify's actors only accept a
        # Facebook page/group/profile URL or search query).
        facebook_kind = str(source.get("facebook_kind") or "").strip().lower()
        url = _derive_facebook_url(url or name, facebook_kind)
    elif source_type_input == "tweet" and (url or name):
        # Same reasoning as reddit/telegram/linkedin above - anything that
        # isn't really a tweet/status URL must be rejected here, not saved
        # as-is only to silently fail to hydrate later.
        url = _derive_tweet_url(url or name)

    source_type = config._resolve_source_type(source_type_input, url)
    return {
        "url": url,
        "name": name or _default_name(url),
        "enabled": bool(source.get("enabled", True)),
        "source_type": source_type,
        "limited": bool(source.get("limited", default_limited)),
    }


def _fetch_source_by_url(url):
    if not url or not config.DATABASE_URL:
        return None
    row = db.fetch_one(f"select {SOURCE_SELECT} from sources where url = %s limit 1", (url,))
    return _normalize_record({**row, "source": "database"}) if row else None


def _fetch_source_by_id(source_id):
    if not config.DATABASE_URL:
        return None
    row = db.fetch_one(f"select {SOURCE_SELECT} from sources where id = %s limit 1", (source_id,))
    return _normalize_record({**row, "source": "database"}) if row else None


def _fallback_records():
    return []


def list_sources_page(limit=25, offset=0):
    if not config.DATABASE_URL:
        return {"sources": _fallback_records(), "total": 0, "limit": int(limit or 0), "offset": int(offset or 0)}

    limit = max(1, min(int(limit or 25), 100))
    offset = max(0, int(offset or 0))

    try:
        rows = db.fetch_all(
            f"""
            select {SOURCE_SELECT}
            from sources
            order by created_at asc
            limit %s offset %s
            """,
            (limit, offset),
        )
        count_row = db.fetch_one("select count(*)::int as total from sources")
        sources = [_normalize_record({**row, "source": "database"}) for row in rows]
        return {
            "sources": sources,
            "total": int((count_row or {}).get("total") or len(sources)),
            "limit": limit,
            "offset": offset,
        }
    except Exception:
        return {"sources": _fallback_records(), "total": 0, "limit": limit, "offset": offset}


def bootstrap_sources():
    if not config.DATABASE_URL:
        return []
    try:
        rows = db.fetch_all(
            f"""
            select {SOURCE_SELECT}
            from sources
            order by created_at asc
            """
        )
        return [_normalize_record({**row, "source": "database"}) for row in rows]
    except Exception:
        return []


def create_source(source):
    if not config.DATABASE_URL:
        return None

    payload = _upsert_payload(source)
    project_ids = source.get("project_ids") or [] if isinstance(source, dict) else []
    if not payload["url"]:
        return None
    # Not caught by the except Exception below - an unsafe URL is a rejection,
    # not a "check your database connection" failure, and main.py surfaces it
    # to the caller as such (see UnsafeUrlError handling there).
    check_url_is_safe(payload["url"])

    try:
        row = db.fetch_one(
            f"""
            insert into sources (url, name, enabled, source_type, limited)
            values (%s, %s, %s, %s, %s)
            on conflict (url) do update set
              name = excluded.name,
              enabled = excluded.enabled,
              source_type = excluded.source_type,
              limited = excluded.limited,
              updated_at = now()
            returning {SOURCE_SELECT}
            """,
            (
                payload["url"],
                payload["name"],
                payload["enabled"],
                payload["source_type"],
                payload["limited"],
            ),
        )
        if not row:
            return None
        record = _normalize_record({**row, "source": "database"})
        if project_ids is not None:
            record["project_ids"] = set_source_projects(record["id"], project_ids)
        return record
    except Exception:
        return None


def update_source(source_id, source):
    if not config.DATABASE_URL:
        return None

    existing = _fetch_source_by_id(source_id)
    default_limited = existing["limited"] if existing else False
    payload = _upsert_payload(source, default_limited=default_limited)
    project_ids = source.get("project_ids") if isinstance(source, dict) else None
    if payload["url"]:
        check_url_is_safe(payload["url"])

    try:
        row = db.fetch_one(
            f"""
            update sources
            set url = %s,
                name = %s,
                enabled = %s,
                source_type = %s,
                limited = %s,
                updated_at = now()
            where id = %s
            returning {SOURCE_SELECT}
            """,
            (
                payload["url"],
                payload["name"],
                payload["enabled"],
                payload["source_type"],
                payload["limited"],
                source_id,
            ),
        )
        if not row:
            return None
        record = _normalize_record({**row, "source": "database"})
        if project_ids is not None:
            record["project_ids"] = set_source_projects(record["id"], project_ids)
        return record
    except Exception:
        return None


def delete_source(source_id):
    if not config.DATABASE_URL:
        return False
    try:
        db.execute("delete from sources where id = %s", (source_id,))
        return True
    except Exception:
        return False


def diagnose_source_setup():
    if not config.DATABASE_URL:
        return "DATABASE_URL is missing."

    try:
        row = db.fetch_one("select 1 as ok")
        if not row:
            return "Database request failed."
        return ""
    except Exception as e:
        return f"Database request failed: {e}"


def _normalize_source_record(row):
    # Deliberately separate from _normalize_record() above: this feeds the
    # spider (see load_source_records()), which already falls back to the
    # raw URL for an empty name at its own call site - defaulting the name
    # here too (the way _normalize_record does for the dashboard's source
    # list) would just be a second, redundant place making the same choice.
    url = (row.get("url") or "").strip()
    name = (row.get("name") or "").strip()
    source_type = config._resolve_source_type(row.get("source_type") or "", url)
    return {
        "id": row.get("id"),
        "url": url,
        "name": name,
        "enabled": bool(row.get("enabled", True)),
        "source_type": source_type,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "source": row.get("source", "database"),
    }


def load_source_records():
    """Return configured source records with source_type preserved, for the
    scraper subprocess (see scraper/spiders/source_rss.py's start()).

    Scoped to the project's assigned sources when PIPELINE_PROJECT_ID is set
    (the scraper subprocess always has this when a project was selected -
    see run_scraper_pipeline), otherwise every source in the table. Further
    narrowed to PIPELINE_SOURCE_IDS when set - the checked-sources subset the
    user picked on the workflow page for this run (see run_scraper_pipeline).
    """
    if not config.DATABASE_URL:
        return []

    project_id = os.environ.get("PIPELINE_PROJECT_ID", "").strip()
    source_ids_raw = os.environ.get("PIPELINE_SOURCE_IDS", "").strip()
    source_ids = [int(part) for part in source_ids_raw.split(",") if part.strip().isdigit()] if source_ids_raw else None

    if project_id:
        query = """
            select s.id, s.url, s.name, s.enabled, s.source_type, s.created_at, s.updated_at
            from sources s
            inner join project_sources ps on ps.source_id = s.id
            where ps.project_id = %s
        """
        params: list = [int(project_id)]
        if source_ids:
            query += " and s.id = any(%s)"
            params.append(source_ids)
        query += " order by s.created_at asc"
        records = db.fetch_all(query, params)
    else:
        query = "select id, url, name, enabled, source_type, created_at, updated_at from sources"
        params = []
        if source_ids:
            query += " where id = any(%s)"
            params.append(source_ids)
        query += " order by created_at asc"
        records = db.fetch_all(query, params)

    return [_normalize_source_record({**row, "source": "database"}) for row in records]
