import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from fastapi.testclient import TestClient

import main
from app.core.language import clean_name_translations
from llm_client import LLMError
from services.auth import auth
from services.competitors import competitor_discovery, competitors_store

FAKE_USER = {"id": 1, "username": "admin", "role_id": 1, "status": "active"}


class CleanNameTranslationsTests(unittest.TestCase):
    def test_keeps_an_arabic_name(self):
        self.assertEqual(
            clean_name_translations({"ar": "  ستاربكس "}, "Starbucks"),
            {"ar": "ستاربكس"},
        )

    def test_drops_a_latin_echo_of_the_canonical_name(self):
        """A model that returns the English name has not translated it, and
        storing it would stop the name from ever being translated later."""
        self.assertEqual(clean_name_translations({"ar": "Starbucks"}, "Starbucks"), {})

    def test_drops_the_default_and_unsupported_languages(self):
        self.assertEqual(
            clean_name_translations({"en": "Starbucks", "fr": "Starbucks", "AR": "ستاربكس"}, "Starbucks"),
            {"ar": "ستاربكس"},
        )

    def test_rejects_anything_but_a_mapping(self):
        for value in (None, "ستاربكس", ["ستاربكس"]):
            self.assertEqual(clean_name_translations(value, "Starbucks"), {})


class TranslateCompetitorNamesTests(unittest.TestCase):
    @patch("services.competitors.competitor_discovery.chat_completion")
    def test_one_batched_call_settles_answered_names_and_skips_unanswered(self, chat):
        chat.return_value = json.dumps({"names": {
            "Starbucks": "ستاربكس",
            "Cafe Younes": "Cafe Younes",
        }}, ensure_ascii=False)

        result = competitor_discovery.translate_competitor_names(
            ["Starbucks", "Cafe Younes", "Starbucks", "Missing"], "ar"
        )

        # "Cafe Younes" was answered but has no distinct rendering: settled with
        # itself so it is not re-requested. "Missing" was skipped: left to retry.
        self.assertEqual(result, {"Starbucks": "ستاربكس", "Cafe Younes": "Cafe Younes"})
        chat.assert_called_once()
        sent = json.loads(chat.call_args.kwargs["messages"][1]["content"])
        self.assertEqual(sent, ["Starbucks", "Cafe Younes", "Missing"])

    @patch("services.competitors.competitor_discovery.chat_completion", side_effect=LLMError("down"))
    def test_llm_failure_returns_nothing(self, _chat):
        self.assertEqual(competitor_discovery.translate_competitor_names(["Starbucks"], "ar"), {})

    @patch("services.competitors.competitor_discovery.chat_completion")
    def test_the_default_language_needs_no_call(self, chat):
        self.assertEqual(competitor_discovery.translate_competitor_names(["Starbucks"], "en"), {})
        chat.assert_not_called()


class FillMissingNameTranslationsTests(unittest.TestCase):
    def setUp(self):
        competitor_discovery._untranslatable_names.clear()

    @patch("services.competitors.competitors_store.set_name_translation")
    @patch("services.competitors.competitor_discovery.translate_competitor_names")
    @patch("services.competitors.competitors_store.competitors_missing_name_translation")
    def test_stores_translations_and_remembers_failures(self, missing, translate, store):
        """Runs without any notion of the interface language: the language
        switcher only re-renders, so Arabic names must already be stored
        before anyone switches to Arabic."""
        missing.return_value = [{"id": 1, "name": "Starbucks"}, {"id": 2, "name": "Cafe Younes"}]
        translate.return_value = {"Starbucks": "ستاربكس"}

        filled = competitor_discovery.fill_missing_name_translations(5)

        self.assertEqual(filled, 1)
        missing.assert_called_once_with(5, "ar")
        store.assert_called_once_with(1, "Starbucks", "ar", "ستاربكس")

        # The untranslatable name is not sent to the model again on the next
        # load, so a failing LLM doesn't add its timeout to every list fetch.
        missing.return_value = [{"id": 2, "name": "Cafe Younes"}]
        translate.reset_mock()
        self.assertEqual(competitor_discovery.fill_missing_name_translations(5), 0)
        translate.assert_not_called()


    @patch("services.competitors.competitors_store.set_name_translation")
    @patch("services.competitors.competitor_discovery.translate_competitor_names")
    @patch("services.competitors.competitors_store.competitors_missing_name_translation")
    def test_force_retries_names_that_failed_before(self, missing, translate, store):
        """A card's own language switch asks for this list now, so a name the
        list load gave up on is sent to the model again."""
        missing.return_value = [{"id": 2, "name": "Cafe Younes"}]
        translate.return_value = {}
        competitor_discovery.fill_missing_name_translations(5)

        translate.reset_mock()
        translate.return_value = {"Cafe Younes": "مقهى يونس"}
        self.assertEqual(competitor_discovery.fill_missing_name_translations(5, force=True), 1)
        translate.assert_called_once_with(["Cafe Younes"], "ar")
        store.assert_called_once_with(2, "Cafe Younes", "ar", "مقهى يونس")
        self.assertNotIn((2, "Cafe Younes", "ar"), competitor_discovery._untranslatable_names)


