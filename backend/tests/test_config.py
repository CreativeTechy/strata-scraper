import importlib
import os
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config


class ProviderDefaultsTests(unittest.TestCase):
    """`config.py`'s provider defaults, tested independently of whatever
    LLM_PROVIDER/.env this machine happens to have set."""

    def test_deepseek_provider_default_is_not_a_deprecated_legacy_model_alias(self):
        deepseek_defaults = config._LLM_PROVIDER_DEFAULTS["deepseek"]
        self.assertNotIn(deepseek_defaults["default_model"], ("deepseek-chat", "deepseek-reasoner"))
        self.assertEqual(deepseek_defaults["api_style"], "chat_completions")


class ProviderResolutionTests(unittest.TestCase):
    """Reloads config with a fully controlled environment (no backend/.env
    involved) to exercise LLM_PROVIDER's own default-and-fallback logic."""

    def _reload_with_env(self, env: dict) -> None:
        with patch.dict(os.environ, env, clear=True), patch.object(Path, "exists", return_value=False):
            importlib.reload(config)

    def tearDown(self):
        # Restore the module every other test file relies on.
        importlib.reload(config)

    def test_defaults_to_deepseek_when_llm_provider_is_unset(self):
        self._reload_with_env({})
        self.assertEqual(config.LLM_PROVIDER, "deepseek")
        self.assertEqual(config.LLM_API_STYLE, "chat_completions")

    def test_unknown_provider_falls_back_to_deepseek_not_openai(self):
        self._reload_with_env({"LLM_PROVIDER": "not-a-real-provider"})
        self.assertEqual(config.LLM_PROVIDER, "deepseek")

    def test_openai_is_still_selectable_as_an_override(self):
        self._reload_with_env({"LLM_PROVIDER": "openai"})
        self.assertEqual(config.LLM_PROVIDER, "openai")
        self.assertEqual(config.LLM_API_STYLE, "responses")

    def test_ollama_is_selectable_and_needs_no_real_api_key(self):
        self._reload_with_env({"LLM_PROVIDER": "ollama"})
        self.assertEqual(config.LLM_PROVIDER, "ollama")
        self.assertEqual(config.LLM_API_STYLE, "chat_completions")
        self.assertTrue(config.LLM_API_KEY)  # placeholder, but must be non-empty
        self.assertIn("localhost", config.LLM_CHAT_BASE_URL)


class RedditTelegramSourceTypeTests(unittest.TestCase):
    """reddit/telegram source-type inference and resolution (config.py's
    half of the reddit/telegram source-type feature - see
    services/sources/sources_store.py for URL derivation)."""

    def test_reddit_urls_are_inferred_as_reddit(self):
        self.assertEqual(config._infer_source_type("https://www.reddit.com/r/test"), "reddit")
        self.assertEqual(config._infer_source_type("https://reddit.com/user/someone"), "reddit")

    def test_telegram_urls_are_inferred_as_telegram(self):
        self.assertEqual(config._infer_source_type("https://t.me/s/somechannel"), "telegram")
        self.assertEqual(config._infer_source_type("https://telegram.me/somechannel"), "telegram")

    def test_other_social_urls_do_not_infer_as_reddit(self):
        # No generic "social" bucket any more (see TwitterSourceTypeTests) -
        # x.com resolves to its own concrete type, and a platform with no
        # dedicated scraping tier (TikTok) falls through to "web".
        self.assertEqual(config._infer_source_type("https://x.com/someone"), "username")
        self.assertEqual(config._infer_source_type("https://www.tiktok.com/@someone"), "web")

    def test_explicit_reddit_and_telegram_types_are_trusted(self):
        self.assertEqual(config._resolve_source_type("reddit", "https://www.reddit.com/r/test"), "reddit")
        self.assertEqual(config._resolve_source_type("telegram", "https://t.me/s/somechannel"), "telegram")

    def test_legacy_rows_stored_as_social_upgrade_to_reddit_or_telegram(self):
        # reddit.com used to be lumped into the generic "social" bucket before
        # this type existed - existing rows should be reclassified on load,
        # the same way legacy rss/web rows already upgrade to "social".
        self.assertEqual(config._resolve_source_type("social", "https://www.reddit.com/r/test"), "reddit")
        self.assertEqual(config._resolve_source_type("rss", "https://t.me/s/somechannel"), "telegram")

    def test_hashtag_keyword_username_are_never_overridden(self):
        self.assertEqual(config._resolve_source_type("username", "https://x.com/someone"), "username")
        self.assertEqual(config._resolve_source_type("keyword", "https://news.google.com/rss/search?q=ev"), "keyword")


