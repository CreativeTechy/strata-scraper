"""Collection-provider (Apify) settings: per-actor name, post cap and timeout,
plus each actor's list price. See services/settings/apify_settings.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from api.errors import ValidationError
from services.auth.auth import require_permission
from services.settings import apify_settings

router = APIRouter()


@router.get("/api/settings/apify")
def get_apify_settings(user: dict = Depends(require_permission("settings.view"))):
    return apify_settings.view()


@router.put("/api/settings/apify")
def put_apify_settings(payload: dict, user: dict = Depends(require_permission("settings.update"))):
    values = (payload or {}).get("values")
    if not isinstance(values, dict):
        raise ValidationError("Request body must include a 'values' object.")
    apify_settings.save_overrides(values, updated_by=user.get("username"))
    return apify_settings.view()


@router.get("/api/settings/apify/pricing")
def get_apify_pricing(refresh: bool = False, user: dict = Depends(require_permission("settings.view"))):
    # Prices the actors currently in force, so it reflects saved (not unsaved) names.
    return {"pricing": apify_settings.all_pricing(refresh=refresh)}
