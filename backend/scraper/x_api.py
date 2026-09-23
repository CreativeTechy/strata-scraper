"""Official X API v2 recent-search adapter for hashtag sources.

Uses application-only Bearer authentication, so a dashboard user never signs
into X. The configured server account is billed by X for returned Posts. Any
ordinary HTTP/API failure returns [] so the spider can fall back to Apify.
"""

from datetime import datetime, timezone

import requests

from app.core import settings as config


def _articles_from_response(payload, source_url, source_name):
    if not isinstance(payload, dict):
        return []

    users = {
        str(user.get("id")): user
        for user in ((payload.get("includes") or {}).get("users") or [])
        if isinstance(user, dict) and user.get("id")
    }
    articles = []
    for post in payload.get("data") or []:
        if not isinstance(post, dict):
            continue
        post_id = str(post.get("id") or "").strip()
        text = (post.get("text") or "").strip()
        if not post_id or not text:
            continue
        user = users.get(str(post.get("author_id") or ""), {})
        username = (user.get("username") or "").strip()
        name = (user.get("name") or "").strip()
        # /i/status/<id> is X's account-independent status redirect and keeps
        # a stable identity even if an author expansion is unexpectedly absent.
        handle = username or "i"
        articles.append(
            {
                "url": f"https://x.com/{handle}/status/{post_id}",
                "source": f"x.com/{username}" if username else "x.com",
                "source_url": source_url,
                "source_name": source_name,
                "title": f"@{username}" if username else (name or "Tweet"),
                "author": username or name or None,
                "published": post.get("created_at"),
                "text": text,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    return articles


def x_api_recent_hashtag_posts(tag, source_url, source_name):
    """Return up to the configured number of recent Posts for one hashtag.

    X requires max_results to be between 10 and 100. This spike intentionally
    caps the request at 100 and defaults to 10, matching the product concept.
    """
    tag = (tag or "").strip().lstrip("#")
    if not config.x_api_configured() or not tag:
        return []

    try:
        response = requests.get(
            config.X_API_RECENT_SEARCH_URL,
            headers={"Authorization": f"Bearer {config.X_API_BEARER_TOKEN}"},
            params={
                "query": f"#{tag}",
                "max_results": max(10, min(int(config.X_API_HASHTAG_MAX_POSTS), 100)),
                "sort_order": "recency",
                "tweet.fields": "author_id,created_at,entities,lang",
                "expansions": "author_id",
                "user.fields": "name,username",
            },
            timeout=config.X_API_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return []

    return _articles_from_response(payload, source_url, source_name)[
        : max(1, int(config.X_API_HASHTAG_MAX_POSTS))
    ]
