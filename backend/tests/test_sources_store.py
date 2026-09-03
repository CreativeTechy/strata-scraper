import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from services.sources import sources_store


class DeriveRedditUrlTests(unittest.TestCase):
    def test_full_url_is_passed_through_unchanged(self):
        self.assertEqual(
            sources_store._derive_reddit_url("https://www.reddit.com/r/test/"),
            "https://www.reddit.com/r/test",
        )

    def test_full_url_strips_query_string(self):
        self.assertEqual(
            sources_store._derive_reddit_url("https://www.reddit.com/r/test?sort=new"),
            "https://www.reddit.com/r/test",
        )

    def test_non_reddit_url_is_rejected(self):
        self.assertEqual(sources_store._derive_reddit_url("https://example.com/r/test"), "")

    def test_r_prefix_builds_subreddit_url(self):
        self.assertEqual(sources_store._derive_reddit_url("r/test"), "https://www.reddit.com/r/test")

    def test_u_prefix_builds_user_url(self):
        self.assertEqual(sources_store._derive_reddit_url("u/someone"), "https://www.reddit.com/user/someone")

    def test_user_prefix_builds_user_url(self):
        self.assertEqual(sources_store._derive_reddit_url("user/someone"), "https://www.reddit.com/user/someone")

    def test_bare_word_defaults_to_subreddit(self):
        self.assertEqual(sources_store._derive_reddit_url("test"), "https://www.reddit.com/r/test")

    def test_bare_word_with_user_kind_builds_user_url(self):
        self.assertEqual(sources_store._derive_reddit_url("someone", kind="user"), "https://www.reddit.com/user/someone")

    def test_bare_word_with_search_kind_builds_search_url(self):
        self.assertEqual(
            sources_store._derive_reddit_url("electric vehicles", kind="search"),
            "https://www.reddit.com/search?q=electric+vehicles",
        )

    def test_explicit_prefix_wins_over_kind_hint(self):
        # r/ prefix is unambiguous, so an (incorrect) kind="user" hint must not override it.
        self.assertEqual(sources_store._derive_reddit_url("r/test", kind="user"), "https://www.reddit.com/r/test")

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_reddit_url(""), "")

    def test_full_search_url_keeps_q_and_drops_reddits_own_tracking_params(self):
        # Reddit's search UI appends cId/iId/type alongside the real query -
        # the whole query string used to be stripped (see the "full url"
        # tests above), which silently threw away the search term itself.
        url = (
            "https://www.reddit.com/search/?q=donald+news&type=posts"
            "&cId=f6e3b9b2-4518-4f92-9e9f-01a1a0a48c49&iId=e437d424-b0ac-4631-bd4d-b66d199c2e1b"
        )
        self.assertEqual(sources_store._derive_reddit_url(url), "https://www.reddit.com/search?q=donald+news")

    def test_full_search_url_without_q_is_rejected(self):
        self.assertEqual(sources_store._derive_reddit_url("https://www.reddit.com/search?type=posts"), "")


class DeriveTelegramUrlTests(unittest.TestCase):
    def test_full_channel_url_normalizes_to_s_preview(self):
        self.assertEqual(sources_store._derive_telegram_url("https://t.me/somechannel"), "https://t.me/s/somechannel")

    def test_full_s_preview_url_is_kept(self):
        self.assertEqual(sources_store._derive_telegram_url("https://t.me/s/somechannel"), "https://t.me/s/somechannel")

    def test_at_handle_form(self):
        self.assertEqual(sources_store._derive_telegram_url("@somechannel"), "https://t.me/s/somechannel")

    def test_bare_handle_form(self):
        self.assertEqual(sources_store._derive_telegram_url("somechannel"), "https://t.me/s/somechannel")

    def test_non_telegram_url_is_rejected(self):
        self.assertEqual(sources_store._derive_telegram_url("https://example.com/somechannel"), "")

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_telegram_url(""), "")


