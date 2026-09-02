"""Aggregate reads for the dashboard homepage: one project's totals, its
articles-per-run series, platform and source breakdowns, and which sources -
and, for a competitor study, which competitors - came back empty or blocked on
the most recent run.

Nothing here is persisted; it's all read fresh from articles/pipeline_runs/
pipeline_run_sources/competitors each call, the same tables the rest of the
app already reads.
"""

from __future__ import annotations

from app.core import db
from services.articles.articles_store import get_article_stats
from services.pipeline.pipeline_runs import list_pipeline_runs
from services.pipeline.source_diagnostics import classify_fetch_issue

RUNS_SERIES_LIMIT = 20

# Dashboard platforms are collection channels, not the final publisher domain.
# A keyword source can discover an x.com URL through its Apify tier, for
# example, but the article still belongs to Keyword because that configured
# source initiated the collection. The three X-specific source shapes are one
# top-level platform in the source-management UI and are rolled up the same way
# here.
PLATFORM_DEFINITIONS = (
    ("rss", "RSS"),
    ("web", "Web"),
    ("keyword", "Keyword"),
    ("twitter", "Twitter/X"),
    ("reddit", "Reddit"),
    ("telegram", "Telegram"),
    ("linkedin", "LinkedIn"),
)
TWITTER_SOURCE_TYPES = {"hashtag", "username", "tweet"}


def _platform_key(source_type):
    value = str(source_type or "other").strip().lower() or "other"
    return "twitter" if value in TWITTER_SOURCE_TYPES else value


def _platform_label(key):
    labels = dict(PLATFORM_DEFINITIONS)
    if key == "other":
        return "Imported / Other"
    return labels.get(key, key.replace("_", " ").replace("-", " ").title())


def _project_or_none(project_id):
    return db.fetch_one(
        "select id, name, mode, status from projects where id = %s",
        (int(project_id),),
    )


def _total_sources(project_id):
    row = db.fetch_one(
        "select count(*)::int as total from project_sources where project_id = %s",
        (int(project_id),),
    )
    return int((row or {}).get("total") or 0)


def _total_runs(project_id):
    row = db.fetch_one(
        "select count(*)::int as total from pipeline_runs where project_id = %s and pipeline = 'scrape'",
        (int(project_id),),
    )
    return int((row or {}).get("total") or 0)


def _articles_by_platform(project_id):
    """All-time article contribution by collection platform for one project.

    Seed every supported platform so the dashboard shows a useful zero before
    a source has contributed anything. Unknown future source types are kept as
    their own platforms, while project-linked imports with no matching source
    are accounted for under Imported / Other.
    """
    configured_rows = db.fetch_all(
        """
        select lower(coalesce(nullif(s.source_type, ''), 'rss')) as source_type,
               count(*)::int as source_count
        from project_sources ps
        join sources s on s.id = ps.source_id
        where ps.project_id = %s
        group by 1
        """,
        (int(project_id),),
    ) or []
    article_rows = db.fetch_all(
        """
        select lower(coalesce(
                 nullif(s.source_type, ''),
                 case
                   when coalesce(a.source_url, '') ~* '^https?://(www\\.)?(x\\.com|twitter\\.com)/[^/]+/status/[0-9]+'
                     then 'tweet'
                 end,
                 'other'
               )) as source_type,
               count(distinct a.id)::int as article_count
        from articles a
        left join sources s on s.url = a.source_url
        where exists (
                select 1 from article_projects ap
                where ap.article_id = a.id and ap.project_id = %s
              )
           or exists (
                select 1 from project_sources ps
                join sources project_source on project_source.id = ps.source_id
                where ps.project_id = %s and project_source.url = a.source_url
              )
        group by 1
        """,
        (int(project_id), int(project_id)),
    ) or []

    platforms = {
        key: {"platform": key, "label": label, "count": 0, "source_count": 0}
        for key, label in PLATFORM_DEFINITIONS
    }
    for row in configured_rows:
        key = _platform_key(row.get("source_type"))
        entry = platforms.setdefault(
            key,
            {"platform": key, "label": _platform_label(key), "count": 0, "source_count": 0},
        )
        entry["source_count"] += int(row.get("source_count") or 0)
    for row in article_rows:
        key = _platform_key(row.get("source_type"))
        entry = platforms.setdefault(
            key,
            {"platform": key, "label": _platform_label(key), "count": 0, "source_count": 0},
        )
        entry["count"] += int(row.get("article_count") or 0)

    # Imported / Other is informative only when it represents real articles;
    # unlike supported platforms, it is not a collection option to seed at 0.
    return [entry for entry in platforms.values() if entry["platform"] != "other" or entry["count"] > 0]


