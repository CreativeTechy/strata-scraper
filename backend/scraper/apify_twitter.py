"""Apify-backed tweet-search tier, for `keyword` and `hashtag` sources.

X blocks most of its own site from being indexed and serves hashtag/search
pages as a client-rendered shell with no tweets in the raw HTML (see
scraper/spiders/source_rss.py's start()), so both source types otherwise
depend entirely on Google CSE finding a handful of tweet URLs to hydrate via
fxtwitter.com (scraper/spiders/source_rss.py's _hydrate_tweet). This tier asks
Apify's hosted tweet-search actor for tweets matching the keyword/hashtag
directly - the actor's own dataset already carries full tweet text, so no
fxtwitter hydration hop is needed. It runs alongside (not instead of) the
existing CSE tier: independent best-effort coverage, same as GDELT/CSE both
feeding "keyword" sources.

Same contract as gdelt.py/web_search.py/apify_linkedin.py throughout:
unconfigured or any ordinary failure (bad token, actor error, timeout)
returns [] rather than raising, so one broken tier can't take down the rest
of the crawl. The one exception is a subscription/credit problem on the
configured Apify account - see apify_common.run_actor_sync - which raises
ApifyBillingError instead, since that's worth surfacing to the user.
"""

from datetime import datetime, timezone

from app.core import settings as config
from scraper.apify_common import run_actor_sync


def _article_from_tweet(tweet, source_url, source_name):
    if not isinstance(tweet, dict):
        return None
    url = (tweet.get("url") or tweet.get("twitterUrl") or "").strip()
    text = (tweet.get("fullText") or tweet.get("text") or "").strip()
    if not url or not text:
        return None
    author = tweet.get("author") or {}
    handle = (author.get("userName") or author.get("username") or "").strip()
    return {
        "url": url,
        "source": f"x.com/{handle}" if handle else "x.com",
        "source_url": source_url,
        "source_name": source_name,
        "title": f"@{handle}" if handle else (author.get("name") or "Tweet"),
        "author": handle or (author.get("name") or "").strip() or None,
        "published": tweet.get("createdAt"),
        "text": text,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _articles_from_tweets(tweets, source_url, source_name):
    return [
        article
        for article in (_article_from_tweet(tweet, source_url, source_name) for tweet in tweets)
        if article
    ]


def apify_twitter_search_posts(query, source_url, source_name):
    """Tweets matching a search query (a plain keyword or a "#hashtag" term)
    across all of X, via Apify's hosted tweet-search actor. Raises
    ApifyBillingError (see apify_common) if the actor can't run for a
    subscription/credit reason - callers should surface that to the user
    rather than treating it as a silent empty result."""
    tweets = run_actor_sync(
        config.APIFY_TWITTER_SEARCH_ACTOR,
        {"searchTerms": [query], "maxItems": config.APIFY_TWITTER_MAX_TWEETS, "sort": "Latest"},
        actor_label="Twitter/X tweet search",
        timeout=config.APIFY_TWITTER_SEARCH_TIMEOUT_SECONDS,
    )
    return _articles_from_tweets(tweets, source_url, source_name)
