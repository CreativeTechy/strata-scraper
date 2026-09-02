import os
import unittest
from unittest.mock import MagicMock, patch

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


class RunActorTests(unittest.TestCase):
    def test_returns_empty_list_when_not_configured(self):
        with patch.object(config, "APIFY_API_TOKEN", ""):
            self.assertEqual(apify_reddit._run_actor("trudax/reddit-scraper-lite", {}), [])

    def test_returns_empty_list_on_request_exception(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_reddit.requests.post", side_effect=Exception("boom")
        ):
            self.assertEqual(apify_reddit._run_actor("trudax/reddit-scraper-lite", {}), [])

    def test_returns_empty_list_when_dataset_response_is_not_a_list(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {"error": "not found"}
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_reddit.requests.post", return_value=mock_response
        ):
            self.assertEqual(apify_reddit._run_actor("trudax/reddit-scraper-lite", {}), [])

    def test_returns_dataset_items_on_success(self):
        mock_response = MagicMock()
        mock_response.json.return_value = [{"url": "u", "body": "t"}]
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_reddit.requests.post", return_value=mock_response
        ) as mock_post:
            result = apify_reddit._run_actor("trudax/reddit-scraper-lite", {"startUrls": [{"url": "u"}]})
            self.assertEqual(result, [{"url": "u", "body": "t"}])
            called_url = mock_post.call_args.args[0]
            self.assertIn("trudax~reddit-scraper-lite", called_url)
            self.assertEqual(mock_post.call_args.kwargs["params"], {"token": "token"})


class ApifyRedditPostsTests(unittest.TestCase):
    def test_normalizes_dataset_items(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "_run_actor", return_value=[{"url": "u", "body": "t", "username": "someone"}]
        ):
            articles = apify_reddit.apify_reddit_posts("https://www.reddit.com/r/nasa", "https://www.reddit.com/r/nasa", "nasa")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u")

    def test_drops_items_that_fail_normalization(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            apify_reddit, "_run_actor", return_value=[{"body": "no url"}, {"url": "u2", "body": "t2"}]
        ):
            articles = apify_reddit.apify_reddit_posts("https://www.reddit.com/search?q=ev", "search-url", "ev")
            self.assertEqual(len(articles), 1)
            self.assertEqual(articles[0]["url"], "u2")


if __name__ == "__main__":
    unittest.main()
