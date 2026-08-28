"""The COLLECT stage: validate scraped articles, drop the ones that don't
belong, and hand the rest to the saver (store.save_articles).

This app collects only - there is no AI enrichment stage. An article that
survives this module is stored with no analysis on it and
analysis_status='pending' (see mark_unanalyzed), for strata-media (or
whatever else consumes the JSONL export) to analyze later.
The four checks an article has to pass are all here:

  1. validation - long enough, has a title, isn't a consent/search/error
     page (clean_articles, with content_guard.py doing the URL/title test)
  2. duplicate  - same URL already seen earlier in this run (clean_articles'
     `seen_urls`); near-identical bodies are additionally grouped into a
     story_group at save time, see dedup.py
  3. date window - published outside the project's start/end dates
     (_article_matches_project_window)
  4. already scraped - this URL is already stored from an earlier run
     (get_existing_urls, gated on config.SKIP_EXISTING_URLS)

Each check has its own per-source counter so the dashboard can show *why*
a source yielded fewer rows than it scraped, rather than one opaque number
(see _persist_source_stats -> pipeline_run_sources).

main() below is the manual/offline entry point: it reads a raw-scrape JSON
file produced by `scrapy crawl source_rss -O articles.json` and runs the
whole batch through those checks in one pass. Backend-triggered runs don't
use it - scraper/pipelines.py's StreamingCollectPipeline calls the same
functions per-article from inside the live crawl instead, so results appear
source by source while the crawl is still going.
"""

import json
import os
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from app.core import settings as config
from content_guard import is_blocked_article, is_tweet_url
from services.projects.projects_store import get_project
from services.pipeline.pipeline_runs import update_pipeline_run, upsert_pipeline_run_source_stats
from services.pipeline.source_diagnostics import build_fetch_note, load_source_diagnostics
from services.articles.store import get_existing_urls, save_articles

MIN_TEXT_LENGTH = 200
PIPELINE_RUN_ID = os.environ.get("PIPELINE_RUN_ID", "").strip()
PIPELINE_PROJECT_ID = os.environ.get("PIPELINE_PROJECT_ID", "").strip()
PIPELINE_WORKDIR = os.environ.get("PIPELINE_WORKDIR", "").strip()
INPUT_FILE = Path(os.environ.get("PIPELINE_RAW_FILE", "articles.json"))
OUTPUT_FILE = Path(os.environ.get("PIPELINE_COLLECTED_FILE", "collected_articles.json"))
PIPELINE_STATS_FILE = Path(os.environ.get("PIPELINE_STATS_FILE", "")) if os.environ.get("PIPELINE_STATS_FILE") else None


def _load_project():
    if not PIPELINE_PROJECT_ID:
        return None
    try:
        return get_project(int(PIPELINE_PROJECT_ID))
    except Exception:
        return None


def _coerce_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value

    text = str(value).strip()
    if not text:
        return None

    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"

    try:
        return datetime.fromisoformat(text).date()
    except Exception:
        pass

    try:
        return parsedate_to_datetime(text).date()
    except Exception:
        pass

    try:
        return date.fromisoformat(text[:10])
    except Exception:
        return None


def _article_published_date(article):
    if not isinstance(article, dict):
        return None

    for key in ("published_at", "published"):
        published = _coerce_date(article.get(key))
        if published:
            return published
    return None


def _project_date_window(project):
    if not isinstance(project, dict):
        return None, None
    return _coerce_date(project.get("start_date")), _coerce_date(project.get("end_date"))


def _article_matches_project_window(article, project):
    article_date = _article_published_date(article)
    if article_date is None:
        return True

    start_date, end_date = _project_date_window(project)
    if start_date and article_date < start_date:
        return False
    if end_date and article_date > end_date:
        return False
    return True


def _source_key(article):
    return (article.get("source_name") or article.get("source") or "unknown").strip() or "unknown"


# Stamped on every article this app stores. The articles table defaults
# analysis_status to 'success' (it was added to a database whose rows had all
# been analyzed), which would be a lie here and an actively harmful one: the
# app that imports these exports skips re-analyzing anything already marked
# successful, so a whole collection run would silently never be analyzed.
# 'pending' is part of the same accepted set and says what is true.
UNANALYZED_STATUS = "pending"


