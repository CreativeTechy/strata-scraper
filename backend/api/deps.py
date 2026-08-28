"""Shared HTTP-layer dependencies used by more than one router.

Project visibility in particular: a full_access role sees every project, and
everyone else only sees ones they're linked to via project_users. Enforced
server-side wherever a project id is accepted, whether as a list filter or as
a path parameter for a project-scoped mutation.
"""

from __future__ import annotations

from fastapi import HTTPException

from services.auth import permissions_store
from services.projects.projects_store import list_project_ids_for_user


def visible_project_ids_or_none(user: dict):
    """None means "no restriction" (admin/full_access); otherwise the list of
    project ids this user is linked to via project_users."""
    if permissions_store.user_is_full_access(user):
        return None
    return list_project_ids_for_user(user["id"])


def ensure_project_visible(project_id: int, user: dict) -> None:
    """Defense-in-depth for project-scoped mutations: a non-admin acting on a
    project they can't see gets a 404, same as if it didn't exist."""
    if permissions_store.user_is_full_access(user):
        return
    if int(project_id) not in set(list_project_ids_for_user(user["id"])):
        raise HTTPException(status_code=404, detail="Project not found.")
