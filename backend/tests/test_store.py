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

    def test_blank_analysis_status_falls_back_to_pending(self):
        """Not "success": this app never analyzes anything, and the importing
        side skips re-analyzing rows already marked successful."""
        value = self._field_value(self._article(), "analysis_status")
        self.assertEqual(value, "pending")

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


class WriteFieldSelectionTests(unittest.TestCase):
    """Several analysis columns are `not null default <neutral>`. Naming one
    with a NULL value fails the constraint instead of falling back to the
    default, which is what silently cost every article in a collect run
    before _article_write_fields() learned to skip absent keys."""

    TABLE_COLUMNS = set(store.ARTICLE_MUTABLE_FIELDS)

    def _fields(self, article):
        with patch("services.articles.store._article_columns", return_value=self.TABLE_COLUMNS):
            return store._article_write_fields(article)

    def _scraped_article(self, **overrides):
        article = {
            "url": "https://example.com/a",
            "source": "example.com",
            "title": "A headline",
            "text": "x" * 300,
            "fetched_at": "2026-08-24T00:00:00+00:00",
        }
        article.update(overrides)
        return article

    def test_not_null_analysis_columns_are_omitted_when_absent(self):
        fields = self._fields(self._scraped_article())
        for column in (
            "sentiment_low_confidence", "analysis_attempt_count",
            "gender", "age_range", "region",
        ):
            self.assertNotIn(column, fields)

    def test_scraped_columns_are_written(self):
        fields = self._fields(self._scraped_article())
        for column in ("url", "source", "title", "text", "fetched_at"):
            self.assertIn(column, fields)

    def test_derived_columns_are_written_even_when_absent(self):
        """verified/content_hash/published_at are computed by _article_row
        itself, so they must survive the presence filter."""
        fields = self._fields(self._scraped_article())
        for column in ("verified", "content_hash", "published_at", "published_precision"):
            self.assertIn(column, fields)

    def test_falsy_values_are_real_values(self):
        """0/false/"" mean something; only missing means "use the default"."""
        fields = self._fields(self._scraped_article(
            sentiment_low_confidence=False, relevance_score=0, summary="",
        ))
        for column in ("sentiment_low_confidence", "relevance_score", "summary"):
            self.assertIn(column, fields)

    def test_no_article_returns_the_full_list(self):
        """stored_article_fields() feeds the export, which has to cover every
        column the upsert can write - not just one article's subset."""
        with patch("services.articles.store._article_columns", return_value=self.TABLE_COLUMNS):
            self.assertEqual(
                store._article_write_fields(),
                [f for f in store.ARTICLE_MUTABLE_FIELDS if f in self.TABLE_COLUMNS],
            )


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
