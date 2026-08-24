"""The SAVER stage: direct Postgres upsert helpers for collected articles."""

from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
import hashlib

import config
import db
import dedup
from services.projects.projects_store import list_project_ids_for_source_url, set_article_projects
from psycopg.types.json import Jsonb
from timestamps import parse_published
from trusted_sources import is_trusted_domain

ARTICLE_COLUMNS = (
    "url", "source", "source_url", "title", "author", "published",
    "published_at", "published_precision", "text",
    "fetched_at", "summary", "sentiment", "relevance_score", "category",
    "article_category", "writer_tone", "article_tone", "region", "gender", "age_range", "verified",
    "insight_json", "analysis_model", "analysis_prompt_version", "analyzed_at",
    "organizations", "entities", "topics", "key_points", "risks", "opportunities",
    "brands", "car_models", "embedding_json", "embedding_model", "embedding_source", "embedded_at",
    "sentiment_score", "sentiment_low_confidence", "sentiment_model",
    "category_confidence", "writer_tone_confidence", "article_tone_confidence",
    "classification_model", "extraction_model", "analysis_pipeline_version",
    "source_language", "source_language_confidence", "embedding_dimensions",
    "analysis_status", "analysis_error", "analysis_started_at", "analysis_finished_at",
    "analysis_attempt_count", "reprocess_requested_at", "content_hash",
    "pipeline_run_id",
)

LEGACY_ARTICLE_COLUMNS = (
    "url", "source", "source_url", "title", "author", "published", "text",
    "fetched_at", "summary", "sentiment", "relevance_score", "category",
    "organizations", "entities", "topics", "key_points", "risks", "opportunities",
    "brands", "car_models",
)

ARTICLE_MUTABLE_FIELDS = (
    "url",
    "source",
    "source_url",
    "title",
    "author",
    "published",
    "published_at",
    "published_precision",
    "text",
    "fetched_at",
    "summary",
    "sentiment",
    "relevance_score",
    "category",
    "article_category",
    "writer_tone",
    "article_tone",
    "region",
    "gender",
    "age_range",
    "verified",
    "insight_json",
    "analysis_model",
    "analysis_prompt_version",
    "analyzed_at",
    "organizations",
    "entities",
    "topics",
    "key_points",
    "risks",
    "opportunities",
    "brands",
    "car_models",
    "embedding_json",
    "embedding_model",
    "embedding_source",
    "embedded_at",
    "sentiment_score",
    "sentiment_low_confidence",
    "sentiment_model",
    "category_confidence",
    "writer_tone_confidence",
    "article_tone_confidence",
    "classification_model",
    "extraction_model",
    "analysis_pipeline_version",
    "source_language",
    "source_language_confidence",
    "embedding_dimensions",
    "analysis_status",
    "analysis_error",
    "analysis_started_at",
    "analysis_finished_at",
    "analysis_attempt_count",
    "reprocess_requested_at",
    "content_hash",
    "pipeline_run_id",
)
ARTICLE_JSON_FIELDS = {
    "insight_json",
    "organizations",
    "entities",
    "topics",
    "key_points",
    "risks",
    "opportunities",
    "brands",
    "car_models",
    "embedding_json",
}


def _row(article):
    row = {k: article.get(k) for k in ARTICLE_COLUMNS}
    # Single chokepoint for the parsed publish timestamp, so every save path
    # (pipeline, import, backfill) gets it without its own date handling.
    # `published` stays as the raw provenance string.
    if row.get("published_at") is None and not row.get("published_precision"):
        parsed, precision = parse_published(row.get("published"))
        row["published_at"] = parsed
        row["published_precision"] = precision
    return row


def _legacy_row(article):
    return {k: article.get(k) for k in LEGACY_ARTICLE_COLUMNS}


def _log_db_error(prefix, error):
    print(f"{prefix}: {error}")


def _jsonb_param(value):
    if value is None:
        value = []
    return Jsonb(value)


def _null_if_blank(value):
    text = str(value).strip() if value is not None else ""
    return text or None