class UpsertCompetitorTranslationsTests(unittest.TestCase):
    def test_translations_are_cleaned_and_reset_on_rename(self):
        with patch("services.competitors.competitors_store.db.fetch_one", return_value={"id": 1}) as fetch_one:
            competitors_store.upsert_competitor(3, {
                "name": "Starbucks",
                "name_translations": {"ar": "ستاربكس", "fr": "Starbucks"},
            })

        sql, params = fetch_one.call_args[0]
        self.assertIn(
            "name_translations = case when competitors.name = excluded.name "
            "then competitors.name_translations || excluded.name_translations "
            "else excluded.name_translations end",
            sql,
        )
        stored = [p.obj for p in params if getattr(p, "obj", None) == {"ar": "ستاربكس"}]
        self.assertEqual(len(stored), 1)


class CompetitorRoutesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main.app.dependency_overrides[auth.get_current_user] = lambda: FAKE_USER
        cls._patchers = [
            patch("services.auth.auth._enforce_csrf"),
            patch("services.auth.permissions_store.user_permission_keys",
                  return_value={"competitors.view", "competitors.manage"}),
            patch("services.auth.permissions_store.user_is_full_access", return_value=True),
        ]
        for patcher in cls._patchers:
            patcher.start()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        main.app.dependency_overrides.clear()
        for patcher in cls._patchers:
            patcher.stop()

    STORED = {"id": 9, "project_id": 3, "name": "Starbucks", "name_translations": {"ar": "ستاربكس"}}

    def _update(self, payload):
        with patch("services.competitors.competitor_api._competitor_or_404", return_value=dict(self.STORED)), \
             patch("services.competitors.competitors_store.rerank_competitors"), \
             patch("services.competitors.competitors_store.upsert_competitor", return_value=self.STORED) as upsert:
            res = self.client.put("/api/competitor/competitors/9", json=payload)
        self.assertEqual(res.status_code, 200)
        return upsert.call_args[0][1]

    def test_rename_drops_the_old_names_translation(self):
        self.assertEqual(self._update({"name": "Starbucks Coffee"})["name_translations"], {})

    def test_other_edits_keep_the_translation(self):
        self.assertEqual(self._update({"aliases": ["SBUX"]})["name_translations"], {"ar": "ستاربكس"})

    def test_list_schedules_translation_in_the_background(self):
        with patch("services.competitors.competitor_api._project_or_404"), \
             patch("services.competitors.competitors_store.competitor_overview", return_value=[]), \
             patch("services.competitors.competitor_discovery.fill_missing_name_translations") as inline, \
             patch("services.competitors.competitor_discovery.schedule_name_translation") as fill:
            res = self.client.get("/api/competitor/studies/3/competitors", headers={"Accept-Language": "en"})

        self.assertEqual(res.status_code, 200)
        fill.assert_called_once_with(3)
        inline.assert_not_called()

    def test_translate_names_needs_manage(self):
        with patch("services.auth.permissions_store.user_is_full_access", return_value=False),              patch("services.auth.permissions_store.user_permission_keys", return_value={"competitors.view"}),              patch("services.competitors.competitor_api._project_or_404"),              patch("services.competitors.competitor_discovery.fill_missing_name_translations") as fill:
            res = self.client.post("/api/competitor/studies/3/competitors/translate-names")
        self.assertEqual(res.status_code, 403)
        fill.assert_not_called()

    def test_translate_names_forces_a_fill_and_returns_every_name(self):
        rows = [{"id": 1, "name": "Starbucks", "name_translations": {"ar": "ستاربكس"}, "status": "tracked"},
                {"id": 2, "name": "Urbanista", "name_translations": {}, "status": "tracked"}]
        with patch("services.competitors.competitor_api._project_or_404"), \
             patch("services.competitors.competitors_store.list_competitors", return_value=rows), \
             patch("services.competitors.competitor_discovery.fill_missing_name_translations",
                   side_effect=RuntimeError("boom")) as fill:
            res = self.client.post("/api/competitor/studies/3/competitors/translate-names")

        self.assertEqual(res.status_code, 200)
        fill.assert_called_once_with(3, force=True)
        self.assertEqual(res.json()["competitors"], [
            {"id": 1, "name": "Starbucks", "name_translations": {"ar": "ستاربكس"}},
            {"id": 2, "name": "Urbanista", "name_translations": {}},
        ])


