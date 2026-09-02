"""Pipeline runs: trigger a scrape, list/inspect runs, and stop one in
flight.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

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

    project_sources = list_sources_for_project(project_id)
    if not project_sources:
        raise HTTPException(status_code=400, detail="Assign at least one source to the selected project before scraping.")

    source_ids = None
    if "source_ids" in payload:
        raw_source_ids = payload.get("source_ids")
        if not isinstance(raw_source_ids, list) or not raw_source_ids:
            raise HTTPException(status_code=400, detail="Select at least one source to scrape.")
        try:
            requested_ids = {int(value) for value in raw_source_ids}
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid source selection.")
        project_source_ids = {int(source["id"]) for source in project_sources}
        source_ids = list(requested_ids & project_source_ids)
        if not source_ids:
            raise HTTPException(status_code=400, detail="None of the selected sources belong to this project.")

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
    }
