import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from app.core.language import output_language_instruction, resolve_output_language
from services.competitors import business_profile_store, competitor_discovery, cultural_analysis_store
from services.projects import projects_ai


class OutputLanguageTests(unittest.TestCase):
    def test_accept_language_resolution(self):
        self.assertEqual(resolve_output_language("ar-LB,ar;q=0.9,en;q=0.8"), "ar")
        self.assertEqual(resolve_output_language("fr-FR,en;q=0.7"), "en")
        self.assertEqual(resolve_output_language(None), "en")

    def test_instruction_preserves_machine_values(self):
        instruction = output_language_instruction("ar")
        self.assertIn("Arabic", instruction)
        self.assertIn("URLs", instruction)
        self.assertIn("JSON keys", instruction)

    def test_arabic_fallback_does_not_insert_english_boilerplate(self):
        with patch.object(projects_ai.config, "LLM_API_KEY", ""):
            result = projects_ai.suggest_project_metadata("قهوة", "", "ar")
        self.assertTrue(result["target_audience"].startswith("المتابعون"))

    @patch("services.competitors.business_profile_store.chat_completion")
    def test_business_profile_prompt_uses_requested_language(self, chat):
        chat.return_value = json.dumps({"name": "Acme", "context_summary": "ملخص"})
        result = business_profile_store.derive_profile("Acme", "", "", "site text", "ar")
        self.assertEqual(result["context_summary"], "ملخص")
        self.assertIn("Arabic", chat.call_args.kwargs["messages"][0]["content"])

    @patch("services.competitors.cultural_analysis_store.chat_completion")
    def test_cultural_analysis_prompt_uses_requested_language(self, chat):
        chat.return_value = json.dumps({"summary": "ملخص", "success_factors": ["عامل"]})
        result = cultural_analysis_store.derive_cultural_analysis(
            {"name": "Acme", "market": "Coffee"}, ["LB"], "ar"
        )
        self.assertEqual(result["summary"], "ملخص")
        self.assertIn("Arabic", chat.call_args.kwargs["messages"][0]["content"])

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
