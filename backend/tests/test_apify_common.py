import os
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from app.core import settings as config
from scraper import apify_common


def _response(payload):
    mock_response = MagicMock()
    mock_response.json.return_value = payload
    return mock_response


class RunActorSyncTests(unittest.TestCase):
    def test_returns_empty_list_when_not_configured(self):
        with patch.object(config, "APIFY_API_TOKEN", ""):
            self.assertEqual(apify_common.run_actor_sync("some/actor", {}), [])

    def test_returns_empty_list_when_actor_missing(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"):
            self.assertEqual(apify_common.run_actor_sync("", {}), [])

    def test_returns_empty_list_when_start_request_raises(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", side_effect=Exception("boom")
        ):
            self.assertEqual(apify_common.run_actor_sync("some/actor", {}), [])

    def test_returns_empty_list_when_start_response_has_no_run_id(self):
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=_response({"data": {}})
        ):
            self.assertEqual(apify_common.run_actor_sync("some/actor", {}), [])

    def test_fetches_dataset_when_run_already_succeeded(self):
        start_response = _response(
            {"data": {"id": "run1", "status": "SUCCEEDED", "defaultDatasetId": "ds1"}}
        )
        dataset_response = _response([{"url": "u"}])
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ) as mock_post, patch(
            "scraper.apify_common.requests.get", return_value=dataset_response
        ) as mock_get:
            result = apify_common.run_actor_sync("apidojo/tweet-scraper", {"searchTerms": ["#ev"]})
            self.assertEqual(result, [{"url": "u"}])
            called_url = mock_post.call_args.args[0]
            self.assertIn("apidojo~tweet-scraper", called_url)
            self.assertIn("ds1", mock_get.call_args.args[0])
            self.assertEqual(mock_post.call_args.kwargs["headers"], {"Authorization": "Bearer token"})
            self.assertNotIn("params", mock_post.call_args.kwargs)
            self.assertEqual(mock_get.call_args.kwargs["headers"], {"Authorization": "Bearer token"})
            self.assertNotIn("params", mock_get.call_args.kwargs)

    def test_polls_until_terminal_before_fetching_dataset(self):
        start_response = _response({"data": {"id": "run1", "status": "READY"}})
        poll_response = _response(
            {"data": {"id": "run1", "status": "SUCCEEDED", "defaultDatasetId": "ds1"}}
        )
        dataset_response = _response([{"url": "u"}])
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ), patch(
            "scraper.apify_common.requests.get", side_effect=[poll_response, dataset_response]
        ), patch("scraper.apify_common.time.sleep"):
            result = apify_common.run_actor_sync("some/actor", {})
            self.assertEqual(result, [{"url": "u"}])

    def test_returns_empty_list_when_run_fails_for_a_non_billing_reason(self):
        start_response = _response(
            {"data": {"id": "run1", "status": "FAILED", "statusMessage": "actor crashed"}}
        )
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ):
            self.assertEqual(apify_common.run_actor_sync("some/actor", {}), [])

    def test_returns_empty_list_when_dataset_response_is_not_a_list(self):
        start_response = _response(
            {"data": {"id": "run1", "status": "SUCCEEDED", "defaultDatasetId": "ds1"}}
        )
        dataset_response = _response({"error": "not found"})
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ), patch("scraper.apify_common.requests.get", return_value=dataset_response):
            self.assertEqual(apify_common.run_actor_sync("some/actor", {}), [])

    def test_raises_billing_error_when_run_already_reports_it(self):
        start_response = _response(
            {
                "data": {
                    "id": "run1",
                    "status": "SUCCEEDED",
                    "defaultDatasetId": "ds1",
                    "statusMessage": (
                        "Monthly run limit exceeded per user. Please subscribe to a "
                        "paid plan on Apify if you want to use it without monthly limits."
                    ),
                }
            }
        )
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ):
            with self.assertRaises(apify_common.ApifyBillingError) as ctx:
                apify_common.run_actor_sync("apidojo/tweet-scraper", {}, actor_label="Twitter search")
            self.assertIn("Twitter search", str(ctx.exception))
            self.assertIn("Monthly run limit exceeded", str(ctx.exception))

    def test_explicit_timeout_overrides_the_shared_default(self):
        start_response = _response(
            {"data": {"id": "run1", "status": "SUCCEEDED", "defaultDatasetId": "ds1"}}
        )
        dataset_response = _response([{"url": "u"}])
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_TIMEOUT_SECONDS", 120
        ), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ) as mock_post, patch(
            "scraper.apify_common.requests.get", return_value=dataset_response
        ) as mock_get:
            apify_common.run_actor_sync("some/actor", {}, timeout=240)
            self.assertEqual(mock_post.call_args.kwargs["timeout"], 240)
            self.assertEqual(mock_get.call_args.kwargs["timeout"], 240)

    def test_omitted_timeout_falls_back_to_the_shared_default(self):
        start_response = _response(
            {"data": {"id": "run1", "status": "SUCCEEDED", "defaultDatasetId": "ds1"}}
        )
        dataset_response = _response([{"url": "u"}])
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch.object(
            config, "APIFY_TIMEOUT_SECONDS", 77
        ), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ) as mock_post, patch(
            "scraper.apify_common.requests.get", return_value=dataset_response
        ):
            apify_common.run_actor_sync("some/actor", {})
            self.assertEqual(mock_post.call_args.kwargs["timeout"], 77)

    def test_raises_billing_error_only_discovered_after_polling(self):
        start_response = _response({"data": {"id": "run1", "status": "RUNNING"}})
        poll_response = _response(
            {
                "data": {
                    "id": "run1",
                    "status": "SUCCEEDED",
                    "statusMessage": "Please subscribe to a paid plan on Apify to continue.",
                }
            }
        )
        with patch.object(config, "APIFY_API_TOKEN", "token"), patch(
            "scraper.apify_common.requests.post", return_value=start_response
        ), patch("scraper.apify_common.requests.get", return_value=poll_response), patch(
            "scraper.apify_common.time.sleep"
        ):
            with self.assertRaises(apify_common.ApifyBillingError):
                apify_common.run_actor_sync("some/actor", {})


if __name__ == "__main__":
    unittest.main()
