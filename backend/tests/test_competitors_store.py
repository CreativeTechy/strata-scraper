import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from fastapi.testclient import TestClient

from services.auth import auth
from services.competitors import competitors_store
import main

FAKE_USER = {"id": 1, "username": "admin", "role_id": 1, "status": "active"}


def _fake_get_current_user():
    return FAKE_USER


class NormalizeSourceUrlTests(unittest.TestCase):
    def test_bare_domain_gets_https_prefix(self):
        self.assertEqual(competitors_store.normalize_source_url("example.com"), "https://example.com")

    def test_existing_scheme_is_kept(self):
        self.assertEqual(
            competitors_store.normalize_source_url("http://example.com/feed"),
            "http://example.com/feed",
        )

    def test_blank_is_rejected(self):
        self.assertIsNone(competitors_store.normalize_source_url(""))
        self.assertIsNone(competitors_store.normalize_source_url(None))

    def test_no_dotted_host_is_rejected(self):
        self.assertIsNone(competitors_store.normalize_source_url("not a url"))
        self.assertIsNone(competitors_store.normalize_source_url("https://localhost"))


class PlatformSourceTypeTests(unittest.TestCase):
    """No generic "social" source_type any more (see config._infer_source_type) -
    an "x" account resolves to "username", and platforms with no dedicated
    scraping tier (Facebook/Instagram/YouTube) resolve to "web"."""

    def test_x_resolves_to_username(self):
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE["x"], "username")

    def test_facebook_instagram_youtube_resolve_to_web(self):
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE["facebook"], "web")
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE["instagram"], "web")
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE["youtube"], "web")

    def test_tweet_resolves_to_tweet(self):
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE["tweet"], "tweet")

    def test_social_is_not_a_known_value_but_still_falls_back_to_web(self):
        self.assertNotIn("social", competitors_store.PLATFORM_SOURCE_TYPE.values())
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE.get("social", "web"), "web")

    def test_unrecognized_platform_defaults_to_web(self):
        self.assertEqual(competitors_store.PLATFORM_SOURCE_TYPE.get("not-a-real-platform", "web"), "web")


class ResolveAccountUrlTests(unittest.TestCase):
    def test_term_platforms_derive_from_handle(self):
        self.assertEqual(competitors_store.resolve_account_url("username", "", "elonmusk"), "https://x.com/elonmusk")
        self.assertEqual(competitors_store.resolve_account_url("hashtag", "", "EVSummit"), "https://x.com/hashtag/EVSummit")

    def test_tweet_platform_derives_and_validates_a_status_url(self):
        self.assertEqual(
            competitors_store.resolve_account_url("tweet", "https://x.com/elonmusk/status/123", ""),
            "https://x.com/elonmusk/status/123",
        )

    def test_tweet_platform_rejects_a_non_status_url(self):
        self.assertIsNone(competitors_store.resolve_account_url("tweet", "https://x.com/elonmusk", ""))

    def test_reddit_and_telegram_still_derive_as_before(self):
        self.assertEqual(competitors_store.resolve_account_url("reddit", "r/test", ""), "https://www.reddit.com/r/test")
        self.assertEqual(competitors_store.resolve_account_url("telegram", "@somechannel", ""), "https://t.me/s/somechannel")

    def test_other_platforms_fall_back_to_plain_url_normalization(self):
        self.assertEqual(competitors_store.resolve_account_url("web", "example.com", ""), "https://example.com")
        self.assertEqual(competitors_store.resolve_account_url("facebook", "facebook.com/acme", ""), "https://facebook.com/acme")


class ExportCompetitorsTests(unittest.TestCase):
    """export_competitors() feeds GET /api/competitors/export - the handoff
    that lets an analysis app skip re-guessing a competitor list this app
    already confirmed by tracking real channels (see CLAUDE.md's Handoff
    section for the article-export equivalent)."""

    def test_selects_only_tracked_competitors_scoped_to_the_project(self):
        with patch("services.competitors.competitors_store.db.fetch_all", return_value=[]) as fetch_all:
            competitors_store.export_competitors(7)

        sql, params = fetch_all.call_args[0]
        self.assertIn("project_id = %s", sql)
        self.assertIn("status = 'tracked'", sql)
        self.assertEqual(params, (7,))

    def test_exported_fields_exclude_columns_that_only_mean_something_locally(self):
        """id/project_id are local database identifiers - the importing side
        generates its own id and matches by the project_id given to the
        import request. last_scraped_at doesn't exist on the receiving app's
        competitors table at all, since it never scrapes."""
        for field in ("id", "project_id", "last_scraped_at"):
            self.assertNotIn(field, competitors_store.COMPETITOR_EXPORT_FIELDS)


class ExportCompetitorsRouteTests(unittest.TestCase):
    """GET /api/competitors/export - the companion to /api/articles/export
    for a competitor-mode project's handoff."""

    @classmethod
    def setUpClass(cls):
        main.app.dependency_overrides[auth.get_current_user] = _fake_get_current_user
        cls._patchers = [
            patch("services.auth.auth._enforce_csrf"),
            patch("services.auth.permissions_store.user_permission_keys", return_value={"competitors.view"}),
            patch("services.auth.permissions_store.user_is_full_access", return_value=True),
        ]
        for patcher in cls._patchers:
            patcher.start()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        main.app.dependency_overrides.clear()
        for patcher in cls._patchers:
            patcher.stop()

    def test_the_response_is_one_json_object_per_line(self):
        rows = [{"name": "Cafe Younes", "status": "tracked"}, {"name": "Deluxe", "status": "tracked"}]
        with patch("main.export_competitors", return_value=rows) as export:
            res = self.client.get("/api/competitors/export?project_id=5")

        export.assert_called_once_with(5)
        self.assertEqual(res.status_code, 200)
        self.assertIn("application/x-ndjson", res.headers["content-type"])
        self.assertIn("attachment", res.headers["content-disposition"])
        lines = [json.loads(line) for line in res.text.splitlines() if line.strip()]
        self.assertEqual(lines, rows)

    def test_project_id_is_required(self):
        res = self.client.get("/api/competitors/export")
        self.assertEqual(res.status_code, 422)


if __name__ == "__main__":
    unittest.main()
