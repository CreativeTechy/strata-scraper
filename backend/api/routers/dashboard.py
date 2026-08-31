"""Dashboard homepage: one aggregate read per selected project, shaped
differently for an opinion-monitor project vs. a competitor study - see
services/dashboard/dashboard_store.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from api.deps import ensure_project_visible
from services.auth.auth import require_permission
from services.dashboard.dashboard_store import get_dashboard_summary

router = APIRouter()


@router.get("/api/dashboard/summary")
def get_summary(project_id: int, user: dict = Depends(require_permission("articles.view"))):
    ensure_project_visible(project_id, user)
    summary = get_dashboard_summary(project_id)
    if not summary:
        raise HTTPException(status_code=404, detail="Project not found")
    return summary
