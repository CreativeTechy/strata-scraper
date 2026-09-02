"""Apify-backed LinkedIn scraping tier, for `linkedin` sources.

LinkedIn requires an authenticated, JS-rendered session to view any page at
all (even a public company page) - unlike every other source type, there is
no unauthenticated HTML worth fetching with Scrapy's own downloader, so
`linkedin` sources go through Apify's hosted actors instead (see
scraper/spiders/source_rss.py's start()).

A `linkedin` source's stored URL carries its own kind (see
services/sources/sources_store.py's _derive_linkedin_url):
  - company (linkedin.com/company/<slug>) or profile (linkedin.com/in/<slug>):
    that specific account's recent posts, via APIFY_LINKEDIN_POSTS_ACTOR.
  - search (linkedin.com/search/results/content/?keywords=...): posts
    matching a keyword/hashtag query across LinkedIn, via
    APIFY_LINKEDIN_SEARCH_ACTOR.

Both default actors (harvestapi's) return dataset items in the same post
shape - confirmed live against both actors, see _article_from_post - so one
normalizer covers company, profile, and search results alike. Best-effort
throughout, same contract as gdelt.py/web_search.py: unconfigured or any
ordinary failure (bad token, actor error, timeout) returns [] rather than
raising, so one broken LinkedIn source can't take down the rest of the
crawl. The one exception is a subscription/credit problem on the configured
Apify account - see apify_common.run_actor_sync - which raises
ApifyBillingError instead, since that's worth surfacing to the user.
"""

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from app.core import settings as config
from scraper.apify_common import run_actor_sync


def linkedin_kind(url):
    """company/profile/search, inferred from a stored `linkedin` source's URL
    shape - or None if the URL doesn't match any recognized LinkedIn page."""
    path = (urlparse(url or "").path or "").rstrip("/")
    if path.startswith("/search/results/content"):
        return "search"
    if path.startswith("/company/"):
        return "company"
    if path.startswith("/in/"):
        return "profile"
    return None


def linkedin_search_query(url):
    """The `keywords` search term out of a search-kind source's stored URL."""
    return (parse_qs(urlparse(url or "").query).get("keywords") or [""])[0].strip()


def _article_from_post(post, source_url, source_name):
    if not isinstance(post, dict):
        return None
    url = (post.get("linkedinUrl") or post.get("shareLinkedinUrl") or "").strip()
    text = (post.get("content") or "").strip()
    if not url or not text:
        return None
    author = post.get("author") or {}
    author_name = (author.get("name") or "").strip()
    posted_at = (post.get("postedAt") or {}).get("date")
    return {
        "url": url,
        "source": (author.get("linkedinUrl") or "linkedin.com").strip(),
        "source_url": source_url,
        "source_name": source_name,
        "title": author_name or "LinkedIn post",
        "author": author_name or None,
        "published": posted_at,
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_posts(posts, source_url, source_name):
    return [
        article
        for article in (_article_from_post(post, source_url, source_name) for post in posts)
        if article
    ]


def apify_linkedin_page_posts(page_url, source_url, source_name):
    """Recent posts from one specific LinkedIn company or profile page.
    Raises ApifyBillingError (see apify_common) if the actor can't run for a
    subscription/credit reason - callers should surface that to the user
    rather than treating it as a silent empty result."""
    posts = run_actor_sync(
        config.APIFY_LINKEDIN_POSTS_ACTOR,
        {"targetUrls": [page_url], "maxPosts": config.APIFY_LINKEDIN_MAX_POSTS},
        actor_label="LinkedIn page posts",
        timeout=config.APIFY_LINKEDIN_POSTS_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)


def apify_linkedin_search_posts(query, source_url, source_name):
    """Posts matching a keyword/hashtag query across all of LinkedIn. Raises
    ApifyBillingError (see apify_common) if the actor can't run for a
    subscription/credit reason - callers should surface that to the user
    rather than treating it as a silent empty result."""
    posts = run_actor_sync(
        config.APIFY_LINKEDIN_SEARCH_ACTOR,
        {"searchQueries": [query], "maxPosts": config.APIFY_LINKEDIN_MAX_POSTS},
        actor_label="LinkedIn post search",
        timeout=config.APIFY_LINKEDIN_SEARCH_TIMEOUT_SECONDS,
    )
    return _articles_from_posts(posts, source_url, source_name)