def mark_unanalyzed(article):
    """Return `article` with the status the export has to carry.

    Set here rather than left to the column default so the intent is visible
    at the stage that decides it - store.py keeps a matching fallback for any
    other caller."""
    return {**article, "analysis_status": UNANALYZED_STATUS}


def _already_stored(article, existing_urls):
    """True when this URL is already in the articles table from an earlier
    run, so there is nothing to collect for it again.

    Deliberately a plain URL-existence test: with no analysis stage there is
    no notion of a row being stored but under-processed, so "already
    scraped" means exactly "already have it". Re-saving would only bump
    fetched_at and re-run the story-group lookup for a row whose text we
    already hold."""
    if not existing_urls:
        return False
    return article.get("url") in existing_urls


def _set_run_timestamps(**fields):
    if not PIPELINE_RUN_ID:
        return
    try:
        update_pipeline_run(PIPELINE_RUN_ID, **fields)
    except Exception as e:
        print(f"Pipeline timestamp update failed: {e}")


def _persist_source_stats(scraped, removed, date_filtered, skipped_existing, kept, saved):
    if not PIPELINE_RUN_ID:
        return

    # Fetch-time diagnostics the spider recorded per configured source (was it
    # blocked/404/DNS-failed, or did it just return nothing) - see
    # scraper/spiders/source_rss.py's closed() and source_diagnostics.py.
    # Included in `sources` below so a source with 0 scraped items (which
    # never appears in scraped/removed/date_filtered/kept/saved) still gets a
    # row instead of silently having no per-source data at all.
    diagnostics_by_source = {
        entry.get("source_name"): entry
        for entry in load_source_diagnostics(PIPELINE_WORKDIR)
        if entry.get("source_name")
    }

    sources = (
        set(scraped) | set(removed) | set(date_filtered) | set(skipped_existing)
        | set(kept) | set(saved) | set(diagnostics_by_source)
    )
    source_stats = {}
    for source in sources:
        removed_counts = removed.get(source) or {}
        scraped_count = scraped.get(source, 0)
        diagnostic = diagnostics_by_source.get(source)
        source_stats[source] = {
            "source_url": (diagnostic or {}).get("source_url"),
            "scraped": scraped_count,
            "duplicate": removed_counts.get("duplicate", 0),
            "blocked": removed_counts.get("blocked", 0),
            "date_filtered": date_filtered.get(source, 0),
            "skipped_existing": skipped_existing.get(source, 0),
            "kept": kept.get(source, 0),
            "saved": saved.get(source, 0),
            "http_status": (diagnostic or {}).get("http_status"),
            "network_blocked": bool((diagnostic or {}).get("network_blocked")),
            "fetch_note": build_fetch_note(diagnostic, scraped_count),
        }
    upsert_pipeline_run_source_stats(PIPELINE_RUN_ID, source_stats)


def clean_articles(articles, seen_urls=None):
    """Returns (cleaned_articles, removed_counts_by_source), the latter tallying
    why an article didn't make it past dedup/quality filtering (see
    pipeline_run_sources - "duplicate" and "blocked" buckets).

    `seen_urls` defaults to a fresh set (this call's own batch only, the
    original behavior). Pass a set you own across repeated single-article
    calls - see scraper/pipelines.py's streaming pipeline - to dedup across
    the whole run instead of just within one call's batch."""
    if seen_urls is None:
        seen_urls = set()
    cleaned = []
    removed_by_source = defaultdict(lambda: {"duplicate": 0, "blocked": 0})
    for a in articles:
        source = _source_key(a)
        url = a.get("url", "")
        text = a.get("text", "")
        if url in seen_urls:
            removed_by_source[source]["duplicate"] += 1
            continue
        # Secondary safeguard: the scraper already rejects Google consent/search
        # pages (see content_guard.py), but this also catches rows coming from
        # an articles.json produced before that guard existed.
        # Tweets are exempt from the length floor - a short reply or one-line
        # take is normal for a tweet, not a stub (_hydrate_tweet in
        # source_rss.py already guarantees non-empty text for these).
        min_length = 0 if is_tweet_url(url) else MIN_TEXT_LENGTH
        if len(text) < min_length or not a.get("title") or is_blocked_article(url, a.get("title")):
            removed_by_source[source]["blocked"] += 1
            continue
        seen_urls.add(url)
        cleaned.append(a)
    print(f"Cleaned: {len(articles)} -> {len(cleaned)} articles")
    return cleaned, removed_by_source


