"""Feed discovery: given a homepage URL, find its RSS/Atom feed(s).

Thin wrapper around trafilatura.feeds.find_feed_urls - the third-party
boundary lives here so nothing outside this module needs to know which
library does the discovery, or how it's cached.
"""

from __future__ import annotations

from functools import lru_cache

from trafilatura.feeds import find_feed_urls


@lru_cache(maxsize=256)
def discover_feed_urls(url: str) -> list[str]:
    """Return discovered feed URLs for a homepage, or [] if none are found."""
    if not url:
        return []
    try:
        discovered = find_feed_urls(url)
        if isinstance(discovered, list):
            return [u.strip() for u in discovered if u and u.strip()]
    except Exception:
        pass
    return []
