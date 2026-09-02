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
services/sources/sources_store.py's _derive_reddit_url). Only the first two
are valid `startUrls` entries for the actor - confirmed live, a search URL
there fails the run outright with statusMessage "Invalid input." (silently
swallowed as an ordinary empty result by apify_common.run_actor_sync, same
as any other non-billing failure). A search-kind URL's `q` term is pulled
out and sent through the actor's own `searches` field instead, so one
function still covers all three kinds - unlike apify_linkedin.py's split
between a page-posts actor and a separate search actor.

Same contract as gdelt.py/web_search.py/apify_linkedin.py/apify_twitter.py
throughout: unconfigured or any ordinary failure (bad token, actor error,
timeout) returns [] rather than raising, so one broken tier can't take down
the rest of the crawl. The one exception is a subscription/credit problem on
the configured Apify account - see apify_common.run_actor_sync - which
raises ApifyBillingError instead, since that's worth surfacing to the user.
"""

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from app.core import settings as config
from scraper.apify_common import run_actor_sync


def _search_query(reddit_url):
    """The `q` term out of a search-kind source's stored reddit.com/search
    URL, or None if this isn't a search URL - see _derive_reddit_url."""
    path = (urlparse(reddit_url or "").path or "").rstrip("/")
    if path != "/search":
        return None
    return (parse_qs(urlparse(reddit_url).query).get("q") or [""])[0].strip() or None


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
    from one subreddit, user, or search reddit.com URL. Raises
    ApifyBillingError (see apify_common) if the actor can't run for a
    subscription/credit reason - callers should surface that to the user
    rather than treating it as a silent empty result."""
    query = _search_query(reddit_url)
    payload = (
        {"searches": [query]}
        if query
        else {"startUrls": [{"url": reddit_url}]}
    )
    payload["maxItems"] = config.APIFY_REDDIT_MAX_ITEMS
    posts = run_actor_sync(
        config.APIFY_REDDIT_SEARCH_ACTOR,
        payload,
        actor_label="Reddit search",
        timeout=config.APIFY_REDDIT_SEARCH_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)
