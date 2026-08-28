"""Article reads (list/stats/export), the async JSONL import job, and the
irreversible delete-all endpoint.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from api.deps import ensure_project_visible
from api.errors import ConflictError
from services.articles.articles_store import export_articles, get_article_stats, list_articles
from services.articles.import_jobs import create_import_run, get_import_run, run_import_job
from services.auth.auth import require_permission

router = APIRouter()

# Keep <= nginx/default.conf's client_max_body_size - above it, a file under
# this limit still gets nginx's generic 413 instead of the "split it and
# import in parts" message below.
MAX_IMPORT_BYTES = 256 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024


@router.get("/api/articles")
def get_articles(
    search: str | None = None,
    project_id: int | None = None,
    source_url: str | None = None,
    limit: int = 24,
    offset: int = 0,
    sort: str = "published.desc",
    scraped_from: str | None = None,
    scraped_to: str | None = None,
    user: dict = Depends(require_permission("articles.view")),
):
    return list_articles(
        search=search,
        project_id=project_id,
        source_url=source_url,
        limit=limit,
        offset=offset,
        sort=sort,
        scraped_from=scraped_from,
        scraped_to=scraped_to,
    )


@router.get("/api/articles/stats")
def get_articles_stats(
    search: str | None = None,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    user: dict = Depends(require_permission("articles.view")),
):
    return get_article_stats(search=search, project_id=project_id, date_from=date_from, date_to=date_to)


@router.get("/api/articles/export")
def export_articles_jsonl(
    search: str | None = None,
    project_id: int | None = None,
    source_url: str | None = None,
    sort: str = "published.desc",
    scraped_from: str | None = None,
    scraped_to: str | None = None,
    user: dict = Depends(require_permission("articles.view")),
):
    def line_stream():
        # export_articles() is a generator, so rows are read a page at a time
        # as the response is written - no project's worth of articles (each
        # carrying its full text and embedding) is ever held in memory at once.
        rows = export_articles(
            search=search,
            project_id=project_id,
            source_url=source_url,
            sort=sort,
            scraped_from=scraped_from,
            scraped_to=scraped_to,
        )
        for row in rows:
            yield json.dumps(row, ensure_ascii=False, default=str) + "\n"

    filename = "articles-export.jsonl"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "application/x-ndjson; charset=utf-8",
    }
    return StreamingResponse(line_stream(), headers=headers, media_type="application/x-ndjson")


@router.post("/api/articles/import")
async def import_articles_jsonl(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    project_id: int | None = Form(None),
    user: dict = Depends(require_permission("articles.import")),
):
    """Queue a JSONL export produced by GET /api/articles/export for import.

    Restoring a project means an upsert per article, each of which also writes
    its project link, story group and idea clusters - minutes of work for a
    real export, well past any gateway timeout. So the request only spools the
    upload to disk and returns a run id; the work happens in
    import_jobs.run_import_job and the UI polls GET .../import/{run_id} for
    live counts and throughput. Same queued/poll shape as competitor discovery.

    Only what can be judged from the bytes themselves is rejected here, so an
    oversized or plainly wrong file still fails fast with a real status code.
    """
    if project_id is not None:
        ensure_project_visible(project_id, user)

    handle, path = tempfile.mkstemp(prefix="articles-import-", suffix=".jsonl")
    total_bytes = 0
    total_lines = 0
    leading = b""
    last_byte = b""

    try:
        with os.fdopen(handle, "wb") as spool:
            while True:
                chunk = await file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > MAX_IMPORT_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File is larger than the {MAX_IMPORT_BYTES // (1024 * 1024)}MB import limit. "
                            "Split it and import in parts."
                        ),
                    )
                if len(leading) < 64:
                    leading += chunk[: 64 - len(leading)]
                # Counting newlines as they stream past costs nothing and gives
                # the job a record-count estimate for its percentage and ETA.
                total_lines += chunk.count(b"\n")
                last_byte = chunk[-1:]
                spool.write(chunk)
        if total_bytes and last_byte != b"\n":
            total_lines += 1

        if not total_bytes:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")
        if leading.lstrip()[:1] == b"[":
            raise HTTPException(
                status_code=400,
                detail="Expected JSON Lines (one article object per line), not a JSON array.",
            )
    except Exception:
        with contextlib.suppress(OSError):
            os.remove(path)
        raise

    run_id = create_import_run(project_id=project_id, filename=file.filename or "", total_lines=total_lines)
    background_tasks.add_task(run_import_job, run_id, path, project_id)
    return {"run_id": run_id, "status": "queued", "total_lines": total_lines, "project_id": project_id}


@router.get("/api/articles/import/{run_id}")
def import_articles_status(run_id: str, user: dict = Depends(require_permission("articles.import"))):
    """Progress for one import job: counters, throughput and its live logs."""
    run = get_import_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Import run not found.")
    return {"run": run}


DELETE_ALL_ARTICLES_CONFIRMATION = "DELETE ALL ARTICLES"


@router.delete("/api/articles")
def delete_articles(confirm: str = "", user: dict = Depends(require_permission("articles.delete"))):
    """Delete all stored articles from Postgres.

    Irreversible and unscoped by design (it predates project scoping), so the
    only guard between one stray click - or one over-broadly granted role -
    and destroying the whole collection is this typed confirmation string,
    which a UI can no longer submit by accident the way a plain confirm
    dialog's default button can.
    """
    from services.articles.store import delete_all_articles

    if confirm != DELETE_ALL_ARTICLES_CONFIRMATION:
        raise HTTPException(
            status_code=400,
            detail=f'Pass ?confirm={DELETE_ALL_ARTICLES_CONFIRMATION.replace(" ", "%20")} to confirm this irreversible action.',
        )

    deleted = delete_all_articles(actor=user.get("username") or user.get("email") or user.get("id"))
    if not deleted:
        raise ConflictError(
            "Unable to delete articles.",
            detail="Check database connection settings.",
        )
    return {"ok": True}
