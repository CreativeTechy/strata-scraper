"""AI helpers for project metadata drafting."""

from __future__ import annotations

import json
import re
from collections import Counter

from app.core import settings as config
from app.core.language import (
    output_language_instruction,
    resolve_output_language,
    text_matches_output_language,
)
from llm_client import chat_completion

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "have",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "with",
    "your",
    "their",
    "our",
    "will",
    "about",
    "into",
    "over",
    "after",
    "before",
    "more",
    "than",
    "than",
}


def _clean_text(value):
    return " ".join(str(value or "").strip().split())


def _extract_json_blob(text):
    raw = _clean_text(text)
    if not raw:
        return ""
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        if raw.endswith("```"):
            raw = raw[:-3]
    raw = raw.strip()
    if raw:
        return raw
    match = re.search(r"\{.*\}", text or "", re.S)
    return match.group(0).strip() if match else ""


def _normalize_items(values, prefix="#", limit=6):
    if isinstance(values, str):
        values = [part.strip() for part in re.split(r"[\n,]", values)]
    elif not isinstance(values, list):
        values = [values]

    cleaned = []
    seen = set()
    for value in values:
        text = _clean_text(value)
        if not text:
            continue
        if prefix and text.startswith(prefix):
            text = text[len(prefix):].strip()
        text = re.sub(r"\s+", " ", text)
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(f"{prefix}{text}" if prefix else text)
        if len(cleaned) >= limit:
            break
    return cleaned


def _normalize_usernames(values, limit=8):
    if isinstance(values, str):
        values = [part.strip() for part in re.split(r"[\n,]", values)]
    elif not isinstance(values, list):
        values = [values]

    cleaned = []
    seen = set()
    for value in values:
        text = _clean_text(value)
        if not text:
            continue
        text = text.replace("https://x.com/", "").replace("https://twitter.com/", "")
        text = text.replace("http://x.com/", "").replace("http://twitter.com/", "")
        text = text.split("/", 1)[0].strip()
        if text.startswith("@"):
            text = text[1:].strip()
        text = re.sub(r"[^A-Za-z0-9_]", "", text)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(f"@{text}")
        if len(cleaned) >= limit:
            break
    return cleaned


def _username_profile_urls(usernames):
    urls = []
    seen = set()
    for username in usernames or []:
        handle = re.sub(r"^@", "", str(username or "").strip())
        handle = re.sub(r"[^A-Za-z0-9_]", "", handle)
        if not handle:
            continue
        key = handle.lower()
        if key in seen:
            continue
        seen.add(key)
        urls.append(f"https://x.com/{handle}")
    return urls


def _keyword_candidates(name, description):
    text = f"{name} {description}".lower()
    # ``[^\W_]`` is a Unicode letter/digit. The old ASCII-only expression
    # silently returned no candidates for an Arabic project when the LLM was
    # unavailable, which made the localized fallback mostly empty.
    words = re.findall(r"[^\W_][^\W_&+-]{2,}", text, re.UNICODE)
    counts = Counter(
        word for word in words
        if word not in STOPWORDS and not word.isdigit()
    )
    return [word for word, _ in counts.most_common(12)]


def _fallback_metadata(name, description, output_language="en"):
    language = resolve_output_language(output_language)
    keyword_candidates = _keyword_candidates(name, description)
    if language == "ar":
        # Keep the project name as an official term, but do not turn English
        # description words into supposedly localized search keywords when the
        # model is unavailable or returns the wrong language.
        keywords = []
        for value in [name, *keyword_candidates]:
            text = _clean_text(value)
            if not text or text in keywords:
                continue
            if text.casefold() == name.casefold() or text_matches_output_language(text, language):
                keywords.append(text)
    else:
        keywords = keyword_candidates
    hashtags = _normalize_items([name] + keywords[:4], prefix="#", limit=5)
    usernames = _normalize_usernames([name] + keywords[:4], limit=4)
    target_audience = ""
    if language == "ar":
        if keywords:
            target_audience = f"المهتمون بـ {keywords[0].replace('-', ' ')} وآخر المستجدات ذات الصلة"
        elif name:
            target_audience = f"المتابعون لـ {name}"
        else:
            target_audience = "القراء والمتخصصون المتابعون للموضوع"
    elif keywords:
        target_audience = f"People interested in {keywords[0].replace('-', ' ')} and related updates"
    elif name:
        target_audience = f"People following {name}"
    else:
        target_audience = "Readers and professionals tracking the topic"
    return {
        "target_audience": target_audience,
        "hashtags": hashtags,
        "keywords": [word.replace("-", " ") for word in keywords[:6]],
        "usernames": usernames,
        "profile_urls": _username_profile_urls(usernames),
        "source": "heuristic",
    }


def _keyword_is_official_identifier(value: str, project_name: str) -> bool:
    text = _clean_text(value)
    if not text:
        return False
    if text.casefold() == _clean_text(project_name).casefold():
        return True
    if " " in text:
        return False
    return (
        any(character.isupper() for character in text[1:])
        or (text.isupper() and 1 < len(text) <= 10)
        or any(character.isdigit() for character in text)
    )


def suggest_project_metadata(name, description, output_language="en"):
    """Return suggested target audience, hashtags, keywords, and usernames for a project."""
    name = _clean_text(name)
    description = _clean_text(description)
    output_language = resolve_output_language(output_language)

    fallback = _fallback_metadata(name, description, output_language)
    if not config.LLM_API_KEY or not name:
        return fallback

    prompt = (
        "You are helping craft metadata for a news/project tracking workspace.\n"
        "Given the project name and description, return ONLY JSON with this shape:\n"
        '{ "target_audience": "string", "hashtags": ["string"], "keywords": ["string"], "usernames": ["string"] }\n'
        "Rules:\n"
        "- Keep hashtags and keywords tightly related to the project.\n"
        "- Return usernames as bare handles or @handles for official social profiles only when they are strongly relevant.\n"
        "- Normalize usernames to X/Twitter profile handles, not full URLs.\n"
        "- Return 3 to 6 hashtags and 4 to 8 keywords.\n"
        "- Return 0 to 5 usernames.\n"
        "- Target audience should be a short plain-language phrase.\n"
        f"- {output_language_instruction(output_language)}\n"
        "- Do not include markdown or commentary.\n\n"
        f"Project name: {name}\n"
        f"Project description: {description or '(none)'}\n"
    )

    try:
        content = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=400,
            timeout=35,
        )
        payload = json.loads(_extract_json_blob(content))
        if not isinstance(payload, dict):
            return fallback
    except Exception:
        return fallback

    target_audience = _clean_text(payload.get("target_audience")) or fallback["target_audience"]
    hashtags = _normalize_items(payload.get("hashtags") or [], prefix="#", limit=6)
    keywords = _normalize_items(payload.get("keywords") or [], prefix="", limit=8)
    usernames = _normalize_usernames(payload.get("usernames") or [], limit=5)

    localized_values = [target_audience, *(
        keyword for keyword in keywords
        if not _keyword_is_official_identifier(keyword, name)
    )]
    if not text_matches_output_language(localized_values, output_language):
        return fallback

    return {
        "target_audience": target_audience,
        "hashtags": hashtags or fallback["hashtags"],
        "keywords": keywords or fallback["keywords"],
        "usernames": usernames or fallback["usernames"],
        "profile_urls": _username_profile_urls(usernames or fallback["usernames"]),
        "source": config.LLM_PROVIDER,
    }
