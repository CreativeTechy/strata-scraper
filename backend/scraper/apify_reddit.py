"""Apify-backed Reddit scraping tier, for `reddit` sources.

Reddit's public reddit.com/*.json endpoints (see scraper/social_sources.py's
reddit_fetch_url, used by scraper/spiders/source_rss.py's start()) get
rate-limited or blocked outright without REDDIT_OAUTH_CLIENT_ID/SECRET
configured. This tier asks Apify's hosted Reddit-scraper actor for the same
subreddit/user/search URL directly - independent best-effort coverage on top
of the direct-fetch tier, not a replacement for it, the same relationship
apify_twitter.py's tier has to the Google CSE tweet-link tier for hashtag
sources.

A `reddit` source's stored URL is already a canonical reddit.com subreddit
(/r/<name>), user (/user/<name>), or search (/search?q=<term>) URL (see
services/sources/sources_store.py's _derive_reddit_url) - the actor accepts
any of those shapes directly as a start URL, so one function covers all three
kinds, unlike apify_linkedin.py's split between a page-posts actor and a
separate search actor.

Same contract as gdelt.py/web_search.py/apify_linkedin.py/apify_twitter.py
throughout: unconfigured or any failure (bad token, actor error, timeout)
returns [] rather than raising, so one broken tier can't take down the rest
of the crawl.
"""

from datetime import datetime, timezone

import requests

from app.core import settings as config

_RUN_SYNC_URL = "https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"


def _run_actor(actor, payload):
    if not config.apify_configured() or not actor:
        return []
    try:
        # Apify's REST API takes an actor id as a single path segment - a
        # store slug's "username/actor-name" form (as configured via
        # APIFY_REDDIT_SEARCH_ACTOR) must have its slash swapped for "~", or
        # the extra "/" is parsed as a second path segment and 404s.
        actor_path = actor.strip("/").replace("/", "~")
        response = requests.post(
            _RUN_SYNC_URL.format(actor=actor_path),
            params={"token": config.APIFY_API_TOKEN},
            json=payload,
            timeout=config.APIFY_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        items = response.json()
        return items if isinstance(items, list) else []
    except Exception:
        return []


def _article_from_post(post, source_url, source_name):
    if not isinstance(post, dict):
        return None
    url = (post.get("url") or "").strip()
    # Posts carry a title (used as the fallback body when selftext-equivalent
    # is empty, same as social_sources.py's _reddit_post_item); comments have
    # no title at all, only body - mirrored here.
    text = (post.get("body") or post.get("title") or "").strip()
    if not url or not text:
        return None
    subreddit = (post.get("communityName") or post.get("parsedCommunityName") or "").strip().removeprefix("r/")
    username = (post.get("username") or "").strip()
    return {
        "url": url,
        "source": f"reddit.com/r/{subreddit}" if subreddit else "reddit.com",
        "source_url": source_url,
        "source_name": source_name,
        "title": post.get("title") or (f"Comment by u/{username}" if username else "Reddit post"),
        "author": username or None,
        "published": post.get("createdAt"),
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_posts(posts, source_url, source_name):
    return [
        article
        for article in (_article_from_post(post, source_url, source_name) for post in posts)
        if article
    ]


def apify_reddit_posts(reddit_url, source_url, source_name):
    """Posts (and comments, depending on the actor's own default settings)
    from one subreddit, user, or search reddit.com URL."""
    posts = _run_actor(
        config.APIFY_REDDIT_SEARCH_ACTOR,
        {"startUrls": [{"url": reddit_url}], "maxItems": config.APIFY_REDDIT_MAX_ITEMS},
    )
    return _articles_from_posts(posts, source_url, source_name)
