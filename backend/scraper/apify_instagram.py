"""Apify-backed Instagram scraping tier, for `instagram` sources.

Like LinkedIn/Threads/Facebook (see scraper/apify_linkedin.py, scraper/
apify_threads.py, scraper/apify_facebook.py), Instagram has no
unauthenticated HTML worth fetching with Scrapy's own downloader -
instagram.com is a JS-rendered SPA that gates a profile's or hashtag page's
posts behind a logged-in session beyond the first handful - so `instagram`
sources go through Apify's hosted actor instead of the normal per-source
Scrapy request entirely (see scraper/spiders/source_rss.py's start()), same
replaces-the-seed-request treatment as `linkedin`/`threads`/`facebook`.

An `instagram` source's stored URL carries its own kind (see
services/sources/sources_store.py's _derive_instagram_url), same
URL-shape-encodes-kind pattern as the other Apify-backed platforms:
  - profile (instagram.com/<handle>): that account's recent posts.
  - hashtag (instagram.com/explore/tags/<tag>): posts tagged with it.
  - search (instagram.com/explore/search/keyword/?q=<term>): posts under the
    hashtag Instagram's own search resolves the term to. Unlike Facebook/
    Threads, Instagram has no post-content search of its own -
    apify/instagram-scraper's `search` input only resolves a term to a
    matching hashtag/user, so this is really "hashtag lookup by term" under
    the hood; the query-string URL shape is a storage-only convention (never
    fetched directly), same as the other platforms' search kind.

All three kinds go through one actor (APIFY_INSTAGRAM_ACTOR, default
apify/instagram-scraper) - profile/hashtag via its `directUrls` input,
search via its `search`/`searchType` input. The actor's exact dataset field
names are taken from its published documentation, not confirmed against a
live run (no Apify token available while writing this) - same caveat as
apify_threads.py - so _article_from_post checks a couple of likely aliases
per field.

Same contract as the other Apify tiers throughout: unconfigured or any
ordinary failure (bad token, actor error, timeout) returns [] rather than
raising, so one broken tier can't take down the rest of the crawl. The one
exception is a subscription/credit problem on the configured Apify account -
see apify_common.run_actor_sync - which raises ApifyBillingError instead,
since that's worth surfacing to the user.
"""

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from app.core import settings as config
from scraper.apify_common import run_actor_sync

# Instagram path segments that are app chrome, not a profile handle - a bare
# instagram.com/<segment> URL under one of these must not be misread as a
# profile named e.g. "explore" or "accounts".
_RESERVED_PATH_SEGMENTS = {
    "explore", "accounts", "direct", "stories", "reels", "reel", "p", "tv",
    "about", "developer", "legal", "privacy", "api", "graphql", "embed",
}


def instagram_kind(url):
    """profile/hashtag/search, inferred from a stored `instagram` source's
    URL shape - or None if the URL doesn't match any recognized Instagram
    page."""
    path = (urlparse(url or "").path or "").strip("/")
    if not path:
        return None
    if path.startswith("explore/tags/"):
        return "hashtag"
    if path.startswith("explore/search/"):
        return "search"
    segment = path.split("/", 1)[0].lower()
    if segment in _RESERVED_PATH_SEGMENTS:
        return None
    return "profile"


def instagram_search_query(url):
    """The `q` search term out of a search-kind source's stored URL."""
    return (parse_qs(urlparse(url or "").query).get("q") or [""])[0].strip()


def instagram_hashtag(url):
    """The tag out of a hashtag-kind source's stored URL."""
    path = (urlparse(url or "").path or "").strip("/")
    if not path.startswith("explore/tags/"):
        return ""
    return path[len("explore/tags/"):].split("/", 1)[0].strip()


def _post_url(post):
    url = (post.get("url") or post.get("postUrl") or post.get("displayUrl") or "").strip()
    if url:
        return url
    code = str(post.get("shortCode") or post.get("shortcode") or "").strip()
    return f"https://www.instagram.com/p/{code}/" if code else ""


def _article_from_post(post, source_url, source_name):
    if not isinstance(post, dict):
        return None
    url = _post_url(post)
    text = (post.get("caption") or post.get("text") or post.get("description") or "").strip()
    if not url or not text:
        return None
    username = (post.get("ownerUsername") or post.get("username") or post.get("ownerFullName") or "").strip()
    return {
        "url": url,
        "source": f"instagram.com/{username}" if username else "instagram.com",
        "source_url": source_url,
        "source_name": source_name,
        "title": f"@{username}" if username else "Instagram post",
        "author": username or None,
        "published": post.get("timestamp") or post.get("takenAt") or post.get("publishedAt"),
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_posts(posts, source_url, source_name):
    return [
        article
        for article in (_article_from_post(post, source_url, source_name) for post in posts)
        if article
    ]


def apify_instagram_profile_posts(profile_url, source_url, source_name):
    """Recent posts from one Instagram profile. Raises ApifyBillingError (see
    apify_common) if the actor can't run for a subscription/credit reason -
    callers should surface that to the user rather than treating it as a
    silent empty result."""
    posts = run_actor_sync(
        config.APIFY_INSTAGRAM_ACTOR,
        {
            "directUrls": [profile_url],
            "resultsType": "posts",
            "resultsLimit": config.APIFY_INSTAGRAM_MAX_POSTS,
        },
        actor_label="Instagram profile posts",
        timeout=config.APIFY_INSTAGRAM_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_instagram_hashtag_posts(hashtag_url, source_url, source_name):
    """Recent posts under one Instagram hashtag. Raises ApifyBillingError
    (see apify_common) under the same conditions as
    apify_instagram_profile_posts."""
    posts = run_actor_sync(
        config.APIFY_INSTAGRAM_ACTOR,
        {
            "directUrls": [hashtag_url],
            "resultsType": "posts",
            "resultsLimit": config.APIFY_INSTAGRAM_MAX_POSTS,
        },
        actor_label="Instagram hashtag posts",
        timeout=config.APIFY_INSTAGRAM_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_instagram_search_posts(query, source_url, source_name):
    """Posts under the hashtag Instagram's own search resolves a term to -
    Instagram has no post-content search of its own (see module docstring),
    so this is really a hashtag lookup by name rather than a keyword search
    over post text. Raises ApifyBillingError (see apify_common) under the
    same conditions as apify_instagram_profile_posts."""
    posts = run_actor_sync(
        config.APIFY_INSTAGRAM_ACTOR,
        {
            "search": query,
            "searchType": "hashtag",
            "searchLimit": 1,
            "resultsType": "posts",
            "resultsLimit": config.APIFY_INSTAGRAM_MAX_POSTS,
        },
        actor_label="Instagram search",
        timeout=config.APIFY_INSTAGRAM_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)
