import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_threads


class ThreadsKindTests(unittest.TestCase):
    def test_profile_url(self):
        self.assertEqual(apify_threads.threads_kind("https://www.threads.com/@nasa"), "profile")

    def test_search_url(self):
        self.assertEqual(apify_threads.threads_kind("https://www.threads.com/search?q=ev+fires"), "search")

    def test_unrecognized_url_returns_none(self):
        self.assertIsNone(apify_threads.threads_kind("https://www.threads.com/feed/"))


class ThreadsSearchQueryTests(unittest.TestCase):
    def test_extracts_q_param(self):
        self.assertEqual(apify_threads.threads_search_query("https://www.threads.com/search?q=ev+fires"), "ev fires")

    def test_missing_param_returns_empty_string(self):
        self.assertEqual(apify_threads.threads_search_query("https://www.threads.com/search"), "")


class ArticleFromPostTests(unittest.TestCase):
    def test_normalizes_a_post_with_a_direct_url(self):
        post = {
            "url": "https://www.threads.com/@nasa/post/C1234",
            "text": "We are go for launch.",
            "username": "nasa",
            "fullName": "NASA",
            "timestamp": "2026-09-01T12:00:00.000Z",
        }
        article = apify_threads._article_from_post(post, "https://www.threads.com/@nasa", "NASA")
        self.assertEqual(article["url"], post["url"])
        self.assertEqual(article["text"], post["text"])
        self.assertEqual(article["title"], "@nasa")
        self.assertEqual(article["author"], "nasa")
        self.assertEqual(article["published"], "2026-09-01T12:00:00.000Z")
        self.assertEqual(article["source"], "threads.com/@nasa")
        self.assertEqual(article["source_url"], "https://www.threads.com/@nasa")
        self.assertEqual(article["source_name"], "NASA")
        self.assertTrue(article["fetched_at"])

    def test_builds_url_from_username_and_code_when_no_direct_url(self):
        post = {"code": "C1234", "username": "nasa", "text": "Great news!"}
        article = apify_threads._article_from_post(post, "src", "name")
        self.assertEqual(article["url"], "https://www.threads.com/@nasa/post/C1234")

    def test_missing_url_and_code_is_rejected(self):
        self.assertIsNone(apify_threads._article_from_post({"text": "no url"}, "src", "name"))

    def test_missing_text_is_rejected(self):
        self.assertIsNone(apify_threads._article_from_post({"url": "https://www.threads.com/@nasa/post/1"}, "src", "name"))

    def test_non_dict_post_is_rejected(self):
        self.assertIsNone(apify_threads._article_from_post("not-a-dict", "src", "name"))

    def test_missing_username_falls_back_to_full_name_title(self):
        post = {"url": "https://www.threads.com/@nasa/post/1", "text": "text", "fullName": "NASA"}
        article = apify_threads._article_from_post(post, "src", "name")
        self.assertEqual(article["title"], "NASA")
        self.assertEqual(article["author"], "NASA")
        self.assertEqual(article["source"], "threads.com")


class ProfilePostsAndSearchPostsTests(unittest.TestCase):
    def test_profile_posts_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_threads, "run_actor_sync", return_value=[{"url": "u", "text": "t", "username": "nasa"}]
        ):
            articles = apify_threads.apify_threads_profile_posts("nasa", "https://www.threads.com/@nasa", "NASA")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_search_posts_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_threads, "run_actor_sync", return_value=[{"text": "no url"}, {"url": "u2", "text": "t2"}]
        ):
            articles = apify_threads.apify_threads_search_posts("ev fires", "search-url", "ev fires")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_profile_posts_propagates_billing_error(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_threads, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_threads.apify_threads_profile_posts("nasa", "https://www.threads.com/@nasa", "NASA")

    def test_profile_posts_uses_its_own_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_THREADS_TIMEOUT_SECONDS", 90
        ), patch.object(apify_threads, "run_actor_sync", return_value=[]) as mock_run:
            apify_threads.apify_threads_profile_posts("nasa", "https://www.threads.com/@nasa", "NASA")
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 90)

    def test_profile_posts_uses_posts_mode(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_threads, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_threads.apify_threads_profile_posts("nasa", "https://www.threads.com/@nasa", "NASA")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["mode"], "posts")
            self.assertEqual(payload["usernames"], ["nasa"])

    def test_search_posts_uses_search_mode(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_threads, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_threads.apify_threads_search_posts("ev fires", "search-url", "ev fires")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["mode"], "search")
            self.assertEqual(payload["searchQueries"], ["ev fires"])


if __name__ == "__main__":
    unittest.main()