def _content_hash(text):
    """Fingerprint of an article body, used to tell a re-scrape that changed
    something from one that returned the same page again.

    Whitespace is collapsed first so that markup reflowed between crawls - a
    different line-wrap, an extra blank line - is not reported as the
    competitor having done something.
    """
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _article_params(article):
    row = _row(article)
    return (
        row["url"],
        row["source"],
        row["source_url"],
        row["title"],
        row["author"],
        row["published"],
        row["text"],
        row["fetched_at"],
        row["summary"],
        row["sentiment"],
        row["relevance_score"],
        row["category"],
        row["article_category"],
        _jsonb_param(row["insight_json"]),
        row["analysis_model"],
        row["analysis_prompt_version"],
        row["analyzed_at"],
        _jsonb_param(row["organizations"]),
        _jsonb_param(row["entities"]),
        _jsonb_param(row["topics"]),
        _jsonb_param(row["key_points"]),
        _jsonb_param(row["risks"]),
        _jsonb_param(row["opportunities"]),
        _jsonb_param(row["brands"]),
        _jsonb_param(row["car_models"]),
        _jsonb_param(row["embedding_json"]),
        row["embedding_model"],
        row["embedding_source"],
        _null_if_blank(row["embedded_at"]),
    )


@lru_cache(maxsize=1)
def _article_table_columns():
    if not config.DATABASE_URL:
        return set()

    try:
        rows = db.fetch_all(
            """
            select column_name
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'articles'
            """
        )
    except Exception:
        return set()

    columns = set()
    for row in rows or []:
        column_name = str((row or {}).get("column_name") or "").strip()
        if column_name:
            columns.add(column_name)
    return columns


def _article_columns():
    columns = _article_table_columns()
    if columns:
        return columns
    return set(ARTICLE_MUTABLE_FIELDS)


# Fields _article_row() derives itself rather than reading off the article, so
# they are always written even when the incoming dict has no such key.
#
# `analysis_status` is here for the opposite reason to the rest: it is not
# derived from anything, it is a *safety* default. The column is `not null
# default 'success'` (it was added to a database whose rows had all been
# analyzed), and strata-media's analyze endpoints skip anything already marked
# successful. Left out of the statement, an article saved without an explicit
# status would inherit 'success' from the table default and be silently skipped
# downstream forever. Naming it always means _article_row()'s 'pending'
# fallback applies instead, so no save path can produce that outcome by
# omission - the collection paths that already call collect.mark_unanalyzed()
# pass 'pending' explicitly and are unaffected.
_ARTICLE_DERIVED_FIELDS = {
    "url",
    "published_at",
    "published_precision",
    "verified",
    "content_hash",
    "embedding_dimensions",
    "analysis_status",
}


def _article_write_fields(article=None):
    """Which columns the upsert writes.

    With no `article`, the full list this database supports - that is what the
    export has to cover (see stored_article_fields).

    For a specific article, columns it carries no value for are left out of
    the statement entirely, so the table's own DEFAULT applies instead of an
    explicit NULL. This matters because this app stores unanalyzed articles:
    several analysis columns are `not null default <neutral>`
    (sentiment_low_confidence, analysis_attempt_count, gender/age_range/
    region/segment), and naming them with a NULL value fails the not-null
    constraint rather than falling back to the default - which silently cost
    every article in a run until it was caught.

    A key that is present but falsy (`0`, `false`, `""`) is a real value and
    is still written; only missing/None is treated as "no value".
    """
    columns = _article_columns()
    fields = [field for field in ARTICLE_MUTABLE_FIELDS if field in columns]
    if article is None:
        return fields
    return [
        field for field in fields
        if field in _ARTICLE_DERIVED_FIELDS or article.get(field) is not None
    ]


def stored_article_fields():
    """The exact column list `save_articles()` can write on this database.

    Read paths that need to round-trip through the upsert (the JSONL export,
    which is re-importable) select these: the upsert sets every one of them
    from `excluded`, so anything it writes but the export omits would come
    back as NULL on re-import. Deliberately the full list rather than what
    any one article happens to carry."""
    return list(_article_write_fields())


