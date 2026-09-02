import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_reddit


class ArticleFromPostTests(unittest.TestCase):
    def test_normalizes_a_real_shaped_post(self):
        post = {
            "url": "https://www.reddit.com/r/nasa/comments/abc/we_are_go/",
            "title": "We are go for launch",
            "body": "Full launch thread text.",
            "username": "nasa_fan",
            "communityName": "nasa",
            "createdAt": "2026-09-01T12:00:00.000Z",
        }
        article = apify_reddit._article_from_post(post, "https://www.reddit.com/r/nasa", "nasa")
        self.assertEqual(article["url"], post["url"])
        self.assertEqual(article["text"], post["body"])
        self.assertEqual(article["title"], post["title"])
        self.assertEqual(article["author"], "nasa_fan")
        self.assertEqual(article["source"], "reddit.com/r/nasa")
        self.assertEqual(article["published"], post["createdAt"])
        self.assertEqual(article["source_url"], "https://www.reddit.com/r/nasa")
        self.assertEqual(article["source_name"], "nasa")
        self.assertTrue(article["fetched_at"])

    def test_comment_falls_back_to_body_and_generated_title(self):
        comment = {
            "url": "https://www.reddit.com/r/nasa/comments/abc/we_are_go/def/",
            "body": "Great news!",
            "username": "commenter",
            "communityName": "r/nasa",
        }
        article = apify_reddit._article_from_post(comment, "src", "name")
        self.assertEqual(article["text"], "Great news!")
        self.assertEqual(article["title"], "Comment by u/commenter")
        self.assertEqual(article["source"], "reddit.com/r/nasa")

    def test_missing_url_is_rejected(self):
        self.assertIsNone(apify_reddit._article_from_post({"body": "text"}, "src", "name"))

    def test_missing_text_is_rejected(self):
        self.assertIsNone(apify_reddit._article_from_post({"url": "https://www.reddit.com/r/x/comments/1"}, "src", "name"))

    def test_non_dict_post_is_rejected(self):
        self.assertIsNone(apify_reddit._article_from_post("not-a-dict", "src", "name"))

    def test_missing_username_falls_back_to_generic_title(self):
        post = {"url": "https://www.reddit.com/r/x/comments/1", "body": "text"}
        article = apify_reddit._article_from_post(post, "src", "name")
        self.assertEqual(article["title"], "Reddit post")
        self.assertIsNone(article["author"])
        self.assertEqual(article["source"], "reddit.com")


class SearchQueryTests(unittest.TestCase):
    def test_extracts_query_from_search_url(self):
        self.assertEqual(apify_reddit._search_query("https://www.reddit.com/search?q=stories+coffee+shop"), "stories coffee shop")

    def test_non_search_url_returns_none(self):
        self.assertIsNone(apify_reddit._search_query("https://www.reddit.com/r/nasa"))
        self.assertIsNone(apify_reddit._search_query("https://www.reddit.com/user/someone"))

    def test_search_url_with_empty_query_returns_none(self):
        self.assertIsNone(apify_reddit._search_query("https://www.reddit.com/search?q="))


class ApifyRedditPostsTests(unittest.TestCase):
    def test_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "run_actor_sync", return_value=[{"url": "u", "body": "t", "username": "someone"}]
        ):
            articles = apify_reddit.apify_reddit_posts("https://www.reddit.com/r/nasa", "https://www.reddit.com/r/nasa", "nasa")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "run_actor_sync", return_value=[{"body": "no url"}, {"url": "u2", "body": "t2"}]
        ):
            articles = apify_reddit.apify_reddit_posts("https://www.reddit.com/search?q=ev", "search-url", "ev")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_propagates_billing_error(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_reddit.apify_reddit_posts("https://www.reddit.com/r/nasa", "https://www.reddit.com/r/nasa", "nasa")

    def test_subreddit_url_uses_start_urls_payload(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_reddit.apify_reddit_posts("https://www.reddit.com/r/nasa", "https://www.reddit.com/r/nasa", "nasa")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["startUrls"], [{"url": "https://www.reddit.com/r/nasa"}])
            self.assertNotIn("searches", payload)

    def test_search_url_uses_searches_payload_not_start_urls(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_reddit.apify_reddit_posts("https://www.reddit.com/search?q=stories+coffee+shop", "search-url", "stories coffee shop")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["searches"], ["stories coffee shop"])
            self.assertNotIn("startUrls", payload)

    def test_uses_the_dedicated_reddit_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_REDDIT_SEARCH_TIMEOUT_SECONDS", 300
        ), patch.object(apify_reddit, "run_actor_sync", return_value=[]) as mock_run:
            apify_reddit.apify_reddit_posts("https://www.reddit.com/r/nasa", "https://www.reddit.com/r/nasa", "nasa")
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 300)


if __name__ == "__main__":
    unittest.main()
