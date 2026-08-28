"""Role/permission management: list permissions, and CRUD on roles."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from services.auth import permissions_store
from services.auth.auth import require_permission

router = APIRouter()


@router.get("/api/permissions")
def get_permissions(user: dict = Depends(require_permission("roles.view"))):
    return {"permissions": permissions_store.list_permissions()}


@router.get("/api/roles")
def get_roles(user: dict = Depends(require_permission("roles.view"))):
    return {"roles": permissions_store.list_roles_with_permissions()}


@router.post("/api/roles")
def add_role(payload: dict, user: dict = Depends(require_permission("roles.create"))):
    payload = payload or {}
    name = str(payload.get("name") or "").strip()
    description = str(payload.get("description") or "").strip()
    permission_keys = payload.get("permissions") or []
    if not name:
        raise HTTPException(status_code=400, detail="Role name is required.")

    try:
        role = permissions_store.create_role(name, description, permission_keys)
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"Unable to create role: {e}")
    if not role:
        raise HTTPException(status_code=409, detail="Unable to create role.")
    return {"role": role}


@router.patch("/api/roles/{role_id}")
def edit_role(role_id: int, payload: dict, user: dict = Depends(require_permission("roles.update"))):
    payload = payload or {}
    name = payload.get("name")
    description = payload.get("description")
    permission_keys = payload.get("permissions")

    role = permissions_store.get_role_by_id(role_id)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found.")

    try:
        if name is not None or description is not None:
            permissions_store.update_role(role_id, name=name, description=description)
        if permission_keys is not None and not role.get("full_access"):
            permissions_store.set_role_permissions(role_id, permission_keys)
    except Exception as e:
        raise HTTPException(status_code=409, detail=f"Unable to update role: {e}")

    return {"role": permissions_store.get_role_with_permissions(role_id)}


@router.delete("/api/roles/{role_id}")
def remove_role(role_id: int, user: dict = Depends(require_permission("roles.delete"))):
    try:
        deleted = permissions_store.delete_role(role_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not deleted:
        raise HTTPException(status_code=404, detail="Role not found.")
    return {"ok": True}