def _article_returning_sql():
    columns = _article_columns()
    returning = ["id", "source_url"]
    if "embedding_json" in columns:
        returning.append("embedding_json")
    if "story_id" in columns:
        returning.append("story_id")
    return ", ".join(returning)


_ARTICLE_TIMESTAMP_FIELDS = {
    "fetched_at", "analyzed_at", "embedded_at",
    "analysis_started_at", "analysis_finished_at", "reprocess_requested_at",
}


def _assign_story_group(article, saved_row):
    """Group a freshly saved article with any near-identical story already stored.

    Syndication grouping is global (project_id null) rather than per project: a
    wire story is the same story whoever is watching it, and "independent
    stories in this project" is then `count(distinct story_id)` over the
    project's articles.

    Skipped when the row already carries a story_id, so re-scraping an article
    cannot inflate a group's member_count.
    """
    if "story_id" not in _article_columns():
        return None
    if not saved_row or saved_row.get("story_id") is not None:
        return saved_row.get("story_id") if saved_row else None

    article_id = saved_row.get("id")
    if article_id is None:
        return None

    row = _row(article)
    try:
        with db.transaction() as cur:
            story_id, _created = dedup.assign_story(
                cur,
                {
                    "id": article_id,
                    "title": row.get("title"),
                    "text": row.get("text"),
                    "published_at": row.get("published_at"),
                },
                project_id=None,
            )
            if story_id is not None:
                cur.execute(
                    "update articles set story_id = %s where id = %s",
                    (story_id, article_id),
                )
        return story_id
    except Exception as exc:
        # Grouping is an addition to the row, not a condition of storing it.
        _log_db_error("  story grouping skipped", exc)
        return None


def _article_row(article):
    row = _row(article)
    fields = _article_write_fields(article)
    params = []
    for field in fields:
        value = row[field]
        if field in ARTICLE_JSON_FIELDS:
            value = _jsonb_param(value)
        elif field in _ARTICLE_TIMESTAMP_FIELDS:
            value = _null_if_blank(value)
        elif field == "analysis_status":
            # not-null column. "pending" rather than "success" as the fallback:
            # this app never analyzes anything, so a row that reaches here
            # without a status has not been analyzed, and claiming success
            # would make the consumer of the export skip it (see
            # collect.py, which sets this explicitly).
            value = _null_if_blank(value) or "pending"
        elif field == "embedding_dimensions":
            embedding_json = row.get("embedding_json")
            value = len(embedding_json) if isinstance(embedding_json, list) else None
        elif field == "content_hash":
            value = _content_hash(row.get("text"))
        elif field == "verified":
            # Computed from the article's own resolved publisher URL, not
            # trusted from the caller - so a stale/absent "verified" key on
            # `article` (e.g. a row written before this field
            # existed) can never silently mark something verified.
            value = is_trusted_domain(row.get("source_url") or row.get("url"))
        params.append(value)
    return fields, tuple(params)