class DeriveLinkedinUrlTests(unittest.TestCase):
    def test_full_company_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_linkedin_url("https://www.linkedin.com/company/google/"),
            "https://www.linkedin.com/company/google",
        )

    def test_full_profile_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_linkedin_url("https://www.linkedin.com/in/satyanadella/"),
            "https://www.linkedin.com/in/satyanadella",
        )

    def test_full_search_url_keeps_keywords_param(self):
        self.assertEqual(
            sources_store._derive_linkedin_url(
                "https://www.linkedin.com/search/results/content/?keywords=ev+fires&origin=GLOBAL_SEARCH_HEADER"
            ),
            "https://www.linkedin.com/search/results/content/?keywords=ev+fires",
        )

    def test_full_search_url_without_keywords_is_rejected(self):
        self.assertEqual(
            sources_store._derive_linkedin_url("https://www.linkedin.com/search/results/content/?origin=x"), ""
        )

    def test_non_linkedin_url_is_rejected(self):
        self.assertEqual(sources_store._derive_linkedin_url("https://example.com/company/google"), "")

    def test_unrecognized_linkedin_path_is_rejected(self):
        self.assertEqual(sources_store._derive_linkedin_url("https://www.linkedin.com/feed/"), "")

    def test_bare_word_defaults_to_company(self):
        self.assertEqual(sources_store._derive_linkedin_url("google"), "https://www.linkedin.com/company/google")

    def test_bare_word_with_profile_kind(self):
        self.assertEqual(
            sources_store._derive_linkedin_url("satyanadella", kind="profile"), "https://www.linkedin.com/in/satyanadella"
        )

    def test_bare_phrase_with_search_kind(self):
        self.assertEqual(
            sources_store._derive_linkedin_url("electric vehicles", kind="search"),
            "https://www.linkedin.com/search/results/content/?keywords=electric+vehicles",
        )

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_linkedin_url(""), "")


class DeriveThreadsUrlTests(unittest.TestCase):
    def test_full_profile_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_threads_url("https://www.threads.com/@nasa/"),
            "https://www.threads.com/@nasa",
        )

    def test_threads_net_host_is_canonicalized_to_threads_com(self):
        self.assertEqual(
            sources_store._derive_threads_url("https://www.threads.net/@nasa"),
            "https://www.threads.com/@nasa",
        )

    def test_full_search_url_keeps_q_param(self):
        self.assertEqual(
            sources_store._derive_threads_url("https://www.threads.com/search?q=ev+fires&serp_type=default"),
            "https://www.threads.com/search?q=ev+fires",
        )

    def test_full_search_url_without_q_is_rejected(self):
        self.assertEqual(sources_store._derive_threads_url("https://www.threads.com/search?serp_type=default"), "")

    def test_non_threads_url_is_rejected(self):
        self.assertEqual(sources_store._derive_threads_url("https://example.com/@nasa"), "")

    def test_unrecognized_threads_path_is_rejected(self):
        self.assertEqual(sources_store._derive_threads_url("https://www.threads.com/feed/"), "")

    def test_bare_word_defaults_to_profile(self):
        self.assertEqual(sources_store._derive_threads_url("nasa"), "https://www.threads.com/@nasa")

    def test_bare_word_with_at_prefix(self):
        self.assertEqual(sources_store._derive_threads_url("@nasa"), "https://www.threads.com/@nasa")

    def test_bare_phrase_with_search_kind(self):
        self.assertEqual(
            sources_store._derive_threads_url("electric vehicles", kind="search"),
            "https://www.threads.com/search?q=electric+vehicles",
        )

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_threads_url(""), "")


