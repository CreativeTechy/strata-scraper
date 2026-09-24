"""Language handling for user-triggered generated content.

The dashboard sends its active locale in ``Accept-Language``.  Keep the
supported set deliberately aligned with dashboard/src/i18n/config.js so an
unsupported or absent locale has one predictable fallback.
"""

from __future__ import annotations

import unicodedata

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
    """Check every generated prose field against the requested script.

    An empty value is accepted because callers may have optional prose fields.
    A non-empty value with no letters is rejected: punctuation or digits are
    not meaningful generated prose. Checking each nested string independently
    prevents one long translated field from hiding another field written in
    the wrong language. All Unicode letters count toward the denominator, so
    text written in an unsupported script cannot pass as language-neutral.
    """
    def prose_fields(item: object):
        if isinstance(item, dict):
            for nested in item.values():
                yield from prose_fields(nested)
        elif isinstance(item, (list, tuple, set)):
            for nested in item:
                yield from prose_fields(nested)
        elif item is not None:
            text = str(item).strip()
            if text:
                yield text

    target = resolve_output_language(language)
    for text in prose_fields(value):
        alphabetic_count = sum(character.isalpha() for character in text)
        if not alphabetic_count:
            return False
        script_name = "ARABIC" if target == "ar" else "LATIN"
        target_count = sum(
            character.isalpha()
            and script_name in unicodedata.name(character, "")
            for character in text
        )
        # Generated prose should predominantly use the requested script while
        # still allowing embedded official names such as Starbucks or TikTok.
        if target_count / alphabetic_count < 0.5:
            return False
    return True


def output_language_instruction(language: str | None) -> str:
    """Prompt rule that localizes prose while protecting machine values."""
    code = resolve_output_language(language)
    name = SUPPORTED_OUTPUT_LANGUAGES[code]
    return (
        f"Write every human-readable value in {name}. Preserve official names, URLs, "
        "usernames, hashtags, ISO codes, platform identifiers, and JSON keys exactly; "
        "translate only descriptive prose and natural-language search terms."
    )
