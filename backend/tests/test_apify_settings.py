import importlib
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from api.errors import ValidationError
from app.core import settings as config
from services.settings import apify_settings


class ApplyOverridesTests(unittest.TestCase):
    def tearDown(self):
        config.apply_apify_overrides({})

    def test_override_replaces_value_and_clearing_restores_baseline(self):
        baseline = config.APIFY_BASELINE["APIFY_REDDIT_MAX_ITEMS"]
        config.apply_apify_overrides({"APIFY_REDDIT_MAX_ITEMS": "7", "APIFY_THREADS_ACTOR": "me/threads"})
        self.assertEqual(config.APIFY_REDDIT_MAX_ITEMS, 7)
        self.assertEqual(config.APIFY_THREADS_ACTOR, "me/threads")
        config.apply_apify_overrides({})
        self.assertEqual(config.APIFY_REDDIT_MAX_ITEMS, baseline)

    def test_unparseable_number_keeps_baseline(self):
        config.apply_apify_overrides({"APIFY_REDDIT_MAX_ITEMS": "lots"})
        self.assertEqual(config.APIFY_REDDIT_MAX_ITEMS, config.APIFY_BASELINE["APIFY_REDDIT_MAX_ITEMS"])

    def test_every_tier_key_is_editable(self):
        for tier in apify_settings.TIERS:
            for field in ("actor_key", "max_key", "timeout_key"):
                self.assertIn(tier[field], config.APIFY_EDITABLE_KEYS)


class ValidationTests(unittest.TestCase):
    def test_actor_must_be_username_slash_name(self):
        self.assertEqual(apify_settings._validate("APIFY_THREADS_ACTOR", " a/b-c "), "a/b-c")
        with self.assertRaises(ValidationError):
            apify_settings._validate("APIFY_THREADS_ACTOR", "just-a-name")

    def test_numbers_are_range_checked(self):
        self.assertEqual(apify_settings._validate("APIFY_REDDIT_MAX_ITEMS", "50"), "50")
        with self.assertRaises(ValidationError):
            apify_settings._validate("APIFY_REDDIT_MAX_ITEMS", "0")
        with self.assertRaises(ValidationError):
            apify_settings._validate("APIFY_REDDIT_SEARCH_TIMEOUT_SECONDS", "5")
        with self.assertRaises(ValidationError):
            apify_settings._validate("APIFY_REDDIT_SEARCH_TIMEOUT_SECONDS", "abc")

    def test_save_rejects_unknown_key_and_writes_nothing(self):
        with patch.object(apify_settings.db, "execute") as execute:
            with self.assertRaises(ValidationError):
                apify_settings.save_overrides({"APIFY_REDDIT_MAX_ITEMS": "5", "NOPE": "1"})
            with self.assertRaises(ValidationError):
                apify_settings.save_overrides({"APIFY_REDDIT_MAX_ITEMS": "5", "APIFY_THREADS_ACTOR": "bad"})
            execute.assert_not_called()


class PricingTests(unittest.TestCase):
    def test_uses_latest_pricing_info(self):
        data = {"title": "T", "pricingInfos": [
            {"pricingModel": "FLAT_PRICE_PER_MONTH", "pricePerUnitUsd": 9, "startedAt": "2025-01-01"},
            {"pricingModel": "PRICE_PER_DATASET_ITEM", "pricePerUnitUsd": 0.004,
             "unitName": "result", "startedAt": "2026-01-01"},
        ]}
        result = apify_settings._normalize_pricing("a/b", data)
        self.assertEqual(result["model"], "PRICE_PER_DATASET_ITEM")
        self.assertEqual(result["per_result_usd"], 0.004)
        self.assertIsNone(result["monthly_usd"])

    def test_pay_per_event_tiered_dataset_item_is_a_per_result_price(self):
        # Shape returned live for apidojo/tweet-scraper ($0.40 per 1,000 tweets).
        data = {"pricingInfos": [{"pricingModel": "PAY_PER_EVENT", "pricingPerEvent": {"actorChargeEvents": {
            "apify-default-dataset-item": {"eventTitle": "tweet", "eventTieredPricingUsd": {
                "FREE": {"tieredEventPriceUsd": 0.0005}, "BRONZE": {"tieredEventPriceUsd": 0.0004}}},
            "actor-start": {"eventTitle": "Start", "eventPriceUsd": 0.01}}}}]}
        result = apify_settings._normalize_pricing("a/b", data)
        self.assertEqual(result["per_result_usd"], 0.0004)
        self.assertEqual(result["unit"], "tweet")
        self.assertEqual(result["events"], [{"title": "Start", "price_usd": 0.01}])

    def test_tiered_per_item_and_rental_and_free(self):
        tiered = {"pricingInfos": [{"pricingModel": "PRICE_PER_DATASET_ITEM",
                                    "tieredPricing": {"BRONZE": {"tieredPricePerUnitUsd": 0.002}}}]}
        self.assertEqual(apify_settings._normalize_pricing("a/b", tiered)["per_result_usd"], 0.002)
        rental = {"pricingInfos": [{"pricingModel": "FLAT_PRICE_PER_MONTH", "pricePerUnitUsd": 9}]}
        self.assertEqual(apify_settings._normalize_pricing("a/b", rental)["monthly_usd"], 9)
        self.assertEqual(apify_settings._normalize_pricing("a/b", {})["model"], "FREE")


if __name__ == "__main__":
    unittest.main()
