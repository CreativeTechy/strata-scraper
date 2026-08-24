"""Read helpers for the articles table.

Collection-only: rows here carry what was scraped (title, text, author,
source, publish/fetch timestamps, story group), never analysis output, so
there is nothing to roll up by sentiment/topic/tone. Search is a keyword
match over the stored text - strata-media's semantic ranking needed an
embedding per row, which this app doesn't produce.

The one deliberately wide reader is _export_select(): the JSONL export has
to round-trip through the import upsert, so it selects every column that
upsert writes - including the analysis columns this app leaves NULL - rather
than the narrow list the dashboard's article cards use.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache
import re

import config
import db
from services.projects.projects_store import list_article_ids_for_project

ARTICLES_SELECT = (
    "id,url,source,source_url,title,author,published,published_at,text,fetched_at,"
    "verified,story_id,pipeline_run_id,created_at"
)


@lru_cache(maxsize=1)
def _export_select():
    """The wider column list used by the JSONL export.

    ARTICLES_SELECT is tuned for the dashboard's article cards and omits most
    of what the row can store. The upsert behind the import endpoint writes
    *every* mutable column from `excluded`, so exporting the narrow list and
    re-importing it would null those out. Selecting exactly what the upsert
    writes keeps export -> import lossless - which is how articles collected
    here reach an app that analyzes them.

    Built from the live table rather than hardcoded so a database that hasn't
    had every migration applied yet exports the columns it does have instead of
    failing the whole query on one missing name."""
    from services.articles.store import stored_article_fields

    fields = ["id", *stored_article_fields(), "created_at"]
    seen = set()
    ordered = []
    for field in fields:
        if field not in seen:
            seen.add(field)
            ordered.append(field)
    return ",".join(ordered)


SORTABLE_COLUMNS = {
    "published",
    "created_at",
    "fetched_at",
    "title",
    "source",
}

MAX_LIMIT = 100
# Page size for internal readers that walk the whole result set (export,
# search scan). Distinct from MAX_LIMIT, which caps what one *API* response
# may return and must not silently cap a bulk read: a loop that asks
# _fetch_articles for more than its ceiling gets a short page back and reads
# that as "no more rows", stopping at MAX_LIMIT. Bulk callers therefore pass
# max_limit=BULK_PAGE_SIZE so the page they ask for is the page they get.
BULK_PAGE_SIZE = 500
DEFAULT_LIMIT = 24
DEFAULT_SORT = "published.desc"
SEARCH_SCAN_LIMIT = 1000


def _normalize_text(value: str | None) -> str:
    return (value or "").strip()


def _normalize_date_bound(value: str | None) -> str:
    """Validate a date/datetime filter bound before it reaches SQL.

    An invalid value is dropped (treated as "no bound") rather than sent to
    Postgres, so a bad query param can't blow up the request or silently
    zero out a count - it just falls back to unfiltered for that bound.
    """
    text = _normalize_text(value)
    if not text:
        return ""
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return text


def _normalize_limit(value, default=DEFAULT_LIMIT, max_limit=MAX_LIMIT):
    try:
        limit = int(value)
    except Exception:
        limit = default
    return max(1, min(limit, max_limit))


def _normalize_offset(value):
    try:
        offset = int(value)
    except Exception:
        offset = 0
    return max(0, offset)


def _normalize_sort(value: str | None):
    raw = _normalize_text(value) or DEFAULT_SORT
    direction = "desc"
    field = raw

    if raw.startswith("-"):
        field = raw[1:]
        direction = "desc"
    elif "." in raw:
        parts = raw.split(".", 1)
        field = parts[0]
        direction = parts[1] if parts[1] in {"asc", "desc"} else "desc"
    elif raw.endswith("_asc"):
        field = raw[:-4]
        direction = "asc"
    elif raw.endswith("_desc"):
        field = raw[:-5]
        direction = "desc"

    if field not in SORTABLE_COLUMNS:
        field = "published"

    return field, direction


def _where_parts(search=None, project_id=None, date_from=None, date_to=None, source_url=None, scraped_from=None, scraped_to=None):
    clauses = []
    params = []

    term = _normalize_text(search)
    if term:
        escaped = term.replace(",", " ").replace("%", "").replace("*", "")
        pattern = f"%{escaped}%"
        clauses.append(
            "("
            "title ilike %s or text ilike %s or "
            "source ilike %s or source_url ilike %s or author ilike %s"
            ")"
        )
        params.extend([pattern] * 5)

    if project_id is not None:
        article_ids = list_article_ids_for_project(project_id)
        if not article_ids:
            clauses.append("id = -1")
        else:
            clauses.append("id = any(%s)")
            params.append(article_ids)

    source_url_value = _normalize_text(source_url)
    if source_url_value:
        clauses.append("lower(source_url) = %s")
        params.append(source_url_value.lower())

    date_from_value = _normalize_date_bound(date_from)
    if date_from_value:
        clauses.append("coalesce(published, created_at) >= %s")
        params.append(date_from_value)

    date_to_value = _normalize_date_bound(date_to)
    if date_to_value:
        clauses.append("coalesce(published, created_at) <= %s")
        params.append(date_to_value)

    scraped_from_value = _normalize_date_bound(scraped_from)
    if scraped_from_value:
        clauses.append("fetched_at >= %s")
        params.append(scraped_from_value)

    scraped_to_value = _normalize_date_bound(scraped_to)
    if scraped_to_value:
        clauses.append("fetched_at <= %s")
        params.append(scraped_to_value)

    if clauses:
        return " where " + " and ".join(clauses), params
    return "", params


def _fetch_articles(limit=None, offset=None, search=None, project_id=None, order="published.desc", select=ARTICLES_SELECT, date_from=None, date_to=None, source_url=None, scraped_from=None, scraped_to=None, max_limit=MAX_LIMIT):
    if not config.DATABASE_URL:
        return [], 0

    field, direction = _normalize_sort(order)
    limit = _normalize_limit(limit, max_limit=max_limit)
    offset = _normalize_offset(offset)
    where_sql, params = _where_parts(
        search=search,
        project_id=project_id,
        date_from=date_from,
        date_to=date_to,
        source_url=source_url,
        scraped_from=scraped_from,
        scraped_to=scraped_to,
    )

    try:
        rows = db.fetch_all(
            f"""
            select {select}
            from articles
            {where_sql}
            order by {field} {direction}
            limit %s offset %s
            """,
            (*params, limit, offset),
        )
        count_row = db.fetch_one(
            f"""
            select count(*)::int as total
            from articles
            {where_sql}
            """,
            tuple(params),
        )
        total = int((count_row or {}).get("total") or len(rows))
        return rows, total
    except Exception:
        return [], 0


def _fetch_all_articles(search=None, project_id=None, *, select=ARTICLES_SELECT, order=DEFAULT_SORT, limit=SEARCH_SCAN_LIMIT, date_from=None, date_to=None, source_url=None, scraped_from=None, scraped_to=None):
    if not config.DATABASE_URL:
        return []

    rows = []
    page_size = BULK_PAGE_SIZE
    offset = 0
    limit = max(1, min(int(limit or SEARCH_SCAN_LIMIT), SEARCH_SCAN_LIMIT))

    while len(rows) < limit:
        want = min(page_size, limit - len(rows))
        batch, _ = _fetch_articles(
            limit=want,
            offset=offset,
            search=search,
            project_id=project_id,
            order=order,
            select=select,
            date_from=date_from,
            date_to=date_to,
            source_url=source_url,
            scraped_from=scraped_from,
            scraped_to=scraped_to,
            max_limit=page_size,
        )
        if not batch:
            break
        rows.extend(batch)
        # A page shorter than the one asked for is the end of the result set -
        # compare against `want`, not page_size, since the final page is
        # deliberately trimmed to the remaining budget.
        if len(batch) < want:
            break
        offset += len(batch)

    return rows[:limit]


def _article_search_blob(row: dict) -> str:
    parts = [
        row.get("title"),
        row.get("text"),
        row.get("source"),
        row.get("source_url"),
        row.get("author"),
    ]
    return " ".join(_normalize_text(value).lower() for value in parts if _normalize_text(value))


def _score_search_row(row: dict, search: str):
    """Keyword relevance for one row: what fraction of the query's words
    appear in it, with a bonus when the whole phrase does."""
    search_text = _normalize_text(search).lower()
    if not search_text:
        return 0.0, False

    blob = _article_search_blob(row)
    if not blob:
        return 0.0, False

    tokens = [token for token in re.split(r"\W+", search_text) if len(token) > 1]
    keyword_hits = sum(1 for token in tokens if token in blob)
    exact_phrase_hit = search_text in blob
    score = 0.0
    if tokens:
        score = min(1.0, keyword_hits / len(tokens))
    elif exact_phrase_hit:
        score = 1.0
    if exact_phrase_hit:
        score = min(1.0, score + 0.1)

    return score, exact_phrase_hit or keyword_hits > 0


def _rank_search_rows(rows, search: str):
    search_text = _normalize_text(search)
    if not search_text or not rows:
        return rows, []

    ranked = []
    matched_rows = []
    for index, row in enumerate(rows):
        score, matched = _score_search_row(row, search_text)
        ranked.append((score, matched, index, row))
        if matched:
            matched_rows.append(row)

    ranked_rows = [
        row
        for score, matched, index, row in sorted(ranked, key=lambda item: (-item[0], item[2]))
        if matched or score > 0
    ]
    if not ranked_rows:
        ranked_rows = [row for _, _, _, row in sorted(ranked, key=lambda item: (-item[0], item[2]))[:50]]
        matched_rows = ranked_rows
    return ranked_rows, matched_rows


def _search_results(search=None, project_id=None, date_from=None, date_to=None, source_url=None, scraped_from=None, scraped_to=None, select=ARTICLES_SELECT):
    """Rank a bounded scan (SEARCH_SCAN_LIMIT rows) by keyword relevance.

    The scan is deliberately unfiltered by `search` - the SQL ilike in
    _where_parts is a coarse prefilter that can't rank, so the scoring pass
    below is what orders the result. Anything past SEARCH_SCAN_LIMIT is not
    considered."""
    rows = _fetch_all_articles(
        project_id=project_id,
        select=select,
        order=DEFAULT_SORT,
        limit=SEARCH_SCAN_LIMIT,
        date_from=date_from,
        date_to=date_to,
        source_url=source_url,
        scraped_from=scraped_from,
        scraped_to=scraped_to,
    )
    ranked_rows, _ = _rank_search_rows(rows, search)
    return ranked_rows, len(ranked_rows)


def list_articles(search=None, project_id=None, limit=DEFAULT_LIMIT, offset=0, sort=DEFAULT_SORT, source_url=None, scraped_from=None, scraped_to=None):
    limit = _normalize_limit(limit)
    offset = _normalize_offset(offset)
    field, direction = _normalize_sort(sort)

    search_text = _normalize_text(search)
    if search_text:
        rows, total = _search_results(
            search=search_text,
            project_id=project_id,
            source_url=source_url,
            scraped_from=scraped_from,
            scraped_to=scraped_to,
        )
        rows = rows[offset:offset + limit]
        return {
            "articles": rows,
            "total": total,
            "limit": limit,
            "offset": offset,
            "sort": "relevance.desc",
        }

    rows, total = _fetch_articles(
        limit=limit,
        offset=offset,
        search=search,
        project_id=project_id,
        order=f"{field}.{direction}",
        select=ARTICLES_SELECT,
        source_url=source_url,
        scraped_from=scraped_from,
        scraped_to=scraped_to,
    )
    return {
        "articles": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": f"{field}.{direction}",
    }


def export_articles(search=None, project_id=None, sort=DEFAULT_SORT, source_url=None, scraped_from=None, scraped_to=None):
    """Yield full article rows for the JSONL export, one page at a time.

    A generator rather than a list: the export carries `text` for every row
    (see _export_select() for why it reads a wider column list than
    list_articles() does), so materializing a whole project's worth before the
    response starts is what would put a ceiling on how large a project can be
    exported. Streaming holds one page at a time and lets the client start
    receiving immediately.

    Callers that genuinely need them all at once can still wrap it in list().
    """
    select = _export_select()
    search_text = _normalize_text(search)
    if search_text:
        # The ranked path scores a bounded scan (SEARCH_SCAN_LIMIT) as a whole,
        # so this page is already materialized - stream it out as one chunk.
        rows, _ = _search_results(
            search=search_text,
            project_id=project_id,
            source_url=source_url,
            scraped_from=scraped_from,
            scraped_to=scraped_to,
            select=select,
        )
        yield from rows
        return

    page_size = BULK_PAGE_SIZE
    offset = 0
    field, direction = _normalize_sort(sort)

    while True:
        batch, _ = _fetch_articles(
            limit=page_size,
            offset=offset,
            search=search,
            project_id=project_id,
            order=f"{field}.{direction}",
            select=select,
            source_url=source_url,
            scraped_from=scraped_from,
            scraped_to=scraped_to,
            max_limit=page_size,
        )
        if not batch:
            return
        yield from batch
        if len(batch) < page_size:
            return
        offset += len(batch)


def get_article_stats(search=None, project_id=None, date_from=None, date_to=None):
    """What was collected for a scope: how many articles, from which sources,
    and over what span.

    Aggregated in SQL rather than by scanning rows into Python - there are no
    per-article judgements left to make here, only counts, so a project with
    50k articles costs the same as one with 50.
    """
    empty = {"total": 0, "sources": [], "first_scraped_at": None, "last_scraped_at": None}
    if not config.DATABASE_URL:
        return empty

    where_sql, params = _where_parts(
        search=search,
        project_id=project_id,
        date_from=date_from,
        date_to=date_to,
    )

    try:
        totals = db.fetch_one(
            f"""
            select count(*)::int as total,
                   min(fetched_at) as first_scraped_at,
                   max(fetched_at) as last_scraped_at
            from articles
            {where_sql}
            """,
            tuple(params),
        ) or {}
        sources = db.fetch_all(
            f"""
            select coalesce(nullif(source, ''), 'unknown') as source,
                   count(*)::int as count,
                   max(fetched_at) as last_scraped_at
            from articles
            {where_sql}
            group by 1
            order by count desc, source asc
            limit 50
            """,
            tuple(params),
        ) or []
    except Exception:
        return empty

    return {
        "total": int(totals.get("total") or 0),
        "first_scraped_at": totals.get("first_scraped_at"),
        "last_scraped_at": totals.get("last_scraped_at"),
        "sources": [
            {
                "source": row.get("source"),
                "count": int(row.get("count") or 0),
                "last_scraped_at": row.get("last_scraped_at"),
            }
            for row in sources
        ],
    }
