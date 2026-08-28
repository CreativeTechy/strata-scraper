"""In-memory login throttle: escalating lockout per IP and per account.

Deliberately in-process rather than Postgres, the same call as
app/core/jobs.py's JobRegistry - a login-attempt counter is not durable
state worth surviving a restart, and (per services/pipeline/pipeline.py's
SINGLE-PROCESS ONLY note) this app runs as exactly one backend process
today.

Checked *before* the password hash runs, not just before granting a session:
bcrypt is deliberately expensive, so throttling only the outcome - still
running bcrypt on every blocked attempt - would leave the CPU-exhaustion half
of "unthrottled login" vector wide open. seconds_until_allowed() is the gate
that skips the hash entirely once a bucket is over its threshold.
"""

from __future__ import annotations

import threading
import time

_LOCK = threading.Lock()
_BUCKETS: dict[str, dict] = {}

MAX_ATTEMPTS = 5
WINDOW_SECONDS = 60.0
BASE_LOCKOUT_SECONDS = 30.0
MAX_LOCKOUT_SECONDS = 15 * 60.0
# Opportunistic cleanup so a distributed attempt across many IPs/usernames
# cannot grow this dict without bound - swept whenever it gets this big,
# dropping anything that has been quiet for a while.
_MAX_BUCKETS = 10_000
_STALE_AFTER_SECONDS = 60 * 60.0


def _sweep_locked(now: float) -> None:
    if len(_BUCKETS) < _MAX_BUCKETS:
        return
    stale = [
        key
        for key, bucket in _BUCKETS.items()
        if now - bucket["last_seen"] > _STALE_AFTER_SECONDS
    ]
    for key in stale:
        _BUCKETS.pop(key, None)


def _bucket(key: str, now: float) -> dict:
    bucket = _BUCKETS.get(key)
    if bucket is None:
        _sweep_locked(now)
        bucket = {"failures": 0, "window_started": now, "locked_until": 0.0, "lockout_seconds": BASE_LOCKOUT_SECONDS}
        _BUCKETS[key] = bucket
    bucket["last_seen"] = now
    return bucket


def seconds_until_allowed(*keys: str) -> float:
    """0 if none of `keys` (e.g. an IP and a username) are locked out, else
    the longest remaining wait among them."""
    now = time.monotonic()
    wait = 0.0
    with _LOCK:
        for key in keys:
            bucket = _BUCKETS.get(key)
            if bucket and bucket["locked_until"] > now:
                wait = max(wait, bucket["locked_until"] - now)
    return wait


def record_failure(*keys: str) -> None:
    now = time.monotonic()
    with _LOCK:
        for key in keys:
            bucket = _bucket(key, now)
            if now - bucket["window_started"] > WINDOW_SECONDS:
                bucket["failures"] = 0
                bucket["window_started"] = now
            bucket["failures"] += 1
            if bucket["failures"] >= MAX_ATTEMPTS:
                bucket["locked_until"] = now + bucket["lockout_seconds"]
                # Escalating: each time a bucket trips the threshold again,
                # the next lockout is longer, up to MAX_LOCKOUT_SECONDS.
                bucket["lockout_seconds"] = min(bucket["lockout_seconds"] * 2, MAX_LOCKOUT_SECONDS)
                bucket["failures"] = 0
                bucket["window_started"] = now


def record_success(*keys: str) -> None:
    with _LOCK:
        for key in keys:
            _BUCKETS.pop(key, None)
