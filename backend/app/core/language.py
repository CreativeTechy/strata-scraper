"""Language handling for user-triggered generated content.

The dashboard sends its active locale in ``Accept-Language``.  Keep the
supported set deliberately aligned with dashboard/src/i18n/config.js so an
unsupported or absent locale has one predictable fallback.
"""

from __future__ import annotations


SUPPORTED_OUTPUT_LANGUAGES = {"en": "English", "ar": "Arabic"}
DEFAULT_OUTPUT_LANGUAGE = "en"


def resolve_output_language(value: str | None) -> str:
    """Return a supported base language from an Accept-Language value."""
    for entry in str(value or "").split(","):
        code = entry.split(";", 1)[0].strip().lower().replace("_", "-").split("-", 1)[0]
        if code in SUPPORTED_OUTPUT_LANGUAGES:
            return code
    return DEFAULT_OUTPUT_LANGUAGE


def output_language_instruction(language: str | None) -> str:
    """Prompt rule that localizes prose while protecting machine values."""
    code = resolve_output_language(language)
    name = SUPPORTED_OUTPUT_LANGUAGES[code]
    return (
        f"Write every human-readable value in {name}. Preserve official names, URLs, "
        "usernames, hashtags, ISO codes, platform identifiers, and JSON keys exactly; "
        "translate only descriptive prose and natural-language search terms."
    )
