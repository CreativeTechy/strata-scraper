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

from app.core import settings as config
from app.core import db

ARTICLES_SELECT = (
    "id,url,source,source_url,title,author,published,published_at,text,fetched_at,"
    "verified,story_id,pipeline_run_id,created_at"
)


# Columns whose values only mean anything inside the database that produced
# them, so the export leaves them out even though the upsert writes them:
#
#   pipeline_run_id - a foreign key into this database's `pipeline_runs`.
#     Exported, every row fails `articles_pipeline_run_id_fkey` on the
#     importing side, which has no such run - and the import reports success
#     having saved nothing. source_run_snapshot (NOT excluded below) is this
#     column's exportable twin: a denormalized {id, started_at, project_id}
#     copy set alongside it, self-contained rather than a live FK, so it is
#     the one that actually reaches the receiving app.
#
# story_id is excluded for the same reason but never reaches here: it isn't
# one of the columns the upsert writes (see store.ARTICLE_MUTABLE_FIELDS), and
# the importing side regroups by body similarity itself.
EXPORT_LOCAL_ONLY_FIELDS = {"pipeline_run_id"}


@lru_cache(maxsize=1)
def _export_select():
    """The wider column list used by the JSONL export.

    ARTICLES_SELECT is tuned for the dashboard's article cards and omits most
    of what the row can store. The upsert behind the import endpoint writes
    *every* mutable column from `excluded`, so exporting the narrow list and
    re-importing it would null those out. Selecting what the upsert writes -
    minus EXPORT_LOCAL_ONLY_FIELDS above - keeps export -> import lossless,
    which is how articles collected here reach an app that analyzes them.

    Built from the live table rather than hardcoded so a database that hasn't
    had every migration applied yet exports the columns it does have instead of
    failing the whole query on one missing name."""
    from services.articles.store import stored_article_fields

    exportable = [f for f in stored_article_fields() if f not in EXPORT_LOCAL_ONLY_FIELDS]
    fields = ["id", *exportable, "created_at"]
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
# Page size for internal readers that walk the whole result set (the export).
# Distinct from MAX_LIMIT, which caps what one *API* response may return and
# must not silently cap a bulk read: a loop that asks _fetch_articles for
# more than its ceiling gets a short page back and reads that as "no more
# rows", stopping at MAX_LIMIT. Bulk callers therefore pass
# max_limit=BULK_PAGE_SIZE so the page they ask for is the page they get.
BULK_PAGE_SIZE = 500
DEFAULT_LIMIT = 24
DEFAULT_SORT = "published.desc"


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
        # search_vector (migrations/0004_articles_search_vector.sql) is a
        # generated, GIN-indexed tsvector over title/author/source/text -
        # Postgres ranks and counts matches directly instead of the old
        # bounded in-Python scan over an ILIKE prefilter.
        clauses.append("search_vector @@ websearch_to_tsquery('english', %s)")
        params.append(term)

    if project_id is not None:
        # A correlated exists() rather than materialising every article id for
        # the project in Python and shipping it as an `id = any(%s)` array -
        # that array grows without bound with the collection (~290k ints/year
        # at 800 articles/day) and gets rebuilt on every list/stats/export
        # call. Postgres can use article_projects_project_idx /
        # project_sources_project_idx directly instead.
        clauses.append(
            "("
            "exists (select 1 from article_projects ap where ap.article_id = articles.id and ap.project_id = %s) "
            "or exists ("
            "select 1 from project_sources ps "
            "inner join sources s on s.id = ps.source_id "
            "where ps.project_id = %s and s.url = articles.source_url"
            ")"
            ")"
        )
        params.extend([project_id, project_id])

    source_url_value = _normalize_text(source_url)
    if source_url_value:
        clauses.append("lower(source_url) = %s")
        params.append(source_url_value.lower())

    date_from_value = _normalize_date_bound(date_from)
    if date_from_value:
        clauses.append("coalesce(published_at, created_at) >= %s")
        params.append(date_from_value)

    date_to_value = _normalize_date_bound(date_to)
    if date_to_value:
        clauses.append("coalesce(published_at, created_at) <= %s")
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

    # A search term always ranks by relevance - the caller's requested sort
    # doesn't apply to a keyword match the way it does to a plain listing.
    search_text = _normalize_text(search)
    if search_text:
        order_sql = "ts_rank(search_vector, websearch_to_tsquery('english', %s)) desc"
        order_params = (*params, search_text)
    else:
        field, direction = _normalize_sort(order)
        order_sql = f"{field} {direction}"
        order_params = params

    rows = db.fetch_all(
        f"""
        select {select}
        from articles
        {where_sql}
        order by {order_sql}
        limit %s offset %s
        """,
        (*order_params, limit, offset),
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


def list_articles(search=None, project_id=None, limit=DEFAULT_LIMIT, offset=0, sort=DEFAULT_SORT, source_url=None, scraped_from=None, scraped_to=None):
    limit = _normalize_limit(limit)
    offset = _normalize_offset(offset)
    field, direction = _normalize_sort(sort)
    search_text = _normalize_text(search)

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
    # _fetch_articles ranks by relevance itself whenever `search` is set,
    # ignoring the requested sort - this label just reflects that back.
    sort_label = "relevance.desc" if search_text else f"{field}.{direction}"
    return {
        "articles": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": sort_label,
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
    A search term pages through _fetch_articles exactly like the unfiltered
    case - there is no separate bounded-scan path here, so a filtered export
    can no longer silently cap out early.
    """
    select = _export_select()
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
