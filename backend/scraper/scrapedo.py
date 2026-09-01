"""Scrape.do rendering tier for X pages a logged-out fetch can't see anything
on ("hashtag" sources, and "social"/"username" sources that are actually an
x.com/search page): renders a page with a real headless browser server-side
and returns the resulting HTML - see source_rss.py's start()/parse_social_page
and app.core.settings.SCRAPEDO_API_KEY/X_SESSION_COOKIE. Not used for profile
pages (X already server-renders a few tweet links there directly) or for
individual tweet content (fetched via fxtwitter - see _hydrate_tweet); only
the hashtag/search page fetch itself goes through this.
"""

import logging
import re
from urllib.parse import quote

from app.core import settings as config

API_URL = "https://api.scrape.do/"

# The scrape.do token (and, once a cookie is set, the full X session cookie -
# a credential granting full account access, not just read access) live in
# this URL's query string (see scrapedo_render_url). source_rss.py is
# careful to never log this URL directly, but Scrapy's OWN engine/downloader
# logging ("Crawled (200) <GET ...>" at DEBUG) logs every request/response
# URL regardless - confirmed by hand, this leaked both secrets in cleartext
# even though every self.logger call in source_rss.py was already redacted.
#
# A logging.Filter attached via getLogger().addFilter() does NOT catch this:
# a Logger's own filters only run for records logged directly through that
# exact logger, not for records from a child logger (e.g. "scrapy.core.
# engine") that merely *propagate* up to the root logger's handlers - only
# each Handler's own filters see those (confirmed by hand: the filter
# approach silently let the leak straight through). A custom LogRecordFactory
# is the one hook that runs for every record from every logger, before any
# handler or propagation logic - that's what actually closes this.
_SECRET_QS_RE = re.compile(r"([?&](?:token|setCookies)=)[^&\s'\"<>]+")

_log_redaction_installed = False


def _ensure_log_redaction_installed():
    global _log_redaction_installed
    if _log_redaction_installed:
        return
    original_factory = logging.getLogRecordFactory()

    def _redacting_factory(*args, **kwargs):
        record = original_factory(*args, **kwargs)
        try:
            rendered = record.getMessage()
        except Exception:
            return record
        if _SECRET_QS_RE.search(rendered):
            record.msg = _SECRET_QS_RE.sub(r"\1***", rendered)
            record.args = ()
        return record

    logging.setLogRecordFactory(_redacting_factory)
    _log_redaction_installed = True


_ensure_log_redaction_installed()


def scrapedo_render_url(target_url, cookies=None):
    """Return a scrape.do API URL that, fetched in place of `target_url`,
    returns that page's HTML *after* JS rendering - or None if scrape.do
    isn't configured. Scrape.do mirrors the target's own HTTP status code
    and content back through this URL, so the caller can treat the response
    exactly like a direct fetch of `target_url` that happened to be
    server-rendered.

    `cookies` (pass config.X_SESSION_COOKIE when configured - see
    source_rss.py's start()) is forwarded via scrape.do's `setCookies`
    param, which injects just that Cookie value while keeping scrape.do's
    own realistic default browser header profile intact - tried first with
    scrape.do's `customHeaders=true` flag instead (forwarding a literal
    Cookie request header), but that replaces the *entire* header set with
    whatever this app sends, and X's client bundle reliably failed to boot
    under that reduced/inconsistent fingerprint (confirmed by hand: the
    response came back with X's own `id="ScriptLoadFailure"` error
    boundary rather than real content, every time). NOTE: this embeds the
    cookie directly in this URL's query string - callers must never log
    the returned value; source_rss.py's start()/parse_source display
    response.meta["link_base_url"] instead specifically because of this."""
    target_url = (target_url or "").strip()
    if not config.scrapedo_configured() or not target_url:
        return None
    url = f"{API_URL}?token={config.SCRAPEDO_API_KEY}&url={quote(target_url, safe='')}&render=true"
    if cookies:
        url += f"&setCookies={quote(cookies, safe='')}"
    return url
