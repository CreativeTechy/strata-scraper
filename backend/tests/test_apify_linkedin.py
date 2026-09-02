import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_linkedin


class LinkedinKindTests(unittest.TestCase):
    def test_company_url(self):
        self.assertEqual(apify_linkedin.linkedin_kind("https://www.linkedin.com/company/google"), "company")

    def test_profile_url(self):
        self.assertEqual(apify_linkedin.linkedin_kind("https://www.linkedin.com/in/satyanadella"), "profile")

    def test_search_url(self):
        self.assertEqual(
            apify_linkedin.linkedin_kind("https://www.linkedin.com/search/results/content/?keywords=ev"), "search"
        )

    def test_unrecognized_url_returns_none(self):
        self.assertIsNone(apify_linkedin.linkedin_kind("https://www.linkedin.com/feed/"))


class LinkedinSearchQueryTests(unittest.TestCase):
    def test_extracts_keywords_param(self):
        self.assertEqual(
            apify_linkedin.linkedin_search_query("https://www.linkedin.com/search/results/content/?keywords=ev+fires"),
            "ev fires",
        )

    def test_missing_param_returns_empty_string(self):
        self.assertEqual(apify_linkedin.linkedin_search_query("https://www.linkedin.com/search/results/content/"), "")


class ArticleFromPostTests(unittest.TestCase):
    """Normalizing one Apify dataset item - shape confirmed live against both
    harvestapi/linkedin-company-posts and harvestapi/linkedin-post-search."""

    def test_normalizes_a_real_shaped_post(self):
        post = {
            "linkedinUrl": "https://www.linkedin.com/posts/google_ask-a-scientist-activity-123-Z70e",
            "content": "We built our WeatherNext forecasting models...",
            "author": {"name": "Google", "linkedinUrl": "https://www.linkedin.com/company/google/posts"},
            "postedAt": {"date": "2026-09-01T19:34:09.511Z"},
        }
        article = apify_linkedin._article_from_post(post, "https://www.linkedin.com/company/google", "Google")
        self.assertEqual(article["url"], post["linkedinUrl"])
        self.assertEqual(article["text"], post["content"])
        self.assertEqual(article["title"], "Google")
        self.assertEqual(article["author"], "Google")
        self.assertEqual(article["published"], "2026-09-01T19:34:09.511Z")
        self.assertEqual(article["source_url"], "https://www.linkedin.com/company/google")
        self.assertEqual(article["source_name"], "Google")
        self.assertTrue(article["fetched_at"])

    def test_missing_url_is_rejected(self):
        self.assertIsNone(apify_linkedin._article_from_post({"content": "text"}, "src", "name"))

    def test_missing_content_is_rejected(self):
        self.assertIsNone(
            apify_linkedin._article_from_post({"linkedinUrl": "https://www.linkedin.com/posts/x"}, "src", "name")
        )

    def test_non_dict_post_is_rejected(self):
        self.assertIsNone(apify_linkedin._article_from_post("not-a-dict", "src", "name"))

    def test_missing_author_name_falls_back_to_generic_title(self):
        post = {"linkedinUrl": "https://www.linkedin.com/posts/x", "content": "text"}
        article = apify_linkedin._article_from_post(post, "src", "name")
        self.assertEqual(article["title"], "LinkedIn post")
        self.assertIsNone(article["author"])


class PagePostsAndSearchPostsTests(unittest.TestCase):
    def test_page_posts_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_linkedin, "run_actor_sync", return_value=[{"linkedinUrl": "u", "content": "c", "author": {"name": "Google"}}]
        ):
            articles = apify_linkedin.apify_linkedin_page_posts(
                "https://www.linkedin.com/company/google", "https://www.linkedin.com/company/google", "Google"
            )
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_search_posts_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_linkedin, "run_actor_sync", return_value=[{"content": "no url"}, {"linkedinUrl": "u2", "content": "c2"}]
        ):
            articles = apify_linkedin.apify_linkedin_search_posts("ev fires", "search-url", "ev fires")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_page_posts_propagates_billing_error(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_linkedin, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_linkedin.apify_linkedin_page_posts(
                    "https://www.linkedin.com/company/google", "https://www.linkedin.com/company/google", "Google"
                )

    def test_page_posts_uses_its_own_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_LINKEDIN_POSTS_TIMEOUT_SECONDS", 90
        ), patch.object(apify_linkedin, "run_actor_sync", return_value=[]) as mock_run:
            apify_linkedin.apify_linkedin_page_posts(
                "https://www.linkedin.com/company/google", "https://www.linkedin.com/company/google", "Google"
            )
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 90)

    def test_search_posts_uses_its_own_timeout(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_LINKEDIN_SEARCH_TIMEOUT_SECONDS", 150
        ), patch.object(apify_linkedin, "run_actor_sync", return_value=[]) as mock_run:
            apify_linkedin.apify_linkedin_search_posts("ev fires", "search-url", "ev fires")
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 150)


if __name__ == "__main__":
    unittest.main()
