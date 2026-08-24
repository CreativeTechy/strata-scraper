import os
import unittest
from collections import Counter
from datetime import date
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from services.articles import collect


class CleanArticlesTests(unittest.TestCase):
    def _article(self, **overrides):
        article = {
            "url": "https://example.com/a",
            "title": "A real headline",
            "text": "x" * 300,
            "source": "example.com",
        }
        article.update(overrides)
        return article

    def test_duplicate_urls_are_dropped(self):
        articles = [self._article(), self._article()]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(removed["example.com"]["duplicate"], 1)

    def test_short_text_is_blocked(self):
        articles = [self._article(url="https://example.com/b", text="too short")]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(cleaned, [])
        self.assertEqual(removed["example.com"]["blocked"], 1)

    def test_missing_title_is_blocked(self):
        articles = [self._article(url="https://example.com/c", title="")]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(cleaned, [])
        self.assertEqual(removed["example.com"]["blocked"], 1)

    def test_google_consent_page_is_blocked(self):
        articles = [self._article(url="https://consent.google.com/x", title="Before you continue to Google")]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(cleaned, [])
        self.assertEqual(removed["example.com"]["blocked"], 1)

    def test_short_tweet_is_kept(self):
        articles = [
            self._article(
                url="https://x.com/someuser/status/1234567890",
                title="@someuser",
                text="lol nice",
                source="x.com/someuser",
            )
        ]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(removed["x.com/someuser"]["blocked"], 0)

    def test_clean_article_is_kept(self):
        articles = [self._article()]
        cleaned, removed = collect.clean_articles(articles)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(removed["example.com"], {"duplicate": 0, "blocked": 0})

    def test_seen_urls_dedups_across_separate_calls(self):
        """The streaming pipeline calls this once per article with a shared
        set - dedup has to span calls, not just one batch."""
        seen = set()
        first, _ = collect.clean_articles([self._article()], seen_urls=seen)
        second, removed = collect.clean_articles([self._article()], seen_urls=seen)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        self.assertEqual(removed["example.com"]["duplicate"], 1)


class DateWindowTests(unittest.TestCase):
    PROJECT = {"start_date": "2026-03-01", "end_date": "2026-03-31"}

    def test_article_inside_the_window_matches(self):
        article = {"published_at": "2026-03-15T08:00:00Z"}
        self.assertTrue(collect._article_matches_project_window(article, self.PROJECT))

    def test_article_before_the_window_is_filtered(self):
        article = {"published_at": "2026-02-27T08:00:00Z"}
        self.assertFalse(collect._article_matches_project_window(article, self.PROJECT))

    def test_article_after_the_window_is_filtered(self):
        article = {"published_at": "2026-04-02"}
        self.assertFalse(collect._article_matches_project_window(article, self.PROJECT))

    def test_undated_article_is_kept(self):
        """No publish date is not evidence of being outside the window -
        filtering these out would silently drop every source that doesn't
        publish a date."""
        self.assertTrue(collect._article_matches_project_window({"published": ""}, self.PROJECT))

    def test_rfc_2822_date_is_understood(self):
        """RSS feeds date items in RFC 2822, not ISO."""
        article = {"published": "Sat, 14 Mar 2026 09:12:00 +0000"}
        self.assertEqual(collect._article_published_date(article), date(2026, 3, 14))


class AlreadyStoredTests(unittest.TestCase):
    def test_stored_url_is_recognized(self):
        article = {"url": "https://example.com/a"}
        self.assertTrue(collect._already_stored(article, {"https://example.com/a"}))

    def test_unstored_url_is_not(self):
        article = {"url": "https://example.com/b"}
        self.assertFalse(collect._already_stored(article, {"https://example.com/a"}))

    def test_empty_lookup_never_skips(self):
        """get_existing_urls() returns an empty set both for "nothing stored"
        and for a failed lookup - neither may skip an article."""
        self.assertFalse(collect._already_stored({"url": "https://example.com/a"}, set()))


class PersistSourceStatsTests(unittest.TestCase):
    """_persist_source_stats() merges scraper-recorded diagnostics (blocked/
    404/DNS failure/empty - see source_diagnostics.py) into the per-source
    breakdown, so a source that scraped 0 articles still gets a row."""

    def test_no_pipeline_run_id_skips_persist_entirely(self):
        with patch.object(collect, "PIPELINE_RUN_ID", ""), patch.object(collect, "upsert_pipeline_run_source_stats") as mock_upsert:
            collect._persist_source_stats({}, {}, {}, {}, {}, {})
        mock_upsert.assert_not_called()

    def test_zero_scraped_source_gets_a_row_via_diagnostics_alone(self):
        with patch.object(collect, "PIPELINE_RUN_ID", "run-1"), patch.object(
            collect, "load_source_diagnostics",
            return_value=[{"source_name": "r/messi", "http_status": 403, "network_blocked": True}],
        ), patch.object(collect, "upsert_pipeline_run_source_stats") as mock_upsert:
            collect._persist_source_stats({}, {}, {}, {}, {}, {})

        mock_upsert.assert_called_once()
        run_id, stats = mock_upsert.call_args[0]
        self.assertEqual(run_id, "run-1")
        self.assertIn("r/messi", stats)
        self.assertEqual(stats["r/messi"]["scraped"], 0)
        self.assertTrue(stats["r/messi"]["network_blocked"])
        self.assertIn("Blocked", stats["r/messi"]["fetch_note"])

    def test_healthy_scraped_source_has_no_fetch_note(self):
        with patch.object(collect, "PIPELINE_RUN_ID", "run-1"), patch.object(
            collect, "load_source_diagnostics", return_value=[]
        ), patch.object(collect, "upsert_pipeline_run_source_stats") as mock_upsert:
            collect._persist_source_stats(Counter({"good-source": 3}), {}, {}, {}, {}, {})

        _, stats = mock_upsert.call_args[0]
        self.assertEqual(stats["good-source"]["scraped"], 3)
        self.assertEqual(stats["good-source"]["fetch_note"], "")
        self.assertFalse(stats["good-source"]["network_blocked"])

    def test_source_with_no_diagnostic_and_zero_scraped_notes_empty(self):
        with patch.object(collect, "PIPELINE_RUN_ID", "run-1"), patch.object(
            collect, "load_source_diagnostics", return_value=[]
        ), patch.object(collect, "upsert_pipeline_run_source_stats") as mock_upsert:
            # date_filtered still references the source even though nothing was scraped/kept.
            collect._persist_source_stats({}, {}, Counter({"quiet-source": 1}), {}, {}, {})

        _, stats = mock_upsert.call_args[0]
        self.assertEqual(stats["quiet-source"]["fetch_note"], "Returned 0 articles.")

    def test_skipped_existing_is_reported_per_source(self):
        with patch.object(collect, "PIPELINE_RUN_ID", "run-1"), patch.object(
            collect, "load_source_diagnostics", return_value=[]
        ), patch.object(collect, "upsert_pipeline_run_source_stats") as mock_upsert:
            collect._persist_source_stats(
                Counter({"example.com": 2}), {}, {}, Counter({"example.com": 2}),
                Counter({"example.com": 2}), {},
            )

        _, stats = mock_upsert.call_args[0]
        self.assertEqual(stats["example.com"]["kept"], 2)
        self.assertEqual(stats["example.com"]["skipped_existing"], 2)
        self.assertEqual(stats["example.com"]["saved"], 0)


if __name__ == "__main__":
    unittest.main()