def _upsert_article_row(article):
    fields, params = _article_row(article)
    if not fields:
        return None
    columns_sql = ", ".join(fields)
    values_sql = ", ".join(["%s"] * len(fields))
    returning_sql = _article_returning_sql()

    updates = [f"{field} = excluded.{field}" for field in fields if field not in ("url", "pipeline_run_id")]
    if not updates:
        # An article carrying nothing but its URL would otherwise build
        # `do update set` with an empty assignment list - a syntax error.
        # A self-assignment keeps the statement valid and still RETURNINGs
        # the existing row, so the caller counts it as saved.
        updates.append("url = excluded.url")
    if "pipeline_run_id" in fields:
        # pipeline_run_id records which run *first* saved this article, not
        # whichever run touched it most recently - every run re-crawls all of
        # a project's sources, so a later run routinely re-upserts URLs an
        # earlier run already saved (an RSS feed re-listing the same recent
        # items, GDELT re-surfacing the same story, etc). Keeping the
        # existing value here is what makes "articles per run" mean anything;
        # the incoming value only fills in when there was none yet (a brand
        # new article, or a legacy pre-tracking row).
        updates.append("pipeline_run_id = coalesce(articles.pipeline_run_id, excluded.pipeline_run_id)")
    # Advanced only when the body actually differs, which is what makes
    # "this page changed" distinguishable from "we crawled this page again".
    # Every SET expression is evaluated against the pre-update row, so
    # `articles.content_hash` here is the previously stored fingerprint even
    # though the same statement is also overwriting it. New rows get their
    # value from the column default (migration 0017), not from this clause.
    if "content_hash" in fields and "content_changed_at" in _article_columns():
        updates.append(
            "content_changed_at = case"
            " when articles.content_hash is distinct from excluded.content_hash then now()"
            " else articles.content_changed_at end"
        )

    return db.fetch_one(
        """
        insert into articles ({columns})
        values ({values})
        on conflict (url) do update set
            {updates}
        returning {returning}
        """.format(
            columns=columns_sql,
            values=values_sql,
            updates=", ".join(updates),
            returning=returning_sql,
        ),
        params,
    )


def get_existing_urls(urls):
    """Which of `urls` are already stored, as a set.

    The "already scraped" check for the collect stage (see
    services/articles/collect.py). Only the url column is read - this app
    stores no analysis, so there is no per-row quality condition that could
    make an already-stored URL worth collecting again.

    A DB error returns an empty set, i.e. "assume nothing is stored": the
    worst case is re-saving rows we already had (an idempotent upsert),
    which is the safer way to fail than silently skipping fresh articles."""
    urls = [u for u in (urls or []) if u]
    if not urls or not config.DATABASE_URL:
        return set()

    try:
        rows = db.fetch_all("select url from articles where url = any(%s)", (urls,))
    except Exception as e:
        _log_db_error("  existing-url lookup error", e)
        return set()

    return {row["url"] for row in rows or []}


def _source_key(article):
    return (article.get("source_name") or article.get("source") or "unknown").strip() or "unknown"


