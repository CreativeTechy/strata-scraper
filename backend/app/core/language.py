"""Language handling for user-triggered generated content.

The dashboard sends its active locale in ``Accept-Language``.  Keep the
supported set deliberately aligned with dashboard/src/i18n/config.js so an
unsupported or absent locale has one predictable fallback.
"""

from __future__ import annotations

import re


SUPPORTED_OUTPUT_LANGUAGES = {"en": "English", "ar": "Arabic"}
DEFAULT_OUTPUT_LANGUAGE = "en"


def resolve_output_language(value: str | None) -> str:
    """Return the highest-priority supported language from Accept-Language."""
    candidates: list[tuple[float, int, str]] = []
    for index, entry in enumerate(str(value or "").split(",")):
        parts = [part.strip() for part in entry.split(";")]
        code = parts[0].lower().replace("_", "-").split("-", 1)[0]
        quality = 1.0
        for parameter in parts[1:]:
            if parameter.lower().startswith("q="):
                try:
                    quality = max(0.0, min(1.0, float(parameter[2:])))
                except ValueError:
                    quality = 0.0
        if code in SUPPORTED_OUTPUT_LANGUAGES and quality > 0:
            candidates.append((quality, -index, code))
    if candidates:
        return max(candidates)[2]
    return DEFAULT_OUTPUT_LANGUAGE


def text_matches_output_language(value: object, language: str | None) -> bool:
    """Check that generated prose contains the requested script.

    Machine-only values can legitimately contain no prose, so an empty value
    is accepted. Arabic prose must contain Arabic script; English prose must
    contain Latin script. Callers choose only their human-readable fields.
    """
    if isinstance(value, dict):
        text = " ".join(str(item) for item in value.values())
    elif isinstance(value, (list, tuple, set)):
        text = " ".join(str(item) for item in value)
    else:
        text = str(value or "")
    if not text.strip():
        return True
    arabic_count = len(re.findall(r"[\u0600-\u06ff]", text))
    latin_count = len(re.findall(r"[A-Za-z]", text))
    alphabetic_count = arabic_count + latin_count
    if not alphabetic_count:
        return True
    if resolve_output_language(language) == "ar":
        return arabic_count / alphabetic_count >= 0.2
    return latin_count / alphabetic_count >= 0.2


def output_language_instruction(language: str | None) -> str:
    """Prompt rule that localizes prose while protecting machine values."""
    code = resolve_output_language(language)
    name = SUPPORTED_OUTPUT_LANGUAGES[code]
    return (
        f"Write every human-readable value in {name}. Preserve official names, URLs, "
        "usernames, hashtags, ISO codes, platform identifiers, and JSON keys exactly; "
        "translate only descriptive prose and natural-language search terms."
    )
