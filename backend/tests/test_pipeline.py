import os
import unittest
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from fastapi import HTTPException

from api.routers import pipeline as pipeline_router
from services.pipeline import pipeline


class PipelineModuleImportTests(unittest.TestCase):
    """pipeline.py's own logic is subprocess orchestration (not practically
    unit-testable without spawning real scrapy/enrich subprocesses) - it
    delegates the actual diagnostics parsing/summarizing to
    services/pipeline/source_diagnostics.py, see test_source_diagnostics.py.
    This just guards the wiring between them stays importable."""

    def test_module_exposes_diagnostics_helpers_it_delegates_to(self):
        self.assertTrue(callable(pipeline.load_source_diagnostics))
        self.assertTrue(callable(pipeline.summarize_notable_diagnostics))


class _CapturedBackgroundTasks:
    def __init__(self):
        self.calls = []

    def add_task(self, func, *args, **kwargs):
        self.calls.append((func, args, kwargs))


class ManualRunSourceSelectionTests(unittest.TestCase):
    SOURCES = [
        {"id": 10, "url": "https://example.com/one", "enabled": True},
        {"id": 20, "url": "https://example.com/two", "enabled": True},
        {"id": 30, "url": "https://example.com/off", "enabled": False},
    ]

    def _trigger(self, payload):
        tasks = _CapturedBackgroundTasks()
        patches = [
            patch.object(pipeline_router, "ensure_project_visible"),
            patch.object(pipeline_router, "list_sources_for_project", return_value=self.SOURCES),
            patch.object(pipeline_router, "get_active_run_for_project", return_value=None),
            patch.object(pipeline_router, "create_pipeline_run", return_value={"id": "run-42"}),
        ]
        for active_patch in patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)
        response = pipeline_router.trigger_scrape(tasks, payload, {"id": 7})
        return response, tasks

    def test_selected_source_ids_are_passed_to_the_background_pipeline(self):
        response, tasks = self._trigger({"project_id": 5, "source_ids": [20, 10, 20]})

        self.assertEqual(response["source_ids"], [20, 10])
        self.assertEqual(len(tasks.calls), 1)
        self.assertIs(tasks.calls[0][0], pipeline_router.run_scraper_pipeline)
        self.assertEqual(tasks.calls[0][1], ("run-42", 5, [20, 10]))

    def test_omitted_source_ids_preserve_the_all_project_sources_behavior(self):
        response, tasks = self._trigger({"project_id": 5})

        self.assertIsNone(response["source_ids"])
        self.assertEqual(tasks.calls[0][1], ("run-42", 5, None))

    def test_an_empty_selection_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self._trigger({"project_id": 5, "source_ids": []})

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("at least one source", raised.exception.detail.lower())

    def test_a_source_outside_the_project_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self._trigger({"project_id": 5, "source_ids": [999]})

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("assigned", raised.exception.detail.lower())

    def test_a_disabled_source_is_rejected(self):
        with self.assertRaises(HTTPException) as raised:
            self._trigger({"project_id": 5, "source_ids": [30]})

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("disabled", raised.exception.detail.lower())


if __name__ == "__main__":
    unittest.main()