class DeriveFacebookUrlTests(unittest.TestCase):
    def test_full_group_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/groups/evfires/"),
            "https://www.facebook.com/groups/evfires",
        )

    def test_fb_com_host_is_canonicalized_to_facebook_com(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://fb.com/groups/evfires"),
            "https://www.facebook.com/groups/evfires",
        )

    def test_full_search_url_keeps_q_param(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/search/top/?q=ev+fires&epa=SEARCH_BOX"),
            "https://www.facebook.com/search/top/?q=ev+fires",
        )

    def test_full_search_url_without_q_is_rejected(self):
        self.assertEqual(sources_store._derive_facebook_url("https://www.facebook.com/search/top/?epa=SEARCH_BOX"), "")

    def test_profile_php_url_keeps_id_param(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/profile.php?id=100012345&sk=about"),
            "https://www.facebook.com/profile.php?id=100012345",
        )

    def test_profile_php_url_without_id_is_rejected(self):
        self.assertEqual(sources_store._derive_facebook_url("https://www.facebook.com/profile.php?sk=about"), "")

    def test_people_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/people/John-Doe/pfbid123/"),
            "https://www.facebook.com/people/John-Doe/pfbid123",
        )

    def test_bare_vanity_url_defaults_to_page(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/CocaCola"),
            "https://www.facebook.com/CocaCola",
        )

    def test_bare_vanity_url_with_profile_kind_is_marked(self):
        self.assertEqual(
            sources_store._derive_facebook_url("https://www.facebook.com/johndoe", kind="profile"),
            "https://www.facebook.com/johndoe?fb_kind=profile",
        )

    def test_non_facebook_url_is_rejected(self):
        self.assertEqual(sources_store._derive_facebook_url("https://example.com/groups/evfires"), "")

    def test_bare_word_defaults_to_page(self):
        self.assertEqual(sources_store._derive_facebook_url("CocaCola"), "https://www.facebook.com/CocaCola")

    def test_bare_word_with_profile_kind_is_marked(self):
        self.assertEqual(
            sources_store._derive_facebook_url("johndoe", kind="profile"),
            "https://www.facebook.com/johndoe?fb_kind=profile",
        )

    def test_bare_word_with_group_kind(self):
        self.assertEqual(
            sources_store._derive_facebook_url("evfires", kind="group"),
            "https://www.facebook.com/groups/evfires",
        )

    def test_bare_phrase_with_search_kind(self):
        self.assertEqual(
            sources_store._derive_facebook_url("electric vehicles", kind="search"),
            "https://www.facebook.com/search/top/?q=electric+vehicles",
        )

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_facebook_url(""), "")


class DeriveInstagramUrlTests(unittest.TestCase):
    def test_full_profile_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_instagram_url("https://www.instagram.com/nasa/"),
            "https://www.instagram.com/nasa/",
        )

    def test_full_hashtag_url_is_passed_through(self):
        self.assertEqual(
            sources_store._derive_instagram_url("https://www.instagram.com/explore/tags/evfires/"),
            "https://www.instagram.com/explore/tags/evfires/",
        )

    def test_full_search_url_keeps_q_param(self):
        self.assertEqual(
            sources_store._derive_instagram_url("https://www.instagram.com/explore/search/keyword/?q=ev+fires"),
            "https://www.instagram.com/explore/search/keyword/?q=ev+fires",
        )

    def test_full_search_url_without_q_is_rejected(self):
        self.assertEqual(sources_store._derive_instagram_url("https://www.instagram.com/explore/search/keyword/"), "")

    def test_non_instagram_url_is_rejected(self):
        self.assertEqual(sources_store._derive_instagram_url("https://example.com/nasa"), "")

    def test_reserved_path_is_rejected(self):
        self.assertEqual(sources_store._derive_instagram_url("https://www.instagram.com/accounts/login/"), "")

    def test_bare_word_defaults_to_profile(self):
        self.assertEqual(sources_store._derive_instagram_url("nasa"), "https://www.instagram.com/nasa/")

    def test_bare_word_with_at_prefix(self):
        self.assertEqual(sources_store._derive_instagram_url("@nasa"), "https://www.instagram.com/nasa/")

    def test_bare_word_with_hashtag_kind(self):
        self.assertEqual(
            sources_store._derive_instagram_url("evfires", kind="hashtag"),
            "https://www.instagram.com/explore/tags/evfires/",
        )

    def test_bare_phrase_with_search_kind(self):
        self.assertEqual(
            sources_store._derive_instagram_url("electric vehicles", kind="search"),
            "https://www.instagram.com/explore/search/keyword/?q=electric+vehicles",
        )

    def test_empty_input_returns_empty_string(self):
        self.assertEqual(sources_store._derive_instagram_url(""), "")