def save_articles(articles, batch_size=50, project_id=None, run_id=None):
    """Upserts articles and returns (total_saved, saved_count_by_source).

    `project_id` additionally links every saved article to that project.
    When omitted (the subprocess pipeline's call site - collect.py never
    passes it), it falls back to the PIPELINE_PROJECT_ID env var the scrape
    subprocess sets. Callers running in-process (e.g. the JSONL import, which
    has no such env var scoped to one request) should pass it explicitly
    instead.

    Beyond that project, an article is also linked to every project that owns
    the source it came from (list_project_ids_for_source_url) - so one source
    shared by several projects feeds all of them from a single scrape.

    `run_id` tags every saved article with the pipeline run that produced it
    (so stats can be scoped to one run). Same fallback: the
    scrape subprocess's call sites never pass it, so it resolves from
    PIPELINE_RUN_ID; callers outside a scrape run leave it None, which
    `_upsert_article_row` treats as "don't touch the existing value".
    """
    if not config.DATABASE_URL:
        print("Database credentials not set, skipping upload.")
        return 0, {}

    sent = 0
    saved_by_source = defaultdict(int)
    if project_id is None:
        try:
            from os import environ

            raw_project_id = (environ.get("PIPELINE_PROJECT_ID") or "").strip()
            if raw_project_id:
                project_id = int(raw_project_id)
        except Exception:
            project_id = None

    if run_id is None:
        from os import environ

        run_id = (environ.get("PIPELINE_RUN_ID") or "").strip() or None

    source_project_cache = {}
    linked_articles = defaultdict(set)

    for i in range(0, len(articles), batch_size):
        source_batch = articles[i:i + batch_size]
        try:
            persisted = []
            for article in source_batch:
                if run_id:
                    article["pipeline_run_id"] = run_id
                row = _upsert_article_row(article)
                if row:
                    _assign_story_group(article, row)
                    persisted.append((article, row))
                    sent += 1
                    saved_by_source[_source_key(article)] += 1

            for article, row in persisted:
                if not isinstance(row, dict):
                    continue
                try:
                    article_id = int(row.get("id"))
                except Exception:
                    continue

                source_url = (row.get("source_url") or article.get("source_url") or "").strip()
                if not source_url:
                    continue
                if source_url not in source_project_cache:
                    source_project_cache[source_url] = list_project_ids_for_source_url(source_url)
                project_ids = list(source_project_cache.get(source_url) or [])
                if project_id is not None and project_id not in project_ids:
                    project_ids.append(project_id)
                for linked_project_id in project_ids:
                    linked_articles[linked_project_id].add(article_id)
            print(f"  Uploaded batch {i // batch_size + 1} ({len(source_batch)} articles)")
        except Exception as e:
            status_code = getattr(getattr(e, "response", None), "status_code", None)
            if status_code == 400:
                try:
                    legacy_batch = [_legacy_row(a) for a in source_batch]
                    persisted = []
                    for article in source_batch:
                        row = db.fetch_one(
                            """
                            insert into articles (
                                url, source, source_url, title, author, published, text,
                                fetched_at, summary, sentiment, relevance_score, category,
                                organizations, entities, topics, key_points, risks, opportunities,
                                brands, car_models
                            )
                            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            on conflict (url) do update set
                                source = excluded.source,
                                source_url = excluded.source_url,
                                title = excluded.title,
                                author = excluded.author,
                                published = excluded.published,
                                text = excluded.text,
                                fetched_at = excluded.fetched_at,
                                summary = excluded.summary,
                                sentiment = excluded.sentiment,
                                relevance_score = excluded.relevance_score,
                                category = excluded.category,
                                organizations = excluded.organizations,
                                entities = excluded.entities,
                                topics = excluded.topics,
                                key_points = excluded.key_points,
                                risks = excluded.risks,
                                opportunities = excluded.opportunities,
                                brands = excluded.brands,
                                car_models = excluded.car_models
                            returning id, source_url
                            """,
                            (
                                _legacy_row(article)["url"],
                                _legacy_row(article)["source"],
                                _legacy_row(article)["source_url"],
                                _legacy_row(article)["title"],
                                _legacy_row(article)["author"],
                                _legacy_row(article)["published"],
                                _legacy_row(article)["text"],
                                _null_if_blank(_legacy_row(article)["fetched_at"]),
                                _legacy_row(article)["summary"],
                                _legacy_row(article)["sentiment"],
                                _legacy_row(article)["relevance_score"],
                                _legacy_row(article)["category"],
                                _jsonb_param(_legacy_row(article)["organizations"]),
                                _jsonb_param(_legacy_row(article)["entities"]),
                                _jsonb_param(_legacy_row(article)["topics"]),
                                _jsonb_param(_legacy_row(article)["key_points"]),
                                _jsonb_param(_legacy_row(article)["risks"]),
                                _jsonb_param(_legacy_row(article)["opportunities"]),
                                _jsonb_param(_legacy_row(article)["brands"]),
                                _jsonb_param(_legacy_row(article)["car_models"]),
                            ),
                        )
                        if row:
                            persisted.append((article, row))
                            saved_by_source[_source_key(article)] += 1
                    sent += len(legacy_batch)
                    print(
                        f"  Uploaded batch {i // batch_size + 1} ({len(legacy_batch)} articles) using legacy article schema fallback"
                    )
                    continue
                except Exception as legacy_error:
                    _log_db_error(f"  Database upload error for batch {i // batch_size + 1}", legacy_error)
                    continue
            _log_db_error(f"  Database upload error for batch {i // batch_size + 1}", e)

    if linked_articles:
        for linked_project_id, article_ids in linked_articles.items():
            set_article_projects(sorted(article_ids), linked_project_id)

    return sent, dict(saved_by_source)


def delete_all_articles():
    if not config.DATABASE_URL:
        print("Database credentials not set, skipping article delete.")
        return 0

    try:
        db.execute("delete from articles")
        return 1
    except Exception as e:
        _log_db_error("  article delete error", e)
        return 0