def write_output(articles):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(articles, f, ensure_ascii=False, indent=2)
    print(f"Wrote {len(articles)} articles to {OUTPUT_FILE}")


def write_pipeline_stats(stats):
    if not PIPELINE_STATS_FILE:
        return
    PIPELINE_STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PIPELINE_STATS_FILE, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(f"Wrote pipeline stats to {PIPELINE_STATS_FILE.name}")


def push_run_progress(stats, stage, message, final=False):
    if not PIPELINE_RUN_ID:
        return
    try:
        update_pipeline_run(
            PIPELINE_RUN_ID,
            status="success" if final else "running",
            stage=stage,
            message=message,
            articles_scraped=int(stats.get("articles_scraped") or 0),
            articles_cleaned=int(stats.get("articles_cleaned") or 0),
            articles_saved=int(stats.get("articles_saved") or 0),
        )
    except Exception as e:
        print(f"Pipeline progress update failed: {e}")


def main():
    clean_started_at = datetime.now(timezone.utc).isoformat()
    _set_run_timestamps(clean_started_at=clean_started_at)

    print(f"Loading articles from {INPUT_FILE}...")
    with open(INPUT_FILE, "r", encoding="utf-8") as f:
        raw_articles = json.load(f)

    scraped_by_source = Counter(_source_key(article) for article in raw_articles)
    articles, removed_by_source = clean_articles(raw_articles)
    stats = {
        "articles_scraped": len(raw_articles),
        "articles_cleaned": len(articles),
        "articles_saved": 0,
    }

    push_run_progress(
        stats,
        stage="clean",
        message="Scrape complete. Validating articles...",
    )

    if not articles:
        print("No articles to process after cleaning.")
        write_output([])
        write_pipeline_stats(stats)
        _set_run_timestamps(clean_finished_at=datetime.now(timezone.utc).isoformat())
        _persist_source_stats(scraped_by_source, removed_by_source, {}, {}, {}, {})
        push_run_progress(
            stats,
            stage="done",
            message="No articles left after cleaning.",
            final=True,
        )
        return

    project = _load_project()

    date_filtered_by_source = Counter()
    if project:
        matching_articles = []
        for article in articles:
            if _article_matches_project_window(article, project):
                matching_articles.append(article)
            else:
                date_filtered_by_source[_source_key(article)] += 1
    else:
        matching_articles = articles

    filtered_out = len(articles) - len(matching_articles)
    if filtered_out:
        print(f"Filtered out {filtered_out} articles outside the project date window.")
    articles = matching_articles

    # "kept" is everything that passed validation and the date window,
    # counted before the already-scraped check below - so it stays the same
    # number whether or not a URL happened to be stored by an earlier run,
    # and skipped_existing is the separate breakdown of how many of those
    # needed no save. Same order as the streaming pipeline's counters
    # (scraper/pipelines.py), so both entry points report identically.
    kept_by_source = Counter(_source_key(article) for article in articles)
    stats["articles_cleaned"] = len(articles)

    existing_urls = (
        get_existing_urls([a.get("url") for a in articles]) if config.SKIP_EXISTING_URLS else set()
    )
    skipped_existing_by_source = Counter()
    fresh_articles = []
    for article in articles:
        if _already_stored(article, existing_urls):
            skipped_existing_by_source[_source_key(article)] += 1
            continue
        fresh_articles.append(article)

    if skipped_existing_by_source:
        print(f"Skipped {sum(skipped_existing_by_source.values())} articles already stored from an earlier run.")
    articles = fresh_articles

    _set_run_timestamps(clean_finished_at=datetime.now(timezone.utc).isoformat())

    write_output(articles)

    saved_by_source = {}
    if articles:
        print("Saving to local PostgreSQL...")
        stats["articles_saved"], saved_by_source = save_articles(
            [mark_unanalyzed(article) for article in articles]
        )
        print("Done.")

    push_run_progress(
        stats,
        stage="done",
        message="Pipeline complete.",
        final=True,
    )

    _persist_source_stats(
        scraped_by_source,
        removed_by_source,
        date_filtered_by_source,
        skipped_existing_by_source,
        kept_by_source,
        saved_by_source,
    )

    write_pipeline_stats(stats)


if __name__ == "__main__":
    main()
