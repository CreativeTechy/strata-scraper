import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from services.articles import articles_store


class ContentHashTests(unittest.TestCase):
    """The fingerprint behind content_changed_at (migration 0017): it decides
    whether a re-scrape counts as the competitor having done something."""

    def test_reflowed_whitespace_is_not_a_change(self):
        """Markup re-wrapped between crawls must not read as news."""
        from services.articles import store

        self.assertEqual(
            store._content_hash("Cafe Younes opens a third roastery"),
            store._content_hash("Cafe   Younes\n\nopens a\tthird roastery\n"),
        )

    def test_a_real_edit_changes_the_hash(self):
        from services.articles import store

        self.assertNotEqual(
            store._content_hash("Espresso blend 250,000 LBP"),
            store._content_hash("Espresso blend 290,000 LBP"),
        )

    def test_empty_body_has_no_hash(self):
        """None rather than the hash of the empty string, so a page that failed
        to extract does not compare equal to every other failed extraction and
        freeze their change timestamps."""
        from services.articles import store

        self.assertIsNone(store._content_hash(""))
        self.assertIsNone(store._content_hash(None))
        self.assertIsNone(store._content_hash("   \n  "))


class PipelineRunFilterTests(unittest.TestCase):
    """pipeline_run_id scopes a listing/export to one crawl - the filter behind
    "extract articles" on a pipeline run's detail page and the /articles
    per-run filter."""

    def test_where_parts_adds_pipeline_run_clause(self):
        where_sql, params = articles_store._where_parts(pipeline_run_id="run-abc")
        self.assertIn("pipeline_run_id = %s", where_sql)
        self.assertIn("run-abc", params)

    def test_where_parts_omits_clause_when_blank(self):
        where_sql, params = articles_store._where_parts(pipeline_run_id="   ")
        self.assertNotIn("pipeline_run_id", where_sql)

    def test_list_articles_filters_by_pipeline_run_id(self):
        captured = {}

        def fetch_all(sql, params=()):
            captured["sql"] = sql
            captured["params"] = params
            return []

        patchers = [
            patch("services.articles.articles_store.config.DATABASE_URL", "postgresql://x"),
            patch("services.articles.articles_store.db.fetch_all", side_effect=fetch_all),
            patch("services.articles.articles_store.db.fetch_one", return_value={"total": 0}),
        ]
        for patcher in patchers:
            patcher.start()
        try:
            articles_store.list_articles(pipeline_run_id="run-1")
        finally:
            for patcher in patchers:
                patcher.stop()

        self.assertIn("pipeline_run_id = %s", captured["sql"])
        self.assertIn("run-1", captured["params"])

    def test_export_articles_filters_by_pipeline_run_id(self):
        captured = {}

        def fetch_all(sql, params=()):
            if "information_schema" in sql:
                return []
            captured["sql"] = sql
            captured["params"] = params
            return []

        patchers = [
            patch("services.articles.articles_store.config.DATABASE_URL", "postgresql://x"),
            patch("services.articles.articles_store.db.fetch_all", side_effect=fetch_all),
            patch("services.articles.articles_store.db.fetch_one", return_value={"total": 0}),
        ]
        for patcher in patchers:
            patcher.start()
        try:
            list(articles_store.export_articles(pipeline_run_id="run-1"))
        finally:
            for patcher in patchers:
                patcher.stop()

        self.assertIn("pipeline_run_id = %s", captured["sql"])
        self.assertIn("run-1", captured["params"])


class BulkPagingTests(unittest.TestCase):
    """MAX_LIMIT caps what a single API response may return. Readers that walk
    the whole result set page through _fetch_articles, so if they ask for a
    page bigger than that cap they get a short page back and read it as "no
    more rows" - silently truncating at MAX_LIMIT. A 900-article project
    exported 100 articles because of exactly that."""

    def _fake_db(self, total, columns=("id", "url", "title")):
        rows_all = [{column: f"{column}-{i}" for column in columns} for i in range(total)]

        def fetch_all(sql, params=()):
            if "information_schema" in sql:
                # Let the export's column list fall back to ARTICLE_MUTABLE_FIELDS.
                return []
            limit, offset = params[-2], params[-1]
            return rows_all[offset:offset + limit]

        return fetch_all

    def _patched(self, total):
        return [
            patch("services.articles.articles_store.config.DATABASE_URL", "postgresql://x"),
            patch("services.articles.articles_store.db.fetch_all", side_effect=self._fake_db(total)),
            patch("services.articles.articles_store.db.fetch_one", return_value={"total": total}),
        ]

    def _run(self, total, call):
        patchers = self._patched(total)
        for patcher in patchers:
            patcher.start()
        try:
            return call()
        finally:
            for patcher in patchers:
                patcher.stop()

    def test_export_returns_every_matching_article_not_just_the_first_page(self):
        rows = self._run(900, lambda: list(articles_store.export_articles()))
        self.assertEqual(len(rows), 900)

    def test_export_of_a_partial_page_still_terminates(self):
        rows = self._run(37, lambda: list(articles_store.export_articles()))
        self.assertEqual(len(rows), 37)

    def test_export_pages_are_contiguous_with_no_repeats_or_gaps(self):
        rows = self._run(900, lambda: list(articles_store.export_articles()))
        self.assertEqual([row["id"] for row in rows], [f"id-{i}" for i in range(900)])

    def test_export_streams_rather_than_building_the_whole_result_set(self):
        """The point of the generator: a caller that stops early must not have
        paid for every remaining page, and nothing may be read before the first
        row is asked for."""
        queries = []
        rows_all = [{"id": f"id-{i}", "url": f"url-{i}"} for i in range(2000)]

        def fetch_all(sql, params=()):
            if "information_schema" in sql:
                return []
            queries.append(params[-1])
            limit, offset = params[-2], params[-1]
            return rows_all[offset:offset + limit]

        patchers = [
            patch("services.articles.articles_store.config.DATABASE_URL", "postgresql://x"),
            patch("services.articles.articles_store.db.fetch_all", side_effect=fetch_all),
            patch("services.articles.articles_store.db.fetch_one", return_value={"total": 2000}),
        ]
        for patcher in patchers:
            patcher.start()
        try:
            stream = articles_store.export_articles()
            self.assertEqual(queries, [])  # nothing read until iteration starts

            first_page = [next(stream) for _ in range(articles_store.BULK_PAGE_SIZE)]
            self.assertEqual(len(first_page), articles_store.BULK_PAGE_SIZE)
            self.assertEqual(len(queries), 1)  # and only the first page was read

            stream.close()
        finally:
            for patcher in patchers:
                patcher.stop()

    def test_export_with_search_pages_past_the_old_bounded_scan_limit(self):
        """Search used to route through a 1000-row bounded scan and silently
        cap a filtered export there - search is now plain SQL pagination via
        _fetch_articles like any other filter, so this must page just as far
        as the unfiltered export does."""
        rows = self._run(2500, lambda: list(articles_store.export_articles(search="lebanon")))
        self.assertEqual(len(rows), 2500)


if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()