class TwitterSourceTypeTests(unittest.TestCase):
    """hashtag/username/tweet source-type inference and resolution - no
    generic "social" bucket exists any more (see _resolve_source_type's
    docstring): an x.com/twitter.com URL resolves straight to whichever of
    these three it actually is."""

    def test_hashtag_urls_are_inferred_as_hashtag(self):
        self.assertEqual(config._infer_source_type("https://x.com/hashtag/EVSummit"), "hashtag")
        self.assertEqual(config._infer_source_type("https://twitter.com/hashtag/EVSummit"), "hashtag")

    def test_status_urls_are_inferred_as_tweet(self):
        self.assertEqual(config._infer_source_type("https://x.com/elonmusk/status/12345"), "tweet")
        self.assertEqual(config._infer_source_type("https://twitter.com/elonmusk/status/12345"), "tweet")

    def test_bare_profile_urls_are_inferred_as_username(self):
        self.assertEqual(config._infer_source_type("https://x.com/elonmusk"), "username")

    def test_any_entry_gets_reassigned_to_the_url_s_real_platform(self):
        # The example that motivated this: picking "Reddit" but pasting a
        # twitter.com URL should not create an uncrawlable "reddit" source.
        self.assertEqual(config._resolve_source_type("reddit", "https://x.com/someone"), "username")
        self.assertEqual(config._resolve_source_type("reddit", "https://x.com/someone/status/123"), "tweet")
        self.assertEqual(config._resolve_source_type("web", "https://x.com/hashtag/ev"), "hashtag")
        self.assertEqual(config._resolve_source_type("linkedin", "https://t.me/s/somechannel"), "telegram")
        # Even within Twitter/X itself: picking "Single post" but pasting a
        # plain profile URL corrects to "username".
        self.assertEqual(config._resolve_source_type("tweet", "https://x.com/someone"), "username")

    def test_uncrawlable_social_platforms_are_not_reassigned_away_from_web_or_rss(self):
        # TikTok/YouTube have no dedicated type to promote to - "web" is
        # correct and final, and an explicit "rss" pick (e.g. a homepage URL
        # saved for parse_homepage to discover its feed) is left alone rather
        # than getting flipped to "web".
        self.assertEqual(config._resolve_source_type("web", "https://www.tiktok.com/@someone"), "web")
        self.assertEqual(config._resolve_source_type("rss", "https://www.tiktok.com/@someone"), "rss")


class LinkedinSourceTypeTests(unittest.TestCase):
    """linkedin source-type inference and resolution (config.py's half of the
    feature - see services/sources/sources_store.py for URL derivation and
    scraper/apify_linkedin.py for the Apify tier itself)."""

    def test_linkedin_urls_are_inferred_as_linkedin(self):
        self.assertEqual(config._infer_source_type("https://www.linkedin.com/company/google"), "linkedin")
        self.assertEqual(config._infer_source_type("https://linkedin.com/in/satyanadella"), "linkedin")

    def test_other_social_urls_do_not_infer_as_linkedin(self):
        self.assertEqual(config._infer_source_type("https://x.com/someone"), "username")
        self.assertEqual(config._infer_source_type("https://www.tiktok.com/@someone"), "web")

    def test_explicit_linkedin_type_is_trusted(self):
        self.assertEqual(config._resolve_source_type("linkedin", "https://www.linkedin.com/company/google"), "linkedin")

    def test_legacy_rows_stored_as_social_upgrade_to_linkedin(self):
        # linkedin.com used to be lumped into the generic "social" bucket
        # before this type existed - existing rows should be reclassified on
        # load, the same way legacy reddit/telegram rows already upgrade.
        self.assertEqual(config._resolve_source_type("social", "https://www.linkedin.com/company/google"), "linkedin")
        self.assertEqual(config._resolve_source_type("rss", "https://www.linkedin.com/in/satyanadella"), "linkedin")


