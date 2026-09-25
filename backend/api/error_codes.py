"""Stable, translatable codes for the API's error responses.

Every error body keeps its English `error` message (existing clients and
logs read it) and additionally carries `code` - a dotted identifier such as
"users.password_too_short" - plus `params` for any values interpolated into
the message. The dashboard translates `code`/`params` into the UI language
(dashboard/src/i18n/locales/*/apiErrors.json) and falls back to `error` for
a code it doesn't know yet, so a code added here first degrades to today's
English text rather than breaking anything.

Routes don't pass codes themselves: `classify()` recognizes the fixed set of
messages the API raises (below). That keeps the ~80 existing raise sites
unchanged, and a new message that isn't catalogued still gets a generic
per-status code ("http.404") instead of none. An AppError may also name its
code explicitly, which wins over classification - that's how a message
built from free-form exception text (e.g. an unsafe-URL rejection) gets a
code the pattern list can't infer.

Codes are part of the API contract: rename one only together with both
locale files, and never reuse a code for a different meaning.
"""

from __future__ import annotations

import re
from typing import Any

# (code, pattern). Patterns are anchored full matches against the message;
# named groups become `params`. Order matters only where two patterns could
# match the same text, which none currently do.
_CATALOG: list[tuple[str, str]] = [
    # auth / login
    ("auth.credentials_required", r"Username and password are required\."),
    ("auth.invalid_credentials", r"Invalid username or password\."),
    ("auth.too_many_attempts", r"Too many login attempts\. Try again shortly\."),
    ("auth.not_authenticated", r"Not authenticated\."),
    ("auth.csrf_invalid", r"Missing or invalid CSRF token\."),
    ("auth.insufficient_permissions", r"Insufficient permissions\."),
    # users
    ("users.password_too_short", r"Password must be at least (?P<min>\d+) characters\."),
    ("users.unknown_role", r"Unknown role: (?P<role>.+)"),
    ("users.create_failed", r"Unable to create user(?:: .*|\.)"),
    ("users.cannot_modify_self", r"You cannot change your own role or disable yourself\."),
    ("users.cannot_delete_self", r"You cannot delete your own account\."),
    ("users.invalid_status", r"Invalid status: (?P<status>.+)"),
    ("users.not_found", r"User not found\."),
    # roles
    ("roles.name_required", r"Role name is required\."),
    ("roles.create_failed", r"Unable to create role(?:: .*|\.)"),
    ("roles.update_failed", r"Unable to update role(?:: .*|\.)"),
    ("roles.not_found", r"Role not found\."),
    ("roles.system_role", r"This role is required by the system and cannot be deleted\."),
    ("roles.in_use", r"Cannot delete a role that is still assigned to users\."),
    # projects
    ("projects.not_found", r"Project not found\.?"),
    ("projects.invalid_payload", r"Invalid project payload\."),
    ("projects.create_failed", r"Unable to create project\..*"),
    ("projects.update_failed", r"Unable to update project\..*"),
    ("projects.delete_failed", r"Unable to delete project\..*"),
    ("projects.name_required", r"Project name is required\."),
    # sources
    ("sources.create_failed", r"Unable to create source\..*"),
    ("sources.update_failed", r"Unable to update source\..*"),
    ("sources.delete_failed", r"Unable to delete source\..*"),
    # sources - unsafe URL rejection (ssrf_guard.check_url_is_safe); cataloged
    # with params instead of the generic "sources.unsafe_url" explicit code so
    # the specific reason (scheme/host/address) survives translation.
    ("sources.unsafe_scheme", r"URL scheme ['\"](?P<scheme>[^'\"]*)['\"] is not allowed - only http/https are\."),
    ("sources.unsafe_no_host", r"URL has no host\."),
    ("sources.unsafe_unresolvable_host", r"Could not resolve host ['\"](?P<host>[^'\"]*)['\"]: (?P<reason>.+)"),
    ("sources.unsafe_private_address", r"['\"](?P<host>[^'\"]*)['\"] resolves to a non-public address \((?P<ip>[^)]*)\) - refusing to fetch\."),
    # pipeline
    ("pipeline.run_not_found", r"Pipeline run not found\."),
    ("pipeline.no_projects", r"Create a project before running the scraper\."),
    ("pipeline.project_required", r"Select a project before running the scraper\."),
    ("pipeline.no_project_sources", r"Assign at least one source to the selected project before scraping\."),
    ("pipeline.sources_required", r"Select at least one source to scrape\."),
    ("pipeline.invalid_source_selection", r"Invalid source selection\."),
    ("pipeline.sources_not_in_project", r"None of the selected sources belong to this project\."),
    # articles
    ("articles.import_too_large", r"File is larger than the (?P<limit_mb>\d+)MB import limit\..*"),
    ("articles.import_empty", r"The uploaded file is empty\."),
    ("articles.import_not_jsonl", r"Expected JSON Lines \(one article object per line\), not a JSON array\."),
    ("articles.import_run_not_found", r"Import run not found\."),
    ("articles.delete_confirmation_required", r"Pass \?confirm=.+ to confirm this irreversible action\."),
    ("articles.delete_failed", r"Unable to delete articles\."),
    # competitor studies
    ("competitors.study_name_required", r"A study name is required\."),
    ("competitors.study_create_failed", r"Could not create the study\."),
    ("competitors.study_not_found", r"Study not found\.?"),
    ("competitors.study_delete_failed", r"Unable to delete the study\."),
    ("competitors.competitor_not_found", r"Competitor not found\.?"),
    ("competitors.business_name_required", r"A business name is required\."),
    ("competitors.target_countries_invalid", r"target_countries must be a list of ISO country codes\."),
    ("competitors.profile_save_failed", r"Could not save the profile\."),
    ("competitors.profile_required", r"Add the business profile before discovering competitors\."),
    ("competitors.profile_missing", r"Build a business profile for this study first\."),
    ("competitors.target_countries_missing", r"Select target countries on the business profile first\."),
    ("competitors.discovery_run_not_found", r"Discovery run not found\."),
    ("competitors.competitor_name_required", r"A competitor name is required\."),
    ("competitors.competitor_save_failed", r"Could not save the competitor\."),
    ("competitors.sources_not_list", r"sources must be a list\."),
    ("competitors.source_unsupported_type", r"Source (?P<index>\d+): unsupported source type '(?P<platform>.*)'\."),
    ("competitors.source_invalid_value", r"Source (?P<index>\d+): enter a valid value\."),
    ("competitors.invalid_competitor_status", r"status must be suggested, tracked, or ignored\."),
    ("competitors.account_fields_required", r"platform and url are required\."),
    ("competitors.invalid_account_status", r"status must be pending, valid, or rejected\."),
    ("competitors.invalid_repeat_unit", r"repeat_interval_unit must be minutes, hours, or days\."),
    ("competitors.invalid_repeat_value", r"repeat_interval_value must be a positive number\."),
    ("competitors.cultural_analysis_failed", r"The model did not return a usable analysis\."),
    # catch-all handler
    ("internal_error", r"Internal server error\."),
]

