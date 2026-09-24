import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.core.language import (
    output_language_instruction,
    resolve_output_language,
    text_matches_output_language,
)
from services.competitors import business_profile_store, competitor_discovery, cultural_analysis_store
from services.projects import projects_ai


class OutputLanguageTests(unittest.TestCase):
    def test_accept_language_resolution(self):
        self.assertEqual(resolve_output_language("ar-LB,ar;q=0.9,en;q=0.8"), "ar")
        self.assertEqual(resolve_output_language("fr-FR,en;q=0.7"), "en")
        self.assertEqual(resolve_output_language("en;q=0.4,ar;q=0.9"), "ar")
        self.assertEqual(resolve_output_language("ar;q=0,en;q=0.5"), "en")
        self.assertEqual(resolve_output_language(None), "en")

    def test_generated_prose_script_check(self):
        self.assertTrue(text_matches_output_language(["ملخص عربي"], "ar"))
        self.assertFalse(text_matches_output_language(["English summary"], "ar"))
        self.assertTrue(text_matches_output_language([], "ar"))

    def test_script_check_validates_each_field_independently(self):
        value = {
            "summary": "This summary is still in English.",
            "benefits": ["هذه فقرة عربية طويلة بما يكفي"],
        }
        self.assertFalse(text_matches_output_language(value, "ar"))

    def test_script_check_rejects_an_unsupported_script(self):
        self.assertFalse(text_matches_output_language("这是中文摘要", "ar"))
        self.assertFalse(text_matches_output_language("这是中文摘要", "en"))

    def test_instruction_preserves_machine_values(self):
        instruction = output_language_instruction("ar")
        self.assertIn("Arabic", instruction)
        self.assertIn("URLs", instruction)
        self.assertIn("JSON keys", instruction)

    def test_arabic_fallback_does_not_insert_english_boilerplate(self):
        with patch.object(projects_ai.config, "LLM_API_KEY", ""):
            result = projects_ai.suggest_project_metadata("قهوة", "", "ar")
        self.assertTrue(text_matches_output_language(result["target_audience"], "ar"))

    def test_arabic_fallback_extracts_arabic_keywords(self):
        result = projects_ai._fallback_metadata("قهوة مختصة", "مشروبات ساخنة", "ar")
        self.assertIn("قهوة", result["keywords"])

    @patch("services.competitors.business_profile_store.chat_completion")
    def test_business_profile_prompt_uses_requested_language(self, chat):
        chat.return_value = json.dumps({"name": "Acme", "context_summary": "ملخص"})
        result = business_profile_store.derive_profile("Acme", "", "", "site text", "ar")
        self.assertEqual(result["context_summary"], "ملخص")
        self.assertIn("Arabic", chat.call_args.kwargs["messages"][0]["content"])

    @patch("services.competitors.business_profile_store.chat_completion")
    def test_business_profile_retries_wrong_script(self, chat):
        chat.side_effect = [
            json.dumps({"industry": "Coffee", "context_summary": "English summary"}),
            json.dumps({"industry": "القهوة", "context_summary": "ملخص عربي"}),
        ]
        result = business_profile_store.derive_profile("Acme", "", "", "site text", "ar")
        self.assertEqual(result["context_summary"], "ملخص عربي")
        self.assertEqual(chat.call_count, 2)

    @patch("services.competitors.business_profile_store.chat_completion")
    def test_business_profile_rejects_empty_model_output(self, chat):
        chat.return_value = "{}"
        result = business_profile_store.derive_profile("Acme", "", "", "site text", "ar")
        self.assertEqual(result, {})
        self.assertEqual(chat.call_count, 2)

    @patch("services.competitors.business_profile_store.upsert_profile")
    @patch("services.competitors.business_profile_store.derive_profile", return_value={})
    @patch("services.competitors.business_profile_store.scrape_website")
    @patch("services.competitors.business_profile_store.get_profile")
    def test_failed_profile_regeneration_preserves_generated_content(
        self, get_profile, scrape_website, _derive, upsert_profile
    ):
        existing = {
            "industry": "القهوة", "market": "المقاهي", "geography": "لبنان",
            "positioning": "فاخر", "offerings": ["قهوة"], "audience": ["الشباب"],
            "differentiators": ["الجودة"], "keywords": ["قهوة لبنان"],
            "context_summary": "ملخص محفوظ", "analysis_model": "saved-model",
            "generated_language": "ar", "prompt_version": "saved-prompt",
        }
        get_profile.return_value = existing
        scrape_website.return_value = {
            "pages": [], "text": "", "chars": 0, "status": "failed", "error": "unavailable",
        }
        upsert_profile.side_effect = lambda _project_id, values, **_kwargs: values

        result = business_profile_store.build_profile(
            7, {"name": "Acme", "website": "example.com", "target_countries": ["LB"]}, "ar"
        )

        self.assertFalse(result["ai_derived"])
        self.assertEqual(result["profile"]["context_summary"], "ملخص محفوظ")
        self.assertEqual(result["profile"]["generated_language"], "ar")
        self.assertEqual(result["profile"]["analysis_model"], "saved-model")

    @patch("services.competitors.cultural_analysis_store.chat_completion")
    def test_cultural_analysis_prompt_uses_requested_language(self, chat):
        chat.return_value = json.dumps({"summary": "ملخص", "success_factors": ["عامل"]})
        result = cultural_analysis_store.derive_cultural_analysis(
            {"name": "Acme", "market": "Coffee"}, ["LB"], "ar"
        )
        self.assertEqual(result["summary"], "ملخص")
        self.assertIn("Arabic", chat.call_args.kwargs["messages"][0]["content"])

    @patch("services.competitors.cultural_analysis_store.chat_completion")
    def test_cultural_analysis_rejects_wrong_script_after_retry(self, chat):
        chat.return_value = json.dumps({"summary": "English only"})
        result = cultural_analysis_store.derive_cultural_analysis(
            {"name": "Acme", "market": "Coffee"}, ["LB"], "ar"
        )
        self.assertEqual(result, {})
        self.assertEqual(chat.call_count, 2)

    @patch("services.competitors.cultural_analysis_store.chat_completion")
    def test_cultural_analysis_rejects_empty_model_output(self, chat):
        chat.return_value = "{}"
        result = cultural_analysis_store.derive_cultural_analysis(
            {"name": "Acme", "market": "Coffee"}, ["LB"], "ar"
        )
        self.assertEqual(result, {})
        self.assertEqual(chat.call_count, 2)

    @patch("services.competitors.cultural_analysis_store.upsert_analysis")
    @patch("services.competitors.cultural_analysis_store.derive_cultural_analysis", return_value={})
    @patch("services.competitors.cultural_analysis_store.get_analysis")
    @patch("services.competitors.business_profile_store.get_profile")
    def test_failed_cultural_regeneration_keeps_saved_row(
        self, get_profile, get_analysis, _derive, upsert_analysis
    ):
        get_profile.return_value = {"name": "Acme", "target_countries": ["LB"]}
        get_analysis.return_value = {
            "status": "success", "summary": "ملخص محفوظ", "generated_language": "ar",
        }

        result = cultural_analysis_store.build_analysis(7, "ar")

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["summary"], "ملخص محفوظ")
        self.assertTrue(result["regeneration_failed"])
        upsert_analysis.assert_not_called()

    @patch("services.competitors.competitor_discovery._review_candidates", return_value=[])
    @patch("services.competitors.competitor_discovery._ask_for_accounts")
    @patch("services.competitors.competitor_discovery._account_grounding_context", return_value="")
    @patch("services.competitors.competitor_discovery._guess_site_feed", return_value=None)
    def test_arabic_account_discovery_keeps_official_latin_keyword(
        self, _feed, _grounding, ask_for_accounts, _reviews
    ):
        ask_for_accounts.return_value = [{
            "platform": "keyword", "handle": "Starbucks", "confidence": 0.9,
        }]
        accounts = competitor_discovery.discover_accounts("Starbucks", "", [], output_language="ar")
        self.assertIn("Starbucks", [entry["handle"] for entry in accounts])

    @patch("services.projects.projects_ai.chat_completion")
    def test_project_suggestions_replace_english_only_rule(self, chat):
        chat.return_value = json.dumps({
            "target_audience": "الجمهور",
            "hashtags": ["قهوة"],
            "keywords": ["قهوة لبنان"],
            "usernames": [],
        })
        with patch.object(projects_ai.config, "LLM_API_KEY", "test-key"):
            result = projects_ai.suggest_project_metadata("Coffee", "", "ar")
        prompt = chat.call_args.kwargs["messages"][0]["content"]
        self.assertIn("Arabic", prompt)
        self.assertNotIn("plain-English", prompt)
        self.assertEqual(result["target_audience"], "الجمهور")

    def test_background_run_captures_requested_language(self):
        run_id = competitor_discovery.create_discovery_run(17, "ar-LB")
        self.assertEqual(competitor_discovery.get_discovery_run(run_id)["output_language"], "ar")


if __name__ == "__main__":
    unittest.main()
