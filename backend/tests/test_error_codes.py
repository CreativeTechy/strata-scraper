import json
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("OPENAI_API_KEY", "test-key")

from fastapi import HTTPException
from fastapi.testclient import TestClient

from api import error_codes
from api.errors import ValidationError
from services.auth import auth
from ssrf_guard import UnsafeUrlError
import main

LOCALES = Path(__file__).resolve().parents[2] / "dashboard" / "src" / "i18n" / "locales"


def _lookup(tree, dotted):
    node = tree
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


class ClassifyTests(unittest.TestCase):
    def test_fixed_messages_get_their_code(self):
        self.assertEqual(
            error_codes.classify("Invalid username or password.", 401),
            ("auth.invalid_credentials", {}),
        )
        self.assertEqual(error_codes.classify("Project not found", 404), ("projects.not_found", {}))
        self.assertEqual(error_codes.classify("Project not found.", 404), ("projects.not_found", {}))

    def test_interpolated_values_become_params(self):
        self.assertEqual(
            error_codes.classify("Password must be at least 8 characters.", 400),
            ("users.password_too_short", {"min": 8}),
        )
        self.assertEqual(
            error_codes.classify("Unknown role: auditor", 400),
            ("users.unknown_role", {"role": "auditor"}),
        )
        self.assertEqual(
            error_codes.classify("Source 2: unsupported source type 'myspace'.", 400),
            ("competitors.source_unsupported_type", {"index": 2, "platform": "myspace"}),
        )
        self.assertEqual(
            error_codes.classify("File is larger than the 512MB import limit. Split it and import in parts.", 413),
            ("articles.import_too_large", {"limit_mb": 512}),
        )

    def test_unsafe_url_reasons_keep_their_specifics(self):
        # These are ssrf_guard.check_url_is_safe's exact messages (see
        # backend/ssrf_guard.py) - classify() must recognize each one so the
        # dashboard can show *why* the URL was rejected, not just that it was.
        self.assertEqual(
            error_codes.classify("URL scheme 'ftp' is not allowed - only http/https are.", 400),
            ("sources.unsafe_scheme", {"scheme": "ftp"}),
        )
        self.assertEqual(
            error_codes.classify("URL has no host.", 400),
            ("sources.unsafe_no_host", {}),
        )
        self.assertEqual(
            error_codes.classify(
                "Could not resolve host 'nonexistent.invalid': [Errno -2] Name or service not known", 400,
            ),
            ("sources.unsafe_unresolvable_host", {
                "host": "nonexistent.invalid",
                "reason": "[Errno -2] Name or service not known",
            }),
        )
        self.assertEqual(
            error_codes.classify(
                "'internal.example.com' resolves to a non-public address (10.0.0.1) - refusing to fetch.", 400,
            ),
            ("sources.unsafe_private_address", {"host": "internal.example.com", "ip": "10.0.0.1"}),
        )

    def test_unknown_messages_fall_back_to_a_status_code(self):
        self.assertEqual(error_codes.classify("Something nobody catalogued.", 409), ("http.409", {}))
        self.assertEqual(error_codes.classify({"not": "a string"}, 400), ("http.400", {}))
        self.assertEqual(error_codes.classify("anything"), (None, {}))

    def test_explicit_code_wins_over_classification(self):
        body = error_codes.error_body("Invalid username or password.", 400, code="custom.code", params={"a": 1})
        self.assertEqual(body, {"error": "Invalid username or password.", "code": "custom.code", "params": {"a": 1}})


class LocaleCoverageTests(unittest.TestCase):
    """Every code the API can emit must have a dashboard translation in every
    locale, with the same {{placeholders}} as the params the backend sends -
    otherwise the dashboard silently falls back to the English message."""

    def test_every_catalogued_code_is_translated_in_every_locale(self):
        locales = sorted(path.name for path in LOCALES.iterdir() if path.is_dir())
        self.assertIn("en", locales)
        self.assertIn("ar", locales)
        for locale in locales:
            messages = json.loads((LOCALES / locale / "apiErrors.json").read_text(encoding="utf-8"))
            for code, pattern in error_codes._CATALOG:
                with self.subTest(locale=locale, code=code):
                    text = _lookup(messages, code)
                    self.assertIsInstance(text, str)
                    self.assertTrue(text.strip())
                    expected = set(re.compile(pattern).groupindex)
                    self.assertEqual(set(re.findall(r"\{\{(\w+)\}\}", text)), expected)
            for code in ("sources.unsafe_url", "http.400", "http.404", "http.500",
                         "articles.import_line_invalid_json", "articles.import_line_not_object",
                         "articles.import_line_missing_url"):
                with self.subTest(locale=locale, code=code):
                    self.assertIsInstance(_lookup(messages, code), str)


