import os
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import x_api
from scraper.spiders import source_rss


class XApiRecentHashtagTests(unittest.TestCase):
    def test_normalizes_recent_search_response(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "data": [
                {
                    "id": "123",
                    "text": "Coffee time #coffee",
                    "author_id": "42",
                    "created_at": "2026-09-23T12:00:00Z",
                }
            ],
            "includes": {
                "users": [{"id": "42", "username": "barista", "name": "Barista"}]
            },
        }
        with patch.object(config, "X_API_BEARER_TOKEN", "secret"), patch.object(
            x_api.requests, "get", return_value=response
        ) as get:
            articles = x_api.x_api_recent_hashtag_posts(
                "#coffee", "https://x.com/hashtag/coffee", "coffee"
            )

        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]["url"], "https://x.com/barista/status/123")
        self.assertEqual(articles[0]["text"], "Coffee time #coffee")
        self.assertEqual(articles[0]["author"], "barista")
        self.assertEqual(articles[0]["published"], "2026-09-23T12:00:00Z")
        self.assertEqual(get.call_args.kwargs["params"]["query"], "#coffee")
        self.assertEqual(get.call_args.kwargs["params"]["max_results"], 10)
        self.assertEqual(get.call_args.kwargs["headers"], {"Authorization": "Bearer secret"})

    def test_missing_author_uses_stable_status_redirect(self):
        articles = x_api._articles_from_response(
            {"data": [{"id": "123", "text": "#coffee"}]}, "source", "coffee"
        )
        self.assertEqual(articles[0]["url"], "https://x.com/i/status/123")
        self.assertEqual(articles[0]["title"], "Tweet")

    def test_malformed_posts_are_dropped(self):
        articles = x_api._articles_from_response(
            {"data": [{"id": "1"}, {"text": "missing id"}, "bad"]}, "source", "coffee"
        )
        self.assertEqual(articles, [])

    def test_unconfigured_or_failed_request_returns_empty(self):
        with patch.object(config, "X_API_BEARER_TOKEN", ""):
            self.assertEqual(x_api.x_api_recent_hashtag_posts("coffee", "source", "coffee"), [])
        with patch.object(config, "X_API_BEARER_TOKEN", "secret"), patch.object(
            x_api.requests, "get", side_effect=RuntimeError("network")
        ):
            self.assertEqual(x_api.x_api_recent_hashtag_posts("coffee", "source", "coffee"), [])


class XApiSpiderPriorityTests(unittest.IsolatedAsyncioTestCase):
    async def test_official_results_prevent_apify_hashtag_call(self):
        official_article = {
            "url": "https://x.com/barista/status/123",
            "title": "@barista",
            "text": "#coffee",
        }
        record = {
            "url": "https://x.com/hashtag/coffee",
            "name": "coffee",
            "source_type": "hashtag",
            "enabled": True,
        }
        with patch.object(source_rss, "load_source_records", return_value=[record]), patch.object(
            source_rss.config, "reddit_oauth_configured", return_value=False
        ), patch.object(source_rss.config, "x_api_configured", return_value=True), patch.object(
            source_rss.config, "google_cse_configured", return_value=False
        ), patch.object(source_rss.config, "apify_configured", return_value=True), patch.object(
            source_rss, "x_api_recent_hashtag_posts", return_value=[official_article]
        ) as official, patch.object(source_rss, "apify_twitter_search_posts") as apify:
            items = [item async for item in source_rss.SourceRssSpider().start()]

        official.assert_called_once_with("coffee", record["url"], "coffee")
        apify.assert_not_called()
        self.assertIn(official_article, items)


if __name__ == "__main__":
    unittest.main()
