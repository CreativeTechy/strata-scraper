import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_twitter


class ArticleFromTweetTests(unittest.TestCase):
    def test_normalizes_a_real_shaped_tweet(self):
        tweet = {
            "url": "https://x.com/nasa/status/123",
            "fullText": "We are go for launch.",
            "author": {"userName": "nasa", "name": "NASA"},
            "createdAt": "Mon Sep 01 12:00:00 +0000 2026",
        }
        article = apify_twitter._article_from_tweet(tweet, "https://x.com/hashtag/launch", "launch")
        self.assertEqual(article["url"], tweet["url"])
        self.assertEqual(article["text"], tweet["fullText"])
        self.assertEqual(article["title"], "@nasa")
        self.assertEqual(article["author"], "nasa")
        self.assertEqual(article["source"], "x.com/nasa")
        self.assertEqual(article["published"], tweet["createdAt"])
        self.assertEqual(article["source_url"], "https://x.com/hashtag/launch")
        self.assertEqual(article["source_name"], "launch")
        self.assertTrue(article["fetched_at"])

    def test_falls_back_to_twitterurl_and_text_keys(self):
        tweet = {"twitterUrl": "https://twitter.com/nasa/status/123", "text": "short form"}
        article = apify_twitter._article_from_tweet(tweet, "src", "name")
        self.assertEqual(article["url"], tweet["twitterUrl"])
        self.assertEqual(article["text"], "short form")

    def test_missing_url_is_rejected(self):
        self.assertIsNone(apify_twitter._article_from_tweet({"fullText": "text"}, "src", "name"))

    def test_missing_text_is_rejected(self):
        self.assertIsNone(apify_twitter._article_from_tweet({"url": "https://x.com/a/status/1"}, "src", "name"))

    def test_non_dict_tweet_is_rejected(self):
        self.assertIsNone(apify_twitter._article_from_tweet("not-a-dict", "src", "name"))

    def test_missing_author_falls_back_to_generic_title(self):
        tweet = {"url": "https://x.com/a/status/1", "fullText": "text"}
        article = apify_twitter._article_from_tweet(tweet, "src", "name")
        self.assertEqual(article["title"], "Tweet")
        self.assertIsNone(article["author"])
        self.assertEqual(article["source"], "x.com")


class ApifyTwitterSearchPostsTests(unittest.TestCase):
    def test_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_twitter, "run_actor_sync", return_value=[{"url": "u", "fullText": "t", "author": {"userName": "ev"}}]
        ):
            articles = apify_twitter.apify_twitter_search_posts("#ev", "https://x.com/hashtag/ev", "ev")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_twitter, "run_actor_sync", return_value=[{"fullText": "no url"}, {"url": "u2", "fullText": "t2"}]
        ):
            articles = apify_twitter.apify_twitter_search_posts("ev fires", "search-url", "ev fires")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_propagates_billing_error_from_run_actor_sync(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_twitter, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_twitter.apify_twitter_search_posts("#ev", "https://x.com/hashtag/ev", "ev")

    def test_uses_its_own_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_TWITTER_SEARCH_TIMEOUT_SECONDS", 90
        ), patch.object(apify_twitter, "run_actor_sync", return_value=[]) as mock_run:
            apify_twitter.apify_twitter_search_posts("#ev", "https://x.com/hashtag/ev", "ev")
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 90)


if __name__ == "__main__":
    unittest.main()
