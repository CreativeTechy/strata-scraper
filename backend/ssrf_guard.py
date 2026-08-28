"""Reject fetches aimed at private, loopback, link-local, or otherwise
non-public network destinations.

Fetching a user-supplied URL *is* the product here (source creation,
discovery, the crawler itself), so "do not fetch untrusted URLs" is not an
available mitigation - this check is the actual control. It is meant to run
at two points, because DNS can change between them: once when a URL is
accepted (source creation, discovery's lightweight fetch), and again
immediately before each crawl-time fetch (see scraper/middlewares.py).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}


class UnsafeUrlError(ValueError):
    """A URL's scheme or resolved address must not be fetched."""


def _is_unsafe_address(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def check_url_is_safe(url: str) -> None:
    """Raise UnsafeUrlError if `url` must not be fetched.

    Every address a hostname resolves to is checked, not just the first -
    a host that round-robins between a public and a private/internal address
    is rejected outright rather than let through on the public one.
    """
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise UnsafeUrlError(f"URL scheme {parsed.scheme!r} is not allowed - only http/https are.")

    host = parsed.hostname
    if not host:
        raise UnsafeUrlError("URL has no host.")

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"Could not resolve host {host!r}: {exc}") from None

    for info in infos:
        ip = info[4][0]
        if _is_unsafe_address(ip):
            raise UnsafeUrlError(f"{host!r} resolves to a non-public address ({ip}) - refusing to fetch.")


def is_url_safe(url: str) -> bool:
    try:
        check_url_is_safe(url)
        return True
    except UnsafeUrlError:
        return False