class ResponseShapeTests(unittest.TestCase):
    """The English `error` stays exactly as before; `code`/`params` are added."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app, raise_server_exceptions=False)

    def test_login_validation_error_carries_a_code(self):
        res = self.client.post("/api/auth/login", json={"username": "", "password": ""})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(
            res.json(),
            {"error": "Username and password are required.", "code": "auth.credentials_required"},
        )

    def test_unauthenticated_request_carries_a_code(self):
        res = self.client.get("/api/sources")
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.json(), {"error": "Not authenticated.", "code": "auth.not_authenticated"})

    def test_http_exception_headers_are_preserved(self):
        import asyncio
        res = asyncio.run(main._http_exception_handler(None, HTTPException(
            status_code=429, detail="Too many login attempts. Try again shortly.", headers={"Retry-After": "7"},
        )))
        self.assertEqual(res.headers.get("retry-after"), "7")
        self.assertEqual(json.loads(res.body)["code"], "auth.too_many_attempts")

    def test_app_error_explicit_code_and_detail(self):
        import asyncio
        res = asyncio.run(main._app_error_handler(None, ValidationError(
            "Blocked host: 10.0.0.1", code="sources.unsafe_url",
        )))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(json.loads(res.body), {"error": "Blocked host: 10.0.0.1", "code": "sources.unsafe_url"})

    def test_unhandled_exception_carries_a_code(self):
        import asyncio
        with patch.object(main.logger, "exception"):
            res = asyncio.run(main._unhandled_exception_handler(
                type("R", (), {"method": "GET", "url": type("U", (), {"path": "/x"})()})(), RuntimeError("boom"),
            ))
        self.assertEqual(res.status_code, 500)
        self.assertEqual(json.loads(res.body), {"error": "Internal server error.", "code": "internal_error"})


def _fake_get_current_user():
    return {"id": 1, "username": "admin", "role_id": 1, "status": "active"}


class UnsafeUrlRouteTests(unittest.TestCase):
    """POST /api/sources with a URL ssrf_guard rejects must carry the specific
    reason's code, not the generic "sources.unsafe_url" one - see F001 on
    PR #28."""

    @classmethod
    def setUpClass(cls):
        main.app.dependency_overrides[auth.get_current_user] = _fake_get_current_user
        cls._patchers = [
            patch("services.auth.auth._enforce_csrf"),
            patch("services.auth.permissions_store.user_permission_keys", return_value={"sources.create"}),
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

    def test_disallowed_scheme_carries_the_scheme_specific_code(self):
        with patch("api.routers.sources.create_source", side_effect=UnsafeUrlError(
            "URL scheme 'ftp' is not allowed - only http/https are.",
        )):
            res = self.client.post("/api/sources", json={"url": "ftp://example.com", "type": "web"})
        self.assertEqual(res.status_code, 400)
        body = res.json()
        self.assertEqual(body["code"], "sources.unsafe_scheme")
        self.assertEqual(body["params"], {"scheme": "ftp"})
        self.assertEqual(body["error"], "URL scheme 'ftp' is not allowed - only http/https are.")

    def test_private_address_carries_the_address_specific_code(self):
        with patch("api.routers.sources.create_source", side_effect=UnsafeUrlError(
            "'internal.example.com' resolves to a non-public address (10.0.0.1) - refusing to fetch.",
        )):
            res = self.client.post("/api/sources", json={"url": "http://internal.example.com", "type": "web"})
        self.assertEqual(res.status_code, 400)
        body = res.json()
        self.assertEqual(body["code"], "sources.unsafe_private_address")
        self.assertEqual(body["params"], {"host": "internal.example.com", "ip": "10.0.0.1"})


if __name__ == "__main__":
    unittest.main()
