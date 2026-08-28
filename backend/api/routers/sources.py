"""Source management: the dashboard sidebar list, and CRUD on individual
source records.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from api.errors import ConflictError
from services.auth.auth import require_permission
from services.sources.sources_store import (
    bootstrap_sources,
    create_source,
    delete_source,
    diagnose_source_setup,
    list_sources_page,
    update_source,
)
from ssrf_guard import UnsafeUrlError

router = APIRouter()


@router.get("/api/sources")
def get_sources(limit: int | None = None, offset: int = 0, user: dict = Depends(require_permission("sources.view"))):
    """Configured sources for the dashboard sidebar."""
    if limit is None:
        sources = bootstrap_sources()
        source = sources[0].get("source", "database") if sources else "database"
        return {"sources": sources, "source": source}

    page = list_sources_page(limit=limit, offset=offset)
    source = page["sources"][0].get("source", "database") if page["sources"] else "database"
    return {**page, "source": source}


@router.post("/api/sources")
def add_source(payload: dict, user: dict = Depends(require_permission("sources.create"))):
    """Create or update a source record in local PostgreSQL."""
    try:
        source = create_source(payload or {})
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not source:
        detail = diagnose_source_setup()
        raise ConflictError(
            "Unable to create source. Check database connection settings.",
            detail=detail or "The source request did not return a row.",
        )
    return {"source": source}


@router.put("/api/sources/{source_id}")
def edit_source(source_id: int, payload: dict, user: dict = Depends(require_permission("sources.update"))):
    """Update a source record in local PostgreSQL."""
    try:
        source = update_source(source_id, payload or {})
    except UnsafeUrlError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not source:
        detail = diagnose_source_setup()
        raise ConflictError(
            "Unable to update source. Check database connection settings.",
            detail=detail or "The update request did not return a row.",
        )
    return {"source": source}


@router.delete("/api/sources/{source_id}")
def remove_source(source_id: int, user: dict = Depends(require_permission("sources.delete"))):
    """Delete a source record from local PostgreSQL."""
    if not delete_source(source_id):
        detail = diagnose_source_setup()
        raise ConflictError(
            "Unable to delete source. Check database connection settings.",
            detail=detail or "The delete request failed.",
        )
    return {"ok": True}
