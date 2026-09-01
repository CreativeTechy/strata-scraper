"""Pipeline runs: trigger a scrape, list/inspect runs, and stop one in
flight.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from api.deps import ensure_project_visible
from services.auth.auth import require_permission
from services.pipeline.pipeline import cancel_pipeline_run, run_scraper_pipeline
from services.pipeline.pipeline_runs import (
    ACTIVE_STATUSES,
    create_pipeline_run,
    get_active_run_for_project,
    get_pipeline_run,
    get_pipeline_run_sources,
    list_pipeline_runs,
    update_pipeline_run,
)
from services.projects.projects_store import list_projects, list_sources_for_project, record_run_completion

router = APIRouter()


def _selected_source_ids(payload: dict) -> list[int] | None:
    """Normalize the optional manual-run source allowlist.

    Missing means "all project sources" so scheduler and older API callers
    keep their existing behavior. An explicitly empty list is different: the
    user unchecked every source, so there is no useful run to queue.
    """
    if "source_ids" not in payload:
        return None

    raw_ids = payload.get("source_ids")
    if not isinstance(raw_ids, list):
        raise HTTPException(status_code=400, detail="source_ids must be a list of source IDs.")

    source_ids = []
    seen = set()
    for raw_id in raw_ids:
        if isinstance(raw_id, bool):
            raise HTTPException(status_code=400, detail="source_ids must contain positive integers.")
        try:
            source_id = int(raw_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="source_ids must contain positive integers.") from exc
        if source_id <= 0:
            raise HTTPException(status_code=400, detail="source_ids must contain positive integers.")
        if source_id not in seen:
            seen.add(source_id)
            source_ids.append(source_id)

    if not source_ids:
        raise HTTPException(status_code=400, detail="Select at least one source before running the scraper.")
    return source_ids


@router.get("/api/pipeline-runs")
def get_pipeline_runs(
    limit: int = 10,
    project_id: int | None = None,
    user: dict = Depends(require_permission("pipeline.view")),
):
    return {"runs": list_pipeline_runs(limit=max(1, min(int(limit), 500)), project_id=project_id)}


@router.get("/api/pipeline-runs/{run_id}")
def get_pipeline_run_detail(run_id: str, user: dict = Depends(require_permission("pipeline.view"))):
    run = get_pipeline_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Pipeline run not found.")
    return {"run": run, "sources": get_pipeline_run_sources(run_id) if run.get("has_detail") else []}


@router.post("/api/pipeline-runs/{run_id}/stop")
def stop_pipeline_run(run_id: str, user: dict = Depends(require_permission("pipeline.stop"))):
    run = get_pipeline_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Pipeline run not found.")

    if run["status"] not in ACTIVE_STATUSES:
        return {"run": run, "message": f"Run is already {run['status']}; nothing to stop."}

    cancel_pipeline_run(run_id)

    now = datetime.now(timezone.utc).isoformat()
    updated = update_pipeline_run(
        run_id,
        status="cancelled",
        stage="cancelled",
        message="Cancelled by user.",
        cancel_requested_at=now,
        cancelled_at=now,
        finished_at=now,
    )
    if run.get("project_id") is not None:
        record_run_completion(run["project_id"], status="cancelled", completed_at=datetime.now(timezone.utc))

    return {"run": updated or run, "message": "Pipeline run cancelled."}


@router.post("/scrape")
def trigger_scrape(background_tasks: BackgroundTasks, payload: dict | None = None, user: dict = Depends(require_permission("pipeline.run"))):
    payload = payload or {}
    source_ids = _selected_source_ids(payload)
    project_id = payload.get("project_id")
    try:
        project_id = int(project_id) if project_id is not None else None
    except Exception:
        project_id = None
    if project_id is None:
        projects = list_projects()
        if len(projects) == 1:
            project_id = projects[0].get("id")
        elif not projects:
            raise HTTPException(status_code=400, detail="Create a project before running the scraper.")
        else:
            raise HTTPException(status_code=400, detail="Select a project before running the scraper.")

    ensure_project_visible(project_id, user)
    project_sources = list_sources_for_project(project_id)
    if not project_sources:
        raise HTTPException(status_code=400, detail="Assign at least one source to the selected project before scraping.")

    if source_ids is not None:
        sources_by_id = {int(source["id"]): source for source in project_sources if source.get("id") is not None}
        unavailable_ids = [source_id for source_id in source_ids if source_id not in sources_by_id]
        if unavailable_ids:
            raise HTTPException(
                status_code=400,
                detail="Every selected source must be assigned to the selected project.",
            )
        disabled_ids = [source_id for source_id in source_ids if not sources_by_id[source_id].get("enabled", True)]
        if disabled_ids:
            raise HTTPException(status_code=400, detail="Disabled sources cannot be included in a manual run.")

    active_run = get_active_run_for_project(project_id)
    if active_run:
        return {
            "message": "A pipeline run is already active for this project.",
            "run_id": active_run["id"],
            "project_id": project_id,
        }

    run = create_pipeline_run(status="queued", stage="queued", message="Queued for execution.", project_id=project_id)
    run_id = run["id"] if run else uuid.uuid4().hex
    background_tasks.add_task(run_scraper_pipeline, run_id, project_id, source_ids)
    return {
        "message": "Scraper pipeline triggered. It will save to local PostgreSQL when finished.",
        "run_id": run_id,
        "project_id": project_id,
        "source_ids": source_ids,
    }
