"""User management: list/create/update/delete, and the linkable-users roster
used by the project<->user linkage UI.

First router extracted out of main.py (see CLAUDE.md / the architecture
review's "Recommended Project Structure") - HTTP concerns only, no SQL or
business rules live here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from services.auth import permissions_store, sessions_store, users_store
from services.auth.auth import require_permission
from services.projects.projects_store import project_ids_by_user_map

router = APIRouter()


@router.get("/api/users/linkable")
def get_linkable_users(user: dict = Depends(require_permission("projects.link_users"))):
    """Roster used by the project<->user linkage UI - gated only by
    projects.link_users so it works for admins who manage linkage without
    also holding users.view."""
    project_ids_by_user = project_ids_by_user_map()
    users = [
        {**candidate, "project_ids": project_ids_by_user.get(int(candidate["id"]), [])}
        for candidate in users_store.list_users()
    ]
    return {"users": users}


@router.get("/api/users")
def get_users(user: dict = Depends(require_permission("users.view"))):
    return {"users": users_store.list_users()}


@router.post("/api/users")
def add_user(payload: dict, user: dict = Depends(require_permission("users.create"))):
    payload = payload or {}
    username = str(payload.get("username") or "").strip()
    email = str(payload.get("email") or "").strip()
    password = str(payload.get("password") or "")
    role_name = str(payload.get("role") or "viewer").strip().lower()

    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    role = permissions_store.get_role_by_name(role_name)
    if not role:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role_name}")

    try:
        created = users_store.create_user(username, email, password, role["id"])
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"Unable to create user: {e}")
    if not created:
        raise HTTPException(status_code=409, detail="Unable to create user.")
    return {"user": created}


@router.patch("/api/users/{user_id}")
def edit_user(user_id: int, payload: dict, user: dict = Depends(require_permission("users.update"))):
    payload = payload or {}
    role_name = payload.get("role")
    status = payload.get("status")
    if role_name is not None:
        role_name = str(role_name).strip().lower()
    if status is not None:
        status = str(status).strip().lower()

    if user_id == user["id"] and (role_name is not None or status == "disabled"):
        raise HTTPException(status_code=400, detail="You cannot change your own role or disable yourself.")

    role_id = None
    if role_name is not None:
        role = permissions_store.get_role_by_name(role_name)
        if not role:
            raise HTTPException(status_code=400, detail=f"Unknown role: {role_name}")
        role_id = role["id"]

    try:
        updated = users_store.update_user(user_id, role_id=role_id, status=status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not updated:
        raise HTTPException(status_code=404, detail="User not found.")
    if status == "disabled":
        sessions_store.delete_sessions_for_user(user_id)
    return {"user": updated}


@router.delete("/api/users/{user_id}")
def remove_user(user_id: int, user: dict = Depends(require_permission("users.delete"))):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    sessions_store.delete_sessions_for_user(user_id)
    deleted = users_store.delete_user(user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found.")
    return {"ok": True}
