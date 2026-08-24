import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from services.articles import store


class ArticleRowFieldHandlingTests(unittest.TestCase):
    """_article_row() special-cases a handful of fields beyond the generic
    JSON/plain-value path - these tests pin that behavior directly rather
    than through a live DB round trip."""

    def _article(self, **overrides):
        article = {
            "url": "https://example.com/a",
            "embedding_json": [0.1, 0.2, 0.3],
            "analysis_status": None,
            "analysis_started_at": "",
            "reprocess_requested_at": "",
        }
        article.update(overrides)
        return article

    def _field_value(self, article, field_name):
        with patch("services.articles.store._article_write_fields", return_value=[field_name, "embedding_json"]):
            fields, params = store._article_row(article)
        return dict(zip(fields, params))[field_name]

    def test_embedding_dimensions_is_derived_from_embedding_json_length(self):
        value = self._field_value(self._article(), "embedding_dimensions")
        self.assertEqual(value, 3)

    def test_embedding_dimensions_is_none_when_no_embedding(self):
        value = self._field_value(self._article(embedding_json=None), "embedding_dimensions")
        self.assertIsNone(value)

    def test_blank_analysis_status_falls_back_to_success(self):
        value = self._field_value(self._article(), "analysis_status")
        self.assertEqual(value, "success")

    def test_explicit_analysis_status_is_preserved(self):
        value = self._field_value(self._article(analysis_status="failed"), "analysis_status")
        self.assertEqual(value, "failed")

    def test_blank_timestamp_fields_become_none(self):
        value = self._field_value(self._article(), "analysis_started_at")
        self.assertIsNone(value)

    def test_reprocess_requested_at_defaults_to_none(self):
        """The pipeline never sets this - it's operator-controlled - so a
        normal analysis write always clears it back to null."""
        value = self._field_value(self._article(reprocess_requested_at="2026-01-01T00:00:00+00:00"), "reprocess_requested_at")
        self.assertEqual(value, "2026-01-01T00:00:00+00:00")
        value = self._field_value(self._article(), "reprocess_requested_at")
        self.assertIsNone(value)


class UpsertArticleRowConflictClauseTests(unittest.TestCase):
    """_upsert_article_row()'s on-conflict clause must not blindly overwrite
    pipeline_run_id from `excluded.*` like every other field. It records which
    run *first* saved this article - every run re-crawls all of a project's
    sources, so a later run routinely re-upserts URLs an earlier run already
    saved, and must not steal that article's run attribution. It also must
    not blank the field out for saves that don't know a run id at all
    (reanalyze, import, competitor doc extraction). Mirrors the existing
    content_changed_at conditional-update coverage style in this file."""

    def test_pipeline_run_id_keeps_the_first_saved_value(self):
        captured = {}

        def _fake_fetch_one(sql, params):
            captured["sql"] = sql
            return {"id": 1, "source_url": "https://example.com"}

        article = {"url": "https://example.com/a"}
        with patch("services.articles.store._article_write_fields", return_value=["url", "pipeline_run_id"]):
            with patch("services.articles.store._article_columns", return_value={"url", "pipeline_run_id"}):
                with patch("services.articles.store.db.fetch_one", side_effect=_fake_fetch_one):
                    store._upsert_article_row(article)

        self.assertIn(
            "pipeline_run_id = coalesce(articles.pipeline_run_id, excluded.pipeline_run_id)",
            captured["sql"],
        )
        self.assertNotIn("pipeline_run_id = excluded.pipeline_run_id", captured["sql"])


if __name__ == "__main__":
    unittest.main()
