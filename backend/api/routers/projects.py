"""Project management: CRUD, AI-assisted discovery/suggestion, and the
source/user linkage endpoints scoped to one project.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends

from api.deps import ensure_project_visible, visible_project_ids_or_none
from api.errors import ConflictError, ValidationError
from services.auth import permissions_store
from services.auth.auth import require_any_permission, require_permission
from services.projects.project_discovery import discover_project_links
from services.projects.projects_ai import suggest_project_metadata
from services.projects.projects_store import (
    create_project,
    delete_project,
    diagnose_project_setup,
    list_projects,
    list_projects_page,
    set_project_sources,
    set_project_users,
    update_project,
)

router = APIRouter()


@router.get("/api/projects")
def get_projects(limit: int | None = None, offset: int = 0, user: dict = Depends(require_permission("projects.view"))):
    visible_ids = visible_project_ids_or_none(user)
    if limit is None:
        return {"projects": list_projects(visible_project_ids=visible_ids)}
    return list_projects_page(limit=limit, offset=offset, visible_project_ids=visible_ids)


@router.post("/api/projects/discover")
def discover_project(payload: dict, user: dict = Depends(require_permission("projects.create"))):
    if not isinstance(payload, dict):
        payload = {}
    discovery = discover_project_links(payload)
    return {"discovery": discovery}


def _strip_unauthorized_user_ids(payload: dict, user: dict) -> dict:
    """Drop `user_ids` from a project payload unless the caller holds
    projects.link_users, so link management stays gated to that permission
    even though project create/update itself only needs projects.create/update."""
    if not isinstance(payload, dict) or "user_ids" not in payload:
        return payload or {}
    if "projects.link_users" in permissions_store.user_permission_keys(user):
        return payload
    payload = dict(payload)
    payload.pop("user_ids", None)
    return payload


@router.post("/api/projects")
def add_project(background_tasks: BackgroundTasks, payload: dict, user: dict = Depends(require_permission("projects.create"))):
    payload = _strip_unauthorized_user_ids(payload, user)
    try:
        project = create_project(payload or {})
    except ValueError as e:
        raise ValidationError("Invalid project payload.", detail=str(e)) from e
    except Exception as e:
        detail = diagnose_project_setup()
        raise ConflictError(
            "Unable to create project. Check database connection settings.",
            detail=detail or str(e),
        ) from e
    if not project:
        detail = diagnose_project_setup()
        raise ConflictError(
            "Unable to create project. Check database connection settings.",
            detail=detail or "The project request did not return a row.",
        )
    return {"project": project}


@router.put("/api/projects/{project_id}")
def edit_project(project_id: int, background_tasks: BackgroundTasks, payload: dict, user: dict = Depends(require_permission("projects.update"))):
    ensure_project_visible(project_id, user)
    payload = _strip_unauthorized_user_ids(payload, user)
    try:
        project = update_project(project_id, payload or {})
    except ValueError as e:
        raise ValidationError("Invalid project payload.", detail=str(e)) from e
    except Exception as e:
        detail = diagnose_project_setup()
        raise ConflictError(
            "Unable to update project. Check database connection settings.",
            detail=detail or str(e),
        ) from e
    if not project:
        detail = diagnose_project_setup()
        raise ConflictError(
            "Unable to update project. Check database connection settings.",
            detail=detail or "The update request did not return a row.",
        )
    return {"project": project}


@router.post("/api/projects/suggest")
def suggest_project(payload: dict, user: dict = Depends(require_any_permission("projects.create", "projects.update"))):
    if not isinstance(payload, dict):
        payload = {}
    name = str(payload.get("name") or "").strip()
    description = str(payload.get("description") or "").strip()
    if not name:
        raise ValidationError(
            "Project name is required.",
            detail="Provide the project name before requesting AI suggestions.",
        )
    return {"suggestions": suggest_project_metadata(name, description)}


@router.delete("/api/projects/{project_id}")
def remove_project(project_id: int, user: dict = Depends(require_permission("projects.delete"))):
    ensure_project_visible(project_id, user)
    if not delete_project(project_id):
        detail = diagnose_project_setup()
        raise ConflictError(
            "Unable to delete project. Check database connection settings.",
            detail=detail or "The delete request failed.",
        )
    return {"ok": True}


@router.post("/api/projects/{project_id}/sources")
def replace_project_sources(project_id: int, payload: dict, user: dict = Depends(require_permission("projects.update"))):
    ensure_project_visible(project_id, user)
    source_ids = payload.get("source_ids") if isinstance(payload, dict) else []
    assigned = set_project_sources(project_id, source_ids or [])
    return {"project_id": project_id, "source_ids": assigned}


@router.post("/api/projects/{project_id}/users")
def replace_project_users(project_id: int, payload: dict, user: dict = Depends(require_permission("projects.link_users"))):
    ensure_project_visible(project_id, user)
    user_ids = payload.get("user_ids") if isinstance(payload, dict) else []
    assigned = set_project_users(project_id, user_ids or [])
    return {"project_id": project_id, "user_ids": assigned}
