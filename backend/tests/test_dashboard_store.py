import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from services.dashboard import dashboard_store


class DashboardSummaryTests(unittest.TestCase):
    """get_dashboard_summary() shapes one project's collection health: totals,
    an articles-per-run series, an articles-by-source breakdown, and (from the
    latest run with per-source detail) which sources - or, for a competitor
    study, which competitors - need attention."""

    def _fetch_one(self, project_row, sources_total=3, competitors_tracked=0, latest_run_id="run-2", runs_total=2):
        def fetch_one(sql, params=()):
            if "from projects where id" in sql:
                return project_row
            if "from project_sources where project_id" in sql:
                return {"total": sources_total}
            if "from pipeline_runs" in sql and "has_detail" in sql:
                return {"id": latest_run_id} if latest_run_id else None
            if "from pipeline_runs" in sql:
                return {"total": runs_total}
            if "from competitors where project_id" in sql:
                return {"tracked": competitors_tracked}
            raise AssertionError(f"Unexpected fetch_one query: {sql}")

        return fetch_one

    def test_missing_project_returns_none(self):
        with patch("services.dashboard.dashboard_store.db.fetch_one", return_value=None):
            self.assertIsNone(dashboard_store.get_dashboard_summary(999))

    def test_sentiment_project_has_no_competitor_fields(self):
        project_row = {"id": 1, "name": "Coffee Chatter", "mode": "sentiment", "status": "active"}
        fetch_one = self._fetch_one(project_row, sources_total=4, latest_run_id="run-9", runs_total=6)

        def fetch_all(sql, params=()):
            if "pipeline_run_sources prs" in sql and "project_sources ps" in sql:
                return [
                    {
                        "source": "Blocked Blog",
                        "source_url": "https://blocked.example/feed",
                        "saved": 0,
                        "fetch_note": "Blocked (HTTP 403) - likely anti-bot protection.",
                        "network_blocked": True,
                        "last_run_at": "2026-08-30T00:00:00Z",
                    }
                ]
            raise AssertionError(f"Unexpected fetch_all query: {sql}")

        with patch("services.dashboard.dashboard_store.db.fetch_one", side_effect=fetch_one), \
             patch("services.dashboard.dashboard_store.db.fetch_all", side_effect=fetch_all), \
             patch(
                 "services.dashboard.dashboard_store.get_article_stats",
                 return_value={"total": 42, "sources": [{"source": "Blocked Blog", "count": 42, "last_scraped_at": None}]},
             ), \
             patch(
                 "services.dashboard.dashboard_store.list_pipeline_runs",
                 return_value=[
                     {"id": "run-9", "sequence_number": 2, "created_at": "t2", "articles_saved": 5, "status": "success"},
                     {"id": "run-8", "sequence_number": 1, "created_at": "t1", "articles_saved": 3, "status": "success"},
                 ],
             ):
            summary = dashboard_store.get_dashboard_summary(1)

        self.assertEqual(summary["totals"], {"articles": 42, "sources": 4, "runs": 6})
        self.assertNotIn("competitors", summary["totals"])
        self.assertEqual(summary["competitors_needing_attention"], [])
        # Runs come back oldest-first for a left-to-right chart.
        self.assertEqual([r["sequence_number"] for r in summary["runs"]], [1, 2])
        self.assertEqual(len(summary["sources_needing_attention"]), 1)
        self.assertEqual(summary["sources_needing_attention"][0]["source"], "Blocked Blog")

    def test_competitor_project_groups_attention_by_competitor(self):
        project_row = {"id": 2, "name": "Roastery Watch", "mode": "competitor", "status": "active"}
        fetch_one = self._fetch_one(project_row, sources_total=2, competitors_tracked=3, latest_run_id="run-1", runs_total=1)

        def fetch_all(sql, params=()):
            if "pipeline_run_sources prs" in sql and "project_sources ps" in sql:
                return []
            if "competitor_accounts ca" in sql:
                return [
                    {
                        "id": 10,
                        "name": "Acme Roasters",
                        "platform": "instagram",
                        "source_url": "https://instagram.com/acme",
                        "fetch_note": "Returned 0 articles.",
                        "network_blocked": False,
                    },
                    {
                        "id": 10,
                        "name": "Acme Roasters",
                        "platform": "x",
                        "source_url": "https://x.com/acme",
                        "fetch_note": "HTTP 404 - the source's page could not be fetched.",
                        "network_blocked": False,
                    },
                ]
            raise AssertionError(f"Unexpected fetch_all query: {sql}")

        with patch("services.dashboard.dashboard_store.db.fetch_one", side_effect=fetch_one), \
             patch("services.dashboard.dashboard_store.db.fetch_all", side_effect=fetch_all), \
             patch(
                 "services.dashboard.dashboard_store.get_article_stats",
                 return_value={"total": 7, "sources": []},
             ), \
             patch("services.dashboard.dashboard_store.list_pipeline_runs", return_value=[]):
            summary = dashboard_store.get_dashboard_summary(2)

        self.assertEqual(summary["totals"]["competitors"], 3)
        self.assertEqual(summary["totals"]["runs"], 1)
        self.assertEqual(len(summary["competitors_needing_attention"]), 1)
        grouped = summary["competitors_needing_attention"][0]
        self.assertEqual(grouped["name"], "Acme Roasters")
        self.assertEqual(len(grouped["sources"]), 2)

    def test_no_detailed_run_yet_skips_attention_queries(self):
        project_row = {"id": 3, "name": "New Project", "mode": "sentiment", "status": "draft"}
        fetch_one = self._fetch_one(project_row, sources_total=0, latest_run_id=None)

        with patch("services.dashboard.dashboard_store.db.fetch_one", side_effect=fetch_one), \
             patch("services.dashboard.dashboard_store.db.fetch_all") as fetch_all, \
             patch(
                 "services.dashboard.dashboard_store.get_article_stats",
                 return_value={"total": 0, "sources": []},
             ), \
             patch("services.dashboard.dashboard_store.list_pipeline_runs", return_value=[]):
            summary = dashboard_store.get_dashboard_summary(3)

        fetch_all.assert_not_called()
        self.assertEqual(summary["sources_needing_attention"], [])


if __name__ == "__main__":
    unittest.main()