def _runs_series(project_id):
    # list_pipeline_runs() orders newest-first (right for a runs table); a
    # time-series chart reads left-to-right chronologically, so reverse it.
    runs = list_pipeline_runs(limit=RUNS_SERIES_LIMIT, project_id=project_id)
    return [
        {
            "id": run["id"],
            "sequence_number": run.get("sequence_number"),
            "created_at": run.get("created_at"),
            "articles_saved": run.get("articles_saved") or 0,
            "status": run.get("status"),
        }
        for run in reversed(runs)
    ]


def _latest_detailed_run_id(project_id):
    row = db.fetch_one(
        """
        select id from pipeline_runs
        where project_id = %s and pipeline = 'scrape' and has_detail
        order by created_at desc
        limit 1
        """,
        (int(project_id),),
    )
    return row["id"] if row else None


def _sources_needing_attention(project_id, run_id):
    """Every source configured for this project whose row in the latest run
    carries a fetch_note (blocked, HTTP error, or "Returned 0 articles.") -
    see source_diagnostics.build_fetch_note. A source never scraped in that
    run isn't flagged; a project's sources always run together in one crawl,
    so a source missing entirely means the run predates that source, not a
    fetch problem worth surfacing here."""
    if not run_id:
        return []
    rows = db.fetch_all(
        """
        select prs.source, prs.source_url, prs.saved, prs.fetch_note, prs.http_status, prs.network_blocked,
               s.source_type,
               pr.created_at as last_run_at
        from pipeline_run_sources prs
        join pipeline_runs pr on pr.id = prs.run_id
        join sources s on s.url = prs.source_url
        join project_sources ps on ps.source_id = s.id
        where ps.project_id = %s and prs.run_id = %s
          and coalesce(prs.fetch_note, '') != ''
        order by prs.saved asc, prs.source asc
        """,
        (int(project_id), run_id),
    )
    result = []
    for row in rows:
        issue = classify_fetch_issue(
            row["fetch_note"],
            http_status=row.get("http_status"),
            network_blocked=bool(row["network_blocked"]),
            source_type=row.get("source_type"),
        )
        result.append({
            "source": row["source"],
            "source_url": row["source_url"],
            "reason": row["fetch_note"],
            "network_blocked": bool(row["network_blocked"]),
            "last_run_at": row["last_run_at"],
            "issue": issue,
        })
    return result


def _competitor_totals(project_id):
    row = db.fetch_one(
        "select count(*) filter (where status = 'tracked')::int as tracked from competitors where project_id = %s",
        (int(project_id),),
    )
    return int((row or {}).get("tracked") or 0)


def _competitors_needing_attention(project_id, run_id):
    """Tracked competitors with at least one valid, linked source that came
    back with a fetch_note on the latest run - grouped so the dashboard can
    show one card per competitor with the specific sources at fault."""
    if not run_id:
        return []
    rows = db.fetch_all(
        """
        select c.id, c.name, ca.platform, ca.url as source_url, prs.fetch_note,
               prs.http_status, prs.network_blocked
        from competitors c
        join competitor_accounts ca on ca.competitor_id = c.id and ca.validation_status = 'valid'
        join sources s on s.id = ca.source_id
        join pipeline_run_sources prs on prs.source_url = s.url and prs.run_id = %s
        where c.project_id = %s and c.status = 'tracked'
          and coalesce(prs.fetch_note, '') != ''
        order by c.name asc
        """,
        (run_id, int(project_id)),
    )
    grouped = {}
    for row in rows:
        entry = grouped.setdefault(row["id"], {"id": row["id"], "name": row["name"], "sources": []})
        issue = classify_fetch_issue(
            row["fetch_note"],
            http_status=row.get("http_status"),
            network_blocked=bool(row["network_blocked"]),
            source_type=row.get("platform"),
        )
        entry["sources"].append(
            {
                "platform": row["platform"],
                "source_url": row["source_url"],
                "reason": row["fetch_note"],
                "network_blocked": bool(row["network_blocked"]),
                "issue": issue,
            }
        )
    return list(grouped.values())


def get_dashboard_summary(project_id):
    project = _project_or_none(project_id)
    if not project:
        return None

    article_stats = get_article_stats(project_id=project_id)
    latest_run_id = _latest_detailed_run_id(project_id)

    summary = {
        "project": project,
        "totals": {
            "articles": article_stats["total"],
            "sources": _total_sources(project_id),
            "runs": _total_runs(project_id),
        },
        "runs": _runs_series(project_id),
        "articles_by_source": [
            {"source": row["source"], "count": row["count"]} for row in article_stats["sources"]
        ],
        "articles_by_platform": _articles_by_platform(project_id),
        "sources_needing_attention": _sources_needing_attention(project_id, latest_run_id),
        "competitors_needing_attention": [],
    }

    if project.get("mode") == "competitor":
        summary["totals"]["competitors"] = _competitor_totals(project_id)
        summary["competitors_needing_attention"] = _competitors_needing_attention(project_id, latest_run_id)

    return summary
