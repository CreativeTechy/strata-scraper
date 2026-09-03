import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_facebook


class FacebookKindTests(unittest.TestCase):
    def test_group_url(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/groups/evfires"), "group")

    def test_share_group_link_is_group(self):
        # Confirmed live: facebook.com/share/g/<code> 302-redirects straight
        # to facebook.com/groups/<id>, and the groups actor follows it and
        # returns real posts - unlike the "page" default, which doesn't.
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/share/g/1Ey5SPwCGy/"), "group")
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/share/g/1Ey5SPwCGy"), "group")

    def test_search_url(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/search/top/?q=ev+fires"), "search")

    def test_profile_php_url(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/profile.php?id=100012345"), "profile")

    def test_people_url(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/people/John-Doe/pfbid123"), "profile")

    def test_bare_vanity_url_defaults_to_page(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/CocaCola"), "page")

    def test_fb_kind_marker_resolves_to_profile(self):
        self.assertEqual(apify_facebook.facebook_kind("https://www.facebook.com/johndoe?fb_kind=profile"), "profile")

    def test_unrecognized_url_returns_none(self):
        self.assertIsNone(apify_facebook.facebook_kind("https://www.facebook.com/"))


class FacebookSearchQueryTests(unittest.TestCase):
    def test_extracts_q_param(self):
        self.assertEqual(apify_facebook.facebook_search_query("https://www.facebook.com/search/top/?q=ev+fires"), "ev fires")

    def test_missing_param_returns_empty_string(self):
        self.assertEqual(apify_facebook.facebook_search_query("https://www.facebook.com/search/top/"), "")


class ActorTargetUrlTests(unittest.TestCase):
    def test_strips_fb_kind_marker(self):
        cleaned = apify_facebook._actor_target_url("https://www.facebook.com/johndoe?fb_kind=profile")
        self.assertEqual(cleaned, "https://www.facebook.com/johndoe")

    def test_leaves_other_query_params_untouched(self):
        cleaned = apify_facebook._actor_target_url("https://www.facebook.com/profile.php?id=123")
        self.assertEqual(cleaned, "https://www.facebook.com/profile.php?id=123")


class ArticleFromPostTests(unittest.TestCase):
    def test_normalizes_a_post_with_a_direct_url(self):
        post = {
            "url": "https://www.facebook.com/CocaCola/posts/123",
            "text": "New flavor dropping soon.",
            "pageName": "Coca-Cola",
            "time": "2026-09-01T12:00:00.000Z",
        }
        article = apify_facebook._article_from_post(post, "https://www.facebook.com/CocaCola", "Coca-Cola")
        self.assertEqual(article["url"], post["url"])
        self.assertEqual(article["text"], post["text"])
        self.assertEqual(article["title"], "Coca-Cola")
        self.assertEqual(article["author"], "Coca-Cola")
        self.assertEqual(article["published"], "2026-09-01T12:00:00.000Z")
        self.assertEqual(article["source"], "facebook.com")
        self.assertEqual(article["source_url"], "https://www.facebook.com/CocaCola")
        self.assertEqual(article["source_name"], "Coca-Cola")
        self.assertTrue(article["fetched_at"])

    def test_missing_url_is_rejected(self):
        self.assertIsNone(apify_facebook._article_from_post({"text": "no url"}, "src", "name"))

    def test_missing_text_is_rejected(self):
        self.assertIsNone(apify_facebook._article_from_post({"url": "https://www.facebook.com/x/posts/1"}, "src", "name"))

    def test_non_dict_post_is_rejected(self):
        self.assertIsNone(apify_facebook._article_from_post("not-a-dict", "src", "name"))

    def test_falls_back_to_default_title_when_no_author_found(self):
        post = {"url": "https://www.facebook.com/x/posts/1", "text": "text"}
        article = apify_facebook._article_from_post(post, "src", "name")
        self.assertEqual(article["title"], "Facebook post")
        self.assertIsNone(article["author"])

    def test_normalizes_apify_posts_scraper_shape(self):
        # Confirmed live against apify/facebook-posts-scraper (page kind) and
        # apify/facebook-groups-scraper (group kind) - both use this exact
        # shape: url/text/time(ISO)/user.name.
        post = {
            "url": "https://www.facebook.com/NASA/posts/123",
            "text": "Red Moon over Louisiana",
            "time": "2026-09-02T20:52:09.000Z",
            "timestamp": 1788382329,
            "user": {"name": "NASA - National Aeronautics and Space Administration"},
        }
        article = apify_facebook._article_from_post(post, "src", "name")
        self.assertEqual(article["author"], "NASA - National Aeronautics and Space Administration")
        self.assertEqual(article["published"], "2026-09-02T20:52:09.000Z")

    def test_normalizes_cleansyntax_profile_posts_scraper_shape(self):
        # Confirmed live against cleansyntax/facebook-profile-posts-scraper
        # (profile kind) - message/author.name/timestamp(Unix epoch int),
        # no ISO `time` field at all.
        post = {
            "url": "https://www.facebook.com/NASA/posts/123",
            "message": "Red Moon over Louisiana",
            "timestamp": 1788382329,
            "author": {"name": "NASA - National Aeronautics and Space Administration"},
        }
        article = apify_facebook._article_from_post(post, "src", "name")
        self.assertEqual(article["text"], "Red Moon over Louisiana")
        self.assertEqual(article["author"], "NASA - National Aeronautics and Space Administration")
        self.assertEqual(article["published"], "2026-09-02T20:52:09+00:00")

    def test_pages_scraper_shape_prefers_pagename_alias(self):
        # apify/facebook-posts-scraper's page kind uses pageName directly
        # rather than a nested user/author dict for the page itself.
        post = {"url": "u", "text": "t", "pageName": "NASA"}
        article = apify_facebook._article_from_post(post, "src", "name")
        self.assertEqual(article["author"], "NASA")


class PublishedValueTests(unittest.TestCase):
    def test_prefers_iso_time_field(self):
        self.assertEqual(
            apify_facebook._published_value({"time": "2026-09-01T00:00:00.000Z", "timestamp": 123}),
            "2026-09-01T00:00:00.000Z",
        )

    def test_converts_epoch_timestamp_to_iso(self):
        self.assertEqual(apify_facebook._published_value({"timestamp": 1735689600}), "2025-01-01T00:00:00+00:00")

    def test_non_numeric_timestamp_passed_through(self):
        self.assertEqual(apify_facebook._published_value({"timestamp": "not-a-number"}), "not-a-number")

    def test_missing_date_fields_returns_none(self):
        self.assertIsNone(apify_facebook._published_value({}))


class ActorFunctionTests(unittest.TestCase):
    def test_page_posts_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[{"url": "u", "text": "t"}]
        ):
            articles = apify_facebook.apify_facebook_page_posts("https://www.facebook.com/CocaCola", "src", "name")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_group_posts_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[{"text": "no url"}, {"url": "u2", "text": "t2"}]
        ):
            articles = apify_facebook.apify_facebook_group_posts("https://www.facebook.com/groups/x", "src", "name")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")

    def test_profile_posts_propagates_billing_error(self):
        from scraper.apify_common import ApifyBillingError

        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", side_effect=ApifyBillingError("no subscription")
        ):
            with self.assertRaises(ApifyBillingError):
                apify_facebook.apify_facebook_profile_posts("https://www.facebook.com/people/x/1", "src", "name")

    def test_page_posts_uses_its_own_timeout_and_actor(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_FACEBOOK_PAGES_TIMEOUT_SECONDS", 90
        ), patch.object(config, "APIFY_FACEBOOK_PAGES_ACTOR", "some/actor"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_page_posts("https://www.facebook.com/CocaCola", "src", "name")
            self.assertEqual(mock_run.call_args.kwargs["timeout"], 90)
            self.assertEqual(mock_run.call_args.args[0], "some/actor")

    def test_page_posts_strips_fb_kind_marker_from_target_url(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_page_posts("https://www.facebook.com/johndoe?fb_kind=profile", "src", "name")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["startUrls"], [{"url": "https://www.facebook.com/johndoe"}])

    def test_search_posts_uses_keyword_search_endpoint(self):
        # cleansyntax/facebook-profile-posts-scraper's keyword-search
        # endpoint, confirmed live - the original apify/facebook-search-
        # scraper actor was a Page directory finder, not a post search, and
        # could never have produced an article.
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_search_posts("ev fires", "src", "name")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["endpoint"], "search_posts_by_keyword")
            self.assertEqual(payload["keywords_text"], "ev fires")
            self.assertIn("max_posts", payload)

    def test_search_posts_normalizes_real_dataset_shape(self):
        # Confirmed live against cleansyntax/facebook-profile-posts-scraper's
        # search_posts_by_keyword endpoint - same url/message/timestamp/
        # author.name shape as the profile-posts endpoint.
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook,
            "run_actor_sync",
            return_value=[
                {
                    "url": "https://www.facebook.com/groups/465434043571359/posts/28513672454987475/",
                    "message": "AUDI S3 QUATTRO V4 2016",
                    "timestamp": 1787887775,
                    "author": {"name": "Sami Chahine"},
                }
            ],
        ):
            articles = apify_facebook.apify_facebook_search_posts("cars for sale lebanon", "src", "name")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["author"], "Sami Chahine")
            self.assertEqual(articles[0]["text"], "AUDI S3 QUATTRO V4 2016")

    def test_profile_posts_uses_endpoint_and_urls_text(self):
        # cleansyntax/facebook-profile-posts-scraper's real input shape,
        # confirmed live - not startUrls/resultsLimit.
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_profile_posts("https://www.facebook.com/people/x/1", "src", "name")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["endpoint"], "profile_posts_by_url")
            self.assertEqual(payload["urls_text"], "https://www.facebook.com/people/x/1")
            self.assertIn("max_posts", payload)

    def test_profile_posts_uses_its_own_max_posts_not_the_shared_one(self):
        # Confirmed live: this actor is far slower per post than the other
        # three, so it gets its own (smaller) cap rather than
        # APIFY_FACEBOOK_MAX_POSTS.
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_FACEBOOK_PROFILE_MAX_POSTS", 5
        ), patch.object(config, "APIFY_FACEBOOK_MAX_POSTS", 20), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_profile_posts("https://www.facebook.com/people/x/1", "src", "name")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["max_posts"], 5)

    def test_profile_posts_strips_fb_kind_marker(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_facebook, "run_actor_sync", return_value=[]
        ) as mock_run:
            apify_facebook.apify_facebook_profile_posts("https://www.facebook.com/johndoe?fb_kind=profile", "src", "name")
            payload = mock_run.call_args.args[1]
            self.assertEqual(payload["urls_text"], "https://www.facebook.com/johndoe")


if __name__ == "__main__":
    unittest.main()
