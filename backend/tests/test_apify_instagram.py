import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_instagram


class InstagramKindTests(unittest.TestCase):
    def test_profile_url(self):
        self.assertEqual(apify_instagram.instagram_kind("https://www.instagram.com/nasa/"), "profile")

    def test_hashtag_url(self):
        self.assertEqual(apify_instagram.instagram_kind("https://www.instagram.com/explore/tags/evfires/"), "hashtag")

    def test_search_url(self):
        self.assertEqual(
            apify_instagram.instagram_kind("https://www.instagram.com/explore/search/keyword/?q=ev+fires"), "search"
        )

    def test_reserved_path_returns_none(self):
        self.assertIsNone(apify_instagram.instagram_kind("https://www.instagram.com/explore/"))

    def test_empty_path_returns_none(self):
        self.assertIsNone(apify_instagram.instagram_kind("https://www.instagram.com/"))


class InstagramSearchQueryTests(unittest.TestCase):
    def test_extracts_q_param(self):
        self.assertEqual(
            apify_instagram.instagram_search_query("https://www.instagram.com/explore/search/keyword/?q=ev+fires"),
            "ev fires",
        )

    def test_missing_param_returns_empty_string(self):
        self.assertEqual(
            apify_instagram.instagram_search_query("https://www.instagram.com/explore/search/keyword/"), ""
        )


class InstagramHashtagTests(unittest.TestCase):
    def test_extracts_tag(self):
        self.assertEqual(
            apify_instagram.instagram_hashtag("https://www.instagram.com/explore/tags/evfires/"), "evfires"
        )

    def test_non_hashtag_url_returns_empty_string(self):
        self.assertEqual(apify_instagram.instagram_hashtag("https://www.instagram.com/nasa/"), "")


class ArticleFromPostTests(unittest.TestCase):
    def test_normalizes_a_post_with_a_direct_url(self):
        post = {
            "url": "https://www.instagram.com/p/C1234/",
            "caption": "We are go for launch.",
            "ownerUsername": "nasa",
            "timestamp": "2026-09-01T12:00:00.000Z",
        }
        article = apify_instagram._article_from_post(post, "https://www.instagram.com/nasa/", "NASA")
        self.assertEqual(article["url"], post["url"])
        self.assertEqual(article["text"], post["caption"])
        self.assertEqual(article["title"], "@nasa")
        self.assertEqual(article["author"], "nasa")
        self.assertEqual(article["published"], "2026-09-01T12:00:00.000Z")
        self.assertEqual(article["source"], "instagram.com/nasa")
        self.assertEqual(article["source_url"], "https://www.instagram.com/nasa/")
        self.assertEqual(article["source_name"], "NASA")
        self.assertTrue(article["fetched_at"])

    def test_builds_url_from_shortcode_when_no_direct_url(self):
        post = {"shortCode": "C1234", "ownerUsername": "nasa", "caption": "Great news!"}
        article = apify_instagram._article_from_post(post, "src", "name")
        self.assertEqual(article["url"], "https://www.instagram.com/p/C1234/")

    def test_missing_url_and_shortcode_is_rejected(self):
        self.assertIsNone(apify_instagram._article_from_post({"caption": "no url"}, "src", "name"))

    def test_missing_text_is_rejected(self):
        self.assertIsNone(apify_instagram._article_from_post({"url": "https://www.instagram.com/p/1/"}, "src", "name"))

    def test_non_dict_post_is_rejected(self):
        self.assertIsNone(apify_instagram._article_from_post("not-a-dict", "src", "name"))

    def test_missing_username_falls_back_to_generic_title(self):
        post = {"url": "https://www.instagram.com/p/1/", "caption": "text"}
        article = apify_instagram._article_from_post(post, "src", "name")
        self.assertEqual(article["title"], "Instagram post")
        self.assertIsNone(article["author"])
        self.assertEqual(article["source"], "instagram.com")


class ProfileHashtagAndSearchPostsTests(unittest.TestCase):
    def test_profile_posts_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_instagram, "run_actor_sync", return_value=[{"url": "u", "caption": "t", "ownerUsername": "nasa"}]
        ):
            articles = apify_instagram.apify_instagram_profile_posts(
                "https://www.instagram.com/nasa/", "https://www.instagram.com/nasa/", "NASA"
            )
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_hashtag_posts_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_instagram, "run_actor_sync", return_value=[{"caption": "no url"}, {"url": "u2", "caption": "t2"}]
        ):
            articles = apify_instagram.apify_instagram_hashtag_posts(
                "https://www.instagram.com/explore/tags/evfires/", "src", "evfires"
            )
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_profile_posts_propagates_billing_error(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_instagram, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_instagram.apify_instagram_profile_posts(
                    "https://www.instagram.com/nasa/", "https://www.instagram.com/nasa/", "NASA"
                )

    def test_profile_posts_uses_its_own_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_INSTAGRAM_TIMEOUT_SECONDS", 90
        ), patch.object(apify_instagram, "run_actor_sync", return_value=[]) as mock_run:
            apify_instagram.apify_instagram_profile_posts(
                "https://www.instagram.com/nasa/", "https://www.instagram.com/nasa/", "NASA"
            )
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 90)

    def test_profile_posts_uses_direct_urls(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_instagram, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_instagram.apify_instagram_profile_posts(
                "https://www.instagram.com/nasa/", "https://www.instagram.com/nasa/", "NASA"
            )
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["directUrls"], ["https://www.instagram.com/nasa/"])
            self.assertEqual(payload["resultsType"], "posts")

    def test_search_posts_uses_search_input(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_instagram, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_instagram.apify_instagram_search_posts("ev fires", "search-url", "ev fires")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["search"], "ev fires")
            self.assertEqual(payload["searchType"], "hashtag")


if __name__ == "__main__":
    unittest.main()
