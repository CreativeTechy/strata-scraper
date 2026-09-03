import unittest

import content_guard


class RedditBlockedPayloadTests(unittest.TestCase):
    def test_error_dict_is_blocked(self):
        self.assertTrue(content_guard.is_reddit_blocked_payload({"error": 404, "message": "Not Found"}))

    def test_private_subreddit_reason_is_blocked(self):
        self.assertTrue(content_guard.is_reddit_blocked_payload({"reason": "private", "message": "Forbidden"}))

    def test_banned_subreddit_reason_is_blocked(self):
        self.assertTrue(content_guard.is_reddit_blocked_payload({"reason": "banned"}))

    def test_normal_listing_is_not_blocked(self):
        self.assertFalse(content_guard.is_reddit_blocked_payload({"kind": "Listing", "data": {"children": []}}))

    def test_non_dict_payload_is_not_blocked(self):
        self.assertFalse(content_guard.is_reddit_blocked_payload([{"kind": "Listing"}, {"kind": "Listing"}]))
        self.assertFalse(content_guard.is_reddit_blocked_payload(None))


class ShortFormSocialUrlTests(unittest.TestCase):
    def test_linkedin_url_is_short_form(self):
        self.assertTrue(content_guard.is_short_form_social_url("https://www.linkedin.com/company/google/posts/123"))

    def test_threads_url_is_short_form(self):
        self.assertTrue(content_guard.is_short_form_social_url("https://www.threads.com/@nasa/post/C1234"))
        self.assertTrue(content_guard.is_short_form_social_url("https://www.threads.net/@nasa/post/C1234"))

    def test_facebook_url_is_short_form(self):
        self.assertTrue(content_guard.is_short_form_social_url("https://www.facebook.com/CocaCola/posts/123"))
        self.assertTrue(content_guard.is_short_form_social_url("https://fb.com/groups/1/posts/2"))

    def test_mobile_subdomain_is_short_form(self):
        self.assertTrue(content_guard.is_short_form_social_url("https://m.facebook.com/CocaCola/posts/123"))

    def test_other_domains_are_not_short_form(self):
        self.assertFalse(content_guard.is_short_form_social_url("https://example.com/article"))
        self.assertFalse(content_guard.is_short_form_social_url("https://x.com/someuser/status/123"))

    def test_empty_url_is_not_short_form(self):
        self.assertFalse(content_guard.is_short_form_social_url(""))
        self.assertFalse(content_guard.is_short_form_social_url(None))


class TelegramChannelUnavailableTests(unittest.TestCase):
    def test_redirect_statuses_are_unavailable(self):
        for status in (301, 302, 303, 307, 308):
            self.assertTrue(content_guard.is_telegram_channel_unavailable(status))

    def test_200_is_available(self):
        self.assertFalse(content_guard.is_telegram_channel_unavailable(200))


if __name__ == "__main__":
    unittest.main()
