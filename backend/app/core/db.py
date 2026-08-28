"""Shared Postgres helpers for the backend."""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


def get_database_url() -> str:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url:
        return url

    host = (os.environ.get("POSTGRES_HOST") or os.environ.get("DB_HOST") or "").strip()
    port = (os.environ.get("POSTGRES_PORT") or os.environ.get("DB_PORT") or "5432").strip()
    name = (os.environ.get("POSTGRES_DB") or os.environ.get("DB_NAME") or "").strip()
    user = (os.environ.get("POSTGRES_USER") or os.environ.get("DB_USER") or "").strip()
    password = (os.environ.get("POSTGRES_PASSWORD") or os.environ.get("DB_PASSWORD") or "").strip()

    if not host or not name or not user:
        return ""

    auth = f"{user}:{password}@" if password else f"{user}@"
    return f"postgresql://{auth}{host}:{port}/{name}"


def _configure(conn: psycopg.Connection) -> None:
    conn.row_factory = dict_row


_pool: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        conninfo = get_database_url()
        if not conninfo:
            raise RuntimeError("DATABASE_URL is missing.")
        _pool = ConnectionPool(
            conninfo,
            min_size=int(os.environ.get("DB_POOL_MIN_SIZE", "1")),
            max_size=int(os.environ.get("DB_POOL_MAX_SIZE", "10")),
            configure=_configure,
            open=True,
        )
    return _pool


def close_pool() -> None:
    """Close the pool so the process can shut down cleanly."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def connect():
    return _get_pool().connection()


@contextmanager
def transaction():
    with connect() as conn:
        with conn.cursor() as cur:
            yield cur


def fetch_all(query: str, params: tuple[Any, ...] | list[Any] | None = None):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            rows = cur.fetchall()
            return rows if rows else []


def fetch_one(query: str, params: tuple[Any, ...] | list[Any] | None = None):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            return cur.fetchone()


def execute(query: str, params: tuple[Any, ...] | list[Any] | None = None):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())
            try:
                row = cur.fetchone()
            except Exception:
                row = None
            return row

