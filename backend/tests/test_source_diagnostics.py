import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ.setdefault("DEEPSEEK_API_KEY", "test-key")

from services.pipeline import source_diagnostics


class LoadSourceDiagnosticsTests(unittest.TestCase):
    def test_missing_workdir_returns_empty_list(self):
        self.assertEqual(source_diagnostics.load_source_diagnostics(""), [])
        self.assertEqual(source_diagnostics.load_source_diagnostics(None), [])

    def test_missing_file_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(source_diagnostics.load_source_diagnostics(tmp), [])

    def test_reads_written_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "source_diagnostics.json").write_text(
                json.dumps([{"source_name": "r/messi", "http_status": 403, "network_blocked": True}]),
                encoding="utf-8",
            )
            result = source_diagnostics.load_source_diagnostics(tmp)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]["source_name"], "r/messi")

    def test_malformed_json_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "source_diagnostics.json").write_text("not json", encoding="utf-8")
            self.assertEqual(source_diagnostics.load_source_diagnostics(tmp), [])

    def test_non_list_json_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "source_diagnostics.json").write_text(json.dumps({"not": "a list"}), encoding="utf-8")
            self.assertEqual(source_diagnostics.load_source_diagnostics(tmp), [])


class BuildFetchNoteTests(unittest.TestCase):
    def test_network_blocked_takes_priority(self):
        note = source_diagnostics.build_fetch_note(
            {"network_blocked": True, "http_status": 403, "note": "should be ignored"}, scraped_count=5
        )
        self.assertIn("Blocked", note)
        self.assertIn("403", note)

    def test_http_error_without_block_flag(self):
        note = source_diagnostics.build_fetch_note({"http_status": 404}, scraped_count=0)
        self.assertIn("HTTP 404", note)

    def test_custom_note_used_when_no_status(self):
        note = source_diagnostics.build_fetch_note({"note": "Request failed: DNS lookup failed"}, scraped_count=0)
        self.assertEqual(note, "Request failed: DNS lookup failed")

    def test_zero_scraped_with_no_diagnostic_at_all(self):
        self.assertEqual(source_diagnostics.build_fetch_note(None, scraped_count=0), "Returned 0 articles.")
        self.assertEqual(source_diagnostics.build_fetch_note({}, scraped_count=0), "Returned 0 articles.")

    def test_healthy_source_has_no_note(self):
        self.assertEqual(source_diagnostics.build_fetch_note({}, scraped_count=5), "")
        self.assertEqual(source_diagnostics.build_fetch_note(None, scraped_count=5), "")


class ClassifyFetchIssueTests(unittest.TestCase):
    def test_known_issue_types_have_professional_messages(self):
        cases = [
            ({"fetch_note": "HTTP 404 for https://x.com/missing", "http_status": 404, "source_type": "username"}, "not_found", "X account not found"),
            ({"fetch_note": "APIFY_API_TOKEN not set - linkedin sources require Apify", "source_type": "linkedin"}, "setup_required", "LinkedIn setup required"),
            ({"fetch_note": "Configure GOOGLE_CSE_API_KEY/GOOGLE_CSE_ENGINE_ID", "source_type": "hashtag"}, "setup_required", "X search setup required"),
            ({"fetch_note": "Blocked", "http_status": 403, "network_blocked": True}, "access_blocked", "Access blocked"),
            ({"fetch_note": "Too many requests", "http_status": 429}, "rate_limited", "Temporarily rate limited"),
            ({"fetch_note": "HTTP 503", "http_status": 503}, "service_unavailable", "Platform temporarily unavailable"),
            ({"fetch_note": "Request failed: timeout"}, "timed_out", "Request timed out"),
            ({"fetch_note": "Request failed: DNS lookup failed"}, "connection_failed", "Connection failed"),
            ({"fetch_note": "Returned 0 articles."}, "no_results", "No articles found"),
            ({"fetch_note": "Unexpected parser problem"}, "fetch_failed", "Source could not be collected"),
        ]
        for values, expected_code, expected_title in cases:
            with self.subTest(expected_code):
                result = source_diagnostics.classify_fetch_issue(**values)
                self.assertEqual(result["code"], expected_code)
                self.assertEqual(result["title"], expected_title)
                self.assertTrue(result["message"])
                self.assertTrue(result["action"])

    def test_technical_detail_removes_headers_and_html_preview(self):
        result = source_diagnostics.classify_fetch_issue(
            "HTTP 404 for https://x.com/missing. Headers: {'Server': 'cloudflare'} Body preview: <html>huge</html>",
            http_status=404,
            source_type="username",
        )
        self.assertEqual(result["technical_detail"], "HTTP 404 for https://x.com/missing.")

    def test_no_issue_returns_none(self):
        self.assertIsNone(source_diagnostics.classify_fetch_issue(""))


class SummarizeNotableDiagnosticsTests(unittest.TestCase):
    def test_empty_list_returns_empty_string(self):
        self.assertEqual(source_diagnostics.summarize_notable_diagnostics([]), "")

    def test_healthy_sources_are_not_notable(self):
        self.assertEqual(source_diagnostics.summarize_notable_diagnostics([{"source_name": "ok-source"}]), "")

    def test_blocked_source_is_notable(self):
        summary = source_diagnostics.summarize_notable_diagnostics([
            {"source_name": "r/messi", "http_status": 403, "network_blocked": True},
        ])
        self.assertIn("1 source(s)", summary)
        self.assertIn("r/messi", summary)
        self.assertIn("blocked", summary)
        self.assertNotIn("403", summary)

    def test_generic_http_error_is_notable(self):
        summary = source_diagnostics.summarize_notable_diagnostics([{"source_name": "example.com", "http_status": 404}])
        self.assertIn("example.com", summary)
        self.assertIn("Source not found", summary)

    def test_note_only_entry_is_notable(self):
        summary = source_diagnostics.summarize_notable_diagnostics([
            {"source_name": "somechannel", "note": "Request failed: timeout"},
        ])
        self.assertIn("somechannel", summary)
        self.assertIn("Request timed out", summary)

    def test_mixed_healthy_and_notable_only_counts_notable(self):
        summary = source_diagnostics.summarize_notable_diagnostics([
            {"source_name": "ok-source"},
            {"source_name": "r/messi", "http_status": 403, "network_blocked": True},
        ])
        self.assertIn("1 source(s)", summary)
        self.assertNotIn("ok-source", summary)


if __name__ == "__main__":
    unittest.main()
