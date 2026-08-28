"""How well the business fits the culture(s) it chose to target.

One LLM call against the already-derived business profile (see
business_profile_store.py, which this module deliberately mirrors) and the
project's target_countries. Optional and study-scoped: a study with no target
countries picked never gets one — see build_analysis's guard below.
"""

from __future__ import annotations

import json

from app.core import db
from llm_client import LLMError, chat_completion
from prompt_loader import load_prompt
from services.competitors import business_profile_store
from services.competitors.countries import country_label, validate_countries

PROMPT_VERSION = "cultural-analysis-2026-08-26"

CULTURAL_ANALYSIS_SYSTEM_PROMPT = load_prompt("cultural_analysis_system_prompt.txt")


def _strip_fences(text: str) -> str:
    text = str(text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text
        if text.endswith("```"):
            text = text[:-3]
    return text.strip()


def _as_list(value, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value[:limit]:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def derive_cultural_analysis(profile: dict, target_countries: list[str]) -> dict:
    """Turn a business profile + target countries into a cultural assessment via the LLM."""
    context = business_profile_store.profile_context(profile)
    countries_line = ", ".join(country_label(code) for code in target_countries)
    user_prompt = f"{context}\n\nAssess this business's fit for competing in: {countries_line}"

    try:
        raw = chat_completion(
            messages=[
                {"role": "system", "content": CULTURAL_ANALYSIS_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=1600,
            timeout=90,
        )
        parsed = json.loads(_strip_fences(raw))
    except (LLMError, json.JSONDecodeError, ValueError) as exc:
        print(f"  cultural analysis derivation failed: {exc}")
        return {}

    if not isinstance(parsed, dict):
        return {}

    return {
        "summary": str(parsed.get("summary") or "").strip(),
        "success_factors": _as_list(parsed.get("success_factors")),
        "benefits": _as_list(parsed.get("benefits")),
        "challenges": _as_list(parsed.get("challenges")),
        "insights": _as_list(parsed.get("insights")),
    }


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
COLUMNS = """
    id, project_id, status, target_countries, summary, success_factors,
    benefits, challenges, insights, error, analysis_model, prompt_version,
    generated_at, created_at, updated_at
"""


def get_analysis(project_id: int) -> dict | None:
    return db.fetch_one(
        f"select {COLUMNS} from cultural_analyses where project_id = %s",
        (int(project_id),),
    )


def upsert_analysis(project_id: int, values: dict) -> dict | None:
    from psycopg.types.json import Jsonb

    payload = {
        "status": str(values.get("status") or "pending"),
        "target_countries": Jsonb(validate_countries(values.get("target_countries"))),
        "summary": (str(values.get("summary") or "").strip() or None),
        "success_factors": Jsonb(_as_list(values.get("success_factors"))),
        "benefits": Jsonb(_as_list(values.get("benefits"))),
        "challenges": Jsonb(_as_list(values.get("challenges"))),
        "insights": Jsonb(_as_list(values.get("insights"))),
        "error": (str(values.get("error") or "").strip() or None),
        "analysis_model": (str(values.get("analysis_model") or "").strip() or None),
        "prompt_version": PROMPT_VERSION,
        "generated_at": values.get("generated_at"),
    }

    fields = list(payload)
    assignments = ", ".join(f"{field} = excluded.{field}" for field in fields)
    return db.fetch_one(
        f"""
        insert into cultural_analyses (project_id, {', '.join(fields)})
        values (%s, {', '.join(['%s'] * len(fields))})
        on conflict (project_id) do update set {assignments}
        returning {COLUMNS}
        """,
        (int(project_id), *[payload[field] for field in fields]),
    )


def build_analysis(project_id: int) -> dict:
    """Derive and persist the cultural analysis for a project's business profile.

    Raises ValueError (turned into a 400 by the API layer) if there's no
    profile yet, or the profile has no target countries — there is nothing
    region-specific to analyze in that case.
    """
    profile = business_profile_store.get_profile(project_id)
    if not profile:
        raise ValueError("Build a business profile for this study first.")

    target_countries = validate_countries(profile.get("target_countries"))
    if not target_countries:
        raise ValueError("Select target countries on the business profile first.")

    derived = derive_cultural_analysis(profile, target_countries)

    from app.core import settings as config
    from datetime import datetime, timezone

    saved = upsert_analysis(project_id, {
        "status": "success" if derived else "failed",
        "target_countries": target_countries,
        **derived,
        "error": None if derived else "The model did not return a usable analysis.",
        "analysis_model": config.LLM_CHAT_MODEL if derived else None,
        "generated_at": datetime.now(timezone.utc) if derived else None,
    })
    return saved