class DeriveTweetUrlTests(unittest.TestCase):
    def test_normalizes_a_status_url(self):
        self.assertEqual(
            sources_store._derive_tweet_url("https://x.com/elonmusk/status/123456789"),
            "https://x.com/elonmusk/status/123456789",
        )

    def test_twitter_com_host_is_also_accepted(self):
        self.assertEqual(
            sources_store._derive_tweet_url("https://twitter.com/elonmusk/status/123456789"),
            "https://x.com/elonmusk/status/123456789",
        )

    def test_query_string_and_trailing_path_are_dropped(self):
        self.assertEqual(
            sources_store._derive_tweet_url("https://x.com/elonmusk/status/123456789?s=20"),
            "https://x.com/elonmusk/status/123456789",
        )

    def test_a_bare_profile_url_is_rejected(self):
        self.assertEqual(sources_store._derive_tweet_url("https://x.com/elonmusk"), "")

    def test_a_non_x_url_is_rejected(self):
        self.assertEqual(sources_store._derive_tweet_url("https://example.com/status/123"), "")

    def test_empty_input_is_rejected(self):
        self.assertEqual(sources_store._derive_tweet_url(""), "")


class UpsertPayloadRedditTelegramTests(unittest.TestCase):
    """The end-to-end path a create/update API call actually goes through."""

    def test_reddit_source_normalizes_bare_subreddit_kind(self):
        payload = sources_store._upsert_payload({"source_type": "reddit", "url": "test", "reddit_kind": "subreddit"})
        self.assertEqual(payload["url"], "https://www.reddit.com/r/test")
        self.assertEqual(payload["source_type"], "reddit")

    def test_reddit_source_normalizes_bare_search_kind(self):
        payload = sources_store._upsert_payload({"source_type": "reddit", "url": "ev fires", "reddit_kind": "search"})
        self.assertEqual(payload["url"], "https://www.reddit.com/search?q=ev+fires")

    def test_telegram_source_normalizes_at_handle(self):
        payload = sources_store._upsert_payload({"source_type": "telegram", "url": "@somechannel"})
        self.assertEqual(payload["url"], "https://t.me/s/somechannel")
        self.assertEqual(payload["source_type"], "telegram")

    def test_telegram_web_app_internal_chat_id_link_is_rejected_not_saved_raw(self):
        # web.telegram.org/a/#-100... is Telegram Web's internal numeric
        # chat-ID deep link, not a public @username/t.me link - it must not
        # be silently saved as-is (that used to happen via a stray `or url`
        # fallback, producing a "telegram" source that would scrape forever
        # and yield zero articles instead of failing at creation time).
        payload = sources_store._upsert_payload(
            {"source_type": "telegram", "url": "https://web.telegram.org/a/#-1001613270320"}
        )
        self.assertEqual(payload["url"], "")

    def test_reddit_non_reddit_host_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "reddit", "url": "https://example.com/r/test"})
        self.assertEqual(payload["url"], "")

    def test_linkedin_source_normalizes_bare_company_kind(self):
        payload = sources_store._upsert_payload({"source_type": "linkedin", "url": "google", "linkedin_kind": "company"})
        self.assertEqual(payload["url"], "https://www.linkedin.com/company/google")
        self.assertEqual(payload["source_type"], "linkedin")

    def test_linkedin_source_normalizes_bare_search_kind(self):
        payload = sources_store._upsert_payload(
            {"source_type": "linkedin", "url": "ev fires", "linkedin_kind": "search"}
        )
        self.assertEqual(payload["url"], "https://www.linkedin.com/search/results/content/?keywords=ev+fires")

    def test_linkedin_non_linkedin_host_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "linkedin", "url": "https://example.com/company/google"})
        self.assertEqual(payload["url"], "")

    def test_threads_source_normalizes_bare_profile_kind(self):
        payload = sources_store._upsert_payload({"source_type": "threads", "url": "nasa", "threads_kind": "profile"})
        self.assertEqual(payload["url"], "https://www.threads.com/@nasa")
        self.assertEqual(payload["source_type"], "threads")

    def test_threads_source_normalizes_bare_search_kind(self):
        payload = sources_store._upsert_payload(
            {"source_type": "threads", "url": "ev fires", "threads_kind": "search"}
        )
        self.assertEqual(payload["url"], "https://www.threads.com/search?q=ev+fires")

    def test_threads_non_threads_host_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "threads", "url": "https://example.com/@nasa"})
        self.assertEqual(payload["url"], "")

    def test_facebook_source_normalizes_bare_page_kind(self):
        payload = sources_store._upsert_payload({"source_type": "facebook", "url": "CocaCola", "facebook_kind": "page"})
        self.assertEqual(payload["url"], "https://www.facebook.com/CocaCola")
        self.assertEqual(payload["source_type"], "facebook")

    def test_facebook_source_normalizes_bare_group_kind(self):
        payload = sources_store._upsert_payload({"source_type": "facebook", "url": "evfires", "facebook_kind": "group"})
        self.assertEqual(payload["url"], "https://www.facebook.com/groups/evfires")

    def test_facebook_source_normalizes_bare_profile_kind(self):
        payload = sources_store._upsert_payload({"source_type": "facebook", "url": "johndoe", "facebook_kind": "profile"})
        self.assertEqual(payload["url"], "https://www.facebook.com/johndoe?fb_kind=profile")

    def test_facebook_source_normalizes_bare_search_kind(self):
        payload = sources_store._upsert_payload(
            {"source_type": "facebook", "url": "ev fires", "facebook_kind": "search"}
        )
        self.assertEqual(payload["url"], "https://www.facebook.com/search/top/?q=ev+fires")

    def test_facebook_non_facebook_host_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "facebook", "url": "https://example.com/groups/x"})
        self.assertEqual(payload["url"], "")

    def test_instagram_source_normalizes_bare_profile_kind(self):
        payload = sources_store._upsert_payload({"source_type": "instagram", "url": "nasa", "instagram_kind": "profile"})
        self.assertEqual(payload["url"], "https://www.instagram.com/nasa/")
        self.assertEqual(payload["source_type"], "instagram")

    def test_instagram_source_normalizes_bare_hashtag_kind(self):
        payload = sources_store._upsert_payload(
            {"source_type": "instagram", "url": "evfires", "instagram_kind": "hashtag"}
        )
        self.assertEqual(payload["url"], "https://www.instagram.com/explore/tags/evfires/")

    def test_instagram_source_normalizes_bare_search_kind(self):
        payload = sources_store._upsert_payload(
            {"source_type": "instagram", "url": "ev fires", "instagram_kind": "search"}
        )
        self.assertEqual(payload["url"], "https://www.instagram.com/explore/search/keyword/?q=ev+fires")

    def test_instagram_non_instagram_host_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "instagram", "url": "https://example.com/nasa"})
        self.assertEqual(payload["url"], "")

    def test_tweet_source_normalizes_status_url(self):
        payload = sources_store._upsert_payload({"source_type": "tweet", "url": "https://twitter.com/elonmusk/status/123"})
        self.assertEqual(payload["url"], "https://x.com/elonmusk/status/123")
        self.assertEqual(payload["source_type"], "tweet")

    def test_tweet_non_status_url_is_rejected_not_saved_raw(self):
        payload = sources_store._upsert_payload({"source_type": "tweet", "url": "https://x.com/elonmusk"})
        self.assertEqual(payload["url"], "")


if __name__ == "__main__":
    unittest.main()
