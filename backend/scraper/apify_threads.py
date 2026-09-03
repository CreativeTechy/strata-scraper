"""Apify-backed Threads scraping tier, for `threads` sources.

Like LinkedIn (see scraper/apify_linkedin.py), Threads has no unauthenticated
HTML worth fetching with Scrapy's own downloader: threads.com is a
JS-rendered SPA that gates most of a profile's posts behind a logged-in
session, so `threads` sources go through Apify's hosted actor instead of the
normal per-source Scrapy request entirely (see
scraper/spiders/source_rss.py's start()) - same replaces-the-seed-request
treatment as `linkedin`, not the run-alongside treatment `keyword`/`hashtag`/
`reddit` give their own Apify tiers.

A `threads` source's stored URL carries its own kind (see
services/sources/sources_store.py's _derive_threads_url), same
URL-shape-encodes-kind pattern as `linkedin`/`reddit`:
  - profile (threads.com/@<handle>): that account's recent posts.
  - search (threads.com/search?q=<term>): posts matching a search query.

Both go through the same actor (APIFY_THREADS_ACTOR) in its "posts" or
"search" mode - see apify_threads_profile_posts/apify_threads_search_posts.
The actor's exact dataset field names are taken from its published
documentation, not confirmed against a live run (no Apify token available
while writing this) - _article_from_post therefore checks a couple of likely
aliases per field, same defensive-normalization style as apify_twitter.py's
url/twitterUrl and apify_linkedin.py's linkedinUrl/shareLinkedinUrl fallbacks,
and falls back to building the post URL from username+code when the dataset
carries no direct URL field.

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


def threads_kind(url):
    """profile/search, inferred from a stored `threads` source's URL shape -
    or None if the URL doesn't match either recognized Threads page."""
    path = (urlparse(url or "").path or "").rstrip("/")
    if path.startswith("/search"):
        return "search"
    if path.startswith("/@"):
        return "profile"
    return None


def threads_search_query(url):
    """The `q` search term out of a search-kind source's stored URL."""
    return (parse_qs(urlparse(url or "").query).get("q") or [""])[0].strip()


def _post_url(post, username):
    url = (post.get("url") or post.get("postUrl") or post.get("threadUrl") or post.get("permalink") or "").strip()
    if url:
        return url
    code = str(post.get("code") or post.get("postId") or "").strip()
    if code and username:
        return f"https://www.threads.com/@{username}/post/{code}"
    return ""


def _article_from_post(post, source_url, source_name):
    if not isinstance(post, dict):
        return None
    author = post.get("author") if isinstance(post.get("author"), dict) else {}
    username = (post.get("username") or author.get("username") or "").strip()
    url = _post_url(post, username)
    text = (post.get("text") or post.get("caption") or "").strip()
    if not url or not text:
        return None
    full_name = (post.get("fullName") or author.get("fullName") or "").strip()
    return {
        "url": url,
        "source": f"threads.com/@{username}" if username else "threads.com",
        "source_url": source_url,
        "source_name": source_name,
        "title": f"@{username}" if username else (full_name or "Threads post"),
        "author": username or full_name or None,
        "published": post.get("timestamp") or post.get("publishedAt") or post.get("takenAt"),
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_posts(posts, source_url, source_name):
    return [
        article
        for article in (_article_from_post(post, source_url, source_name) for post in posts)
        if article
    ]


def apify_threads_profile_posts(username, source_url, source_name):
    """Recent posts from one Threads profile. Raises ApifyBillingError (see
    apify_common) if the actor can't run for a subscription/credit reason -
    callers should surface that to the user rather than treating it as a
    silent empty result."""
    posts = run_actor_sync(
        config.APIFY_THREADS_ACTOR,
        {"mode": "posts", "usernames": [username], "maxPosts": config.APIFY_THREADS_MAX_POSTS},
        actor_label="Threads profile posts",
        timeout=config.APIFY_THREADS_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_threads_search_posts(query, source_url, source_name):
    """Posts matching a search query across all of Threads. Raises
    ApifyBillingError (see apify_common) if the actor can't run for a
    subscription/credit reason - callers should surface that to the user
    rather than treating it as a silent empty result."""
    posts = run_actor_sync(
        config.APIFY_THREADS_ACTOR,
        {"mode": "search", "searchQueries": [query], "maxPosts": config.APIFY_THREADS_MAX_POSTS},
        actor_label="Threads search",
        timeout=config.APIFY_THREADS_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)
