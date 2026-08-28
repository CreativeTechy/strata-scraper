"""Downloader middlewares for the scraper project."""

from __future__ import annotations

from scrapy.exceptions import IgnoreRequest

from ssrf_guard import UnsafeUrlError, check_url_is_safe


class SsrfProtectionMiddleware:
    """Reject any crawl-time fetch aimed at a private/loopback/link-local
    address, checked again right before the request goes out.

    A source URL is already validated when it's created (see
    services/sources/sources_store.py), but DNS can change between then and
    crawl time, and requests also originate from links the crawler discovers
    on the page itself (feed items, redirects) that were never validated at
    all. Fetching arbitrary URLs is this app's whole job, so this check - not
    "don't fetch untrusted URLs" - is the actual control.
    """

    def process_request(self, request, spider):
        try:
            check_url_is_safe(request.url)
        except UnsafeUrlError as exc:
            spider.logger.warning("Blocked unsafe fetch target %s: %s", request.url, exc)
            raise IgnoreRequest(str(exc)) from exc
        return None