class ThreadsSourceTypeTests(unittest.TestCase):
    """threads source-type inference and resolution (config.py's half of the
    feature - see services/sources/sources_store.py for URL derivation and
    scraper/apify_threads.py for the Apify tier itself)."""

    def test_threads_urls_are_inferred_as_threads(self):
        self.assertEqual(config._infer_source_type("https://www.threads.com/@nasa"), "threads")
        self.assertEqual(config._infer_source_type("https://threads.net/@nasa"), "threads")

    def test_other_social_urls_do_not_infer_as_threads(self):
        self.assertEqual(config._infer_source_type("https://x.com/someone"), "username")
        self.assertEqual(config._infer_source_type("https://www.tiktok.com/@someone"), "web")

    def test_explicit_threads_type_is_trusted(self):
        self.assertEqual(config._resolve_source_type("threads", "https://www.threads.com/@nasa"), "threads")

    def test_any_entry_gets_reassigned_to_threads_when_the_url_is_threads(self):
        self.assertEqual(config._resolve_source_type("linkedin", "https://www.threads.com/@nasa"), "threads")


class FacebookSourceTypeTests(unittest.TestCase):
    """facebook source-type inference and resolution (config.py's half of the
    feature - see services/sources/sources_store.py for URL derivation and
    scraper/apify_facebook.py for the Apify tier itself)."""

    def test_facebook_urls_are_inferred_as_facebook(self):
        self.assertEqual(config._infer_source_type("https://www.facebook.com/CocaCola"), "facebook")
        self.assertEqual(config._infer_source_type("https://facebook.com/groups/evfires"), "facebook")
        self.assertEqual(config._infer_source_type("https://fb.com/CocaCola"), "facebook")

    def test_other_social_urls_do_not_infer_as_facebook(self):
        self.assertEqual(config._infer_source_type("https://x.com/someone"), "username")
        self.assertEqual(config._infer_source_type("https://www.tiktok.com/@someone"), "web")

    def test_explicit_facebook_type_is_trusted(self):
        self.assertEqual(config._resolve_source_type("facebook", "https://www.facebook.com/CocaCola"), "facebook")

    def test_any_entry_gets_reassigned_to_facebook_when_the_url_is_facebook(self):
        self.assertEqual(config._resolve_source_type("linkedin", "https://www.facebook.com/CocaCola"), "facebook")


class InstagramSourceTypeTests(unittest.TestCase):
    """instagram source-type inference and resolution (config.py's half of
    the feature - see services/sources/sources_store.py for URL derivation
    and scraper/apify_instagram.py for the Apify tier itself)."""

    def test_instagram_urls_are_inferred_as_instagram(self):
        self.assertEqual(config._infer_source_type("https://www.instagram.com/someone"), "instagram")
        self.assertEqual(config._infer_source_type("https://instagram.com/explore/tags/evfires"), "instagram")

    def test_other_social_urls_do_not_infer_as_instagram(self):
        self.assertEqual(config._infer_source_type("https://x.com/someone"), "username")
        self.assertEqual(config._infer_source_type("https://www.tiktok.com/@someone"), "web")

    def test_explicit_instagram_type_is_trusted(self):
        self.assertEqual(config._resolve_source_type("instagram", "https://www.instagram.com/someone"), "instagram")

    def test_any_entry_gets_reassigned_to_instagram_when_the_url_is_instagram(self):
        self.assertEqual(config._resolve_source_type("linkedin", "https://www.instagram.com/someone"), "instagram")


class ApifyConfiguredTests(unittest.TestCase):
    def test_false_when_unset(self):
        with patch.object(config, "APIFY_API_TOKEN", ""):
            self.assertFalse(config.apify_configured())

    def test_true_when_set(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"):
            self.assertTrue(config.apify_configured())


class RedditOAuthConfiguredTests(unittest.TestCase):
    def test_false_when_unset(self):
        with patch.object(config, "REDDIT_OAUTH_CLIENT_ID", ""), patch.object(config, "REDDIT_OAUTH_CLIENT_SECRET", ""):
            self.assertFalse(config.reddit_oauth_configured())

    def test_false_when_only_one_of_the_pair_is_set(self):
        with patch.object(config, "REDDIT_OAUTH_CLIENT_ID", "cid"), patch.object(config, "REDDIT_OAUTH_CLIENT_SECRET", ""):
            self.assertFalse(config.reddit_oauth_configured())

    def test_true_when_both_are_set(self):
        with patch.object(config, "REDDIT_OAUTH_CLIENT_ID", "cid"), patch.object(config, "REDDIT_OAUTH_CLIENT_SECRET", "secret"):
            self.assertTrue(config.reddit_oauth_configured())


if __name__ == "__main__":
    unittest.main()