class DashboardSummaryTranslationsTests(unittest.TestCase):
    def test_competitor_summary_queues_names_first(self):
        from services.dashboard import dashboard_store

        calls = []
        with patch.object(dashboard_store, "_project_or_none", return_value={"id": 3, "mode": "competitor"}), \
             patch.object(dashboard_store, "get_article_stats", return_value={"total": 0, "sources": []}), \
             patch.object(dashboard_store, "_latest_detailed_run_id", return_value=None), \
             patch.object(dashboard_store, "_total_sources", return_value=0), \
             patch.object(dashboard_store, "_total_runs", return_value=0), \
             patch.object(dashboard_store, "_runs_series", return_value=[]), \
             patch.object(dashboard_store, "_articles_by_platform", return_value=[]), \
             patch.object(dashboard_store, "_sources_needing_attention", return_value=[]), \
             patch.object(dashboard_store, "_competitor_totals", return_value=1), \
             patch.object(dashboard_store, "_competitors_needing_attention",
                          side_effect=lambda *_: calls.append("attention") or []), \
             patch("services.competitors.competitor_discovery.schedule_name_translation",
                   side_effect=lambda *_: calls.append("fill")):
            summary = dashboard_store.get_dashboard_summary(3)

        self.assertEqual(calls, ["fill", "attention"])
        self.assertEqual(summary["totals"]["competitors"], 1)


class DiscoveryNameTranslationsTests(unittest.TestCase):
    @patch("services.competitors.competitor_discovery._grounding_context", return_value="")
    @patch("services.competitors.competitor_discovery._ask_for_competitors")
    @patch("services.competitors.business_profile_store.profile_context", return_value="A coffee shop")
    def test_accepted_and_rejected_candidates_carry_display_names(self, _context, ask, _grounding):
        ask.return_value = [
            {"name": "Starbucks", "name_translations": {"ar": "ستاربكس"},
             "website": "https://starbucks.com", "country": "US"},
            {"name": "Mine", "name_translations": {"ar": "ماين"},
             "website": "https://mine.example", "country": "LB"},
        ]

        result = competitor_discovery.discover_competitors(
            {"name": "Mine", "website": "https://mine.example"}, corroborate=False
        )

        self.assertEqual(result["competitors"][0]["name_translations"], {"ar": "ستاربكس"})
        self.assertEqual(result["rejected"][0]["name_translations"], {"ar": "ماين"})


if __name__ == "__main__":
    unittest.main()