_COMPILED = [(code, re.compile(pattern, re.DOTALL)) for code, pattern in _CATALOG]

_INT_PARAMS = {"min", "limit_mb", "index"}


def classify(message: Any, status_code: int | None = None) -> tuple[str | None, dict[str, Any]]:
    """Return (code, params) for an error message.

    Unrecognized messages get the generic "http.<status>" code when a 4xx/5xx
    status is known, else no code at all."""
    if isinstance(message, str):
        text = message.strip()
        for code, pattern in _COMPILED:
            match = pattern.fullmatch(text)
            if match:
                params = {
                    key: int(value) if key in _INT_PARAMS and value.isdigit() else value
                    for key, value in match.groupdict().items()
                    if value is not None
                }
                return code, params
    if status_code and status_code >= 400:
        return f"http.{status_code}", {}
    return None, {}


def error_body(message: Any, status_code: int, *, detail: str | None = None,
               code: str | None = None, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """The {"error", "detail"?, "code"?, "params"?} body every error response uses."""
    if code is None:
        code, inferred = classify(message, status_code)
        params = {**inferred, **(params or {})}
    content: dict[str, Any] = {"error": message}
    if detail:
        content["detail"] = detail
    if code:
        content["code"] = code
    if params:
        content["params"] = params
    return content
