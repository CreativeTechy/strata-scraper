"""FastAPI service that orchestrates the pipeline.

The stages live in their own modules:
  scraper   -> scraper/spiders/source_rss.py (Scrapy)
  collector -> services/articles/collect.py
  saver     -> services/articles/store.py

This API triggers the jobs and exposes configured sources to the dashboard.
This app collects only - articles are stored unanalyzed, and leave through
the JSONL export for whatever analyzes them.
"""

import asyncio
import contextlib
import json
import logging
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.logging import configure_logging

configure_logging()

from app.core import settings as config
from app.core import db
import migrate
from api.deps import ensure_project_visible
from api.errors import AppError
from api.routers import articles as articles_router
from api.routers import pipeline as pipeline_router
from api.routers import projects as projects_router
from api.routers import roles as roles_router
from api.routers import sources as sources_router
from api.routers import users as users_router
from services.competitors import competitor_api
from services.competitors.competitors_store import export_competitors
from services.auth import login_throttle
from services.auth import permissions_store
from services.auth import sessions_store
from services.auth import users_store
from services.auth.auth import clear_auth_cookies, get_current_user, require_permission, set_auth_cookies
from services.pipeline.scheduler import scheduler_loop

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR.parent / "storage"

logger = logging.getLogger(__name__)

app = FastAPI(title="Scraper App API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The competitor study is a separate experience from opinion monitoring, so
# its routes live in their own module rather than growing this one.
app.include_router(competitor_api.router)
# First domains extracted out of this file into api/routers/ - see
# users.py's docstring. The rest follow the same shape one at a time.
app.include_router(users_router.router)
app.include_router(roles_router.router)
app.include_router(sources_router.router)
app.include_router(projects_router.router)
app.include_router(pipeline_router.router)
app.include_router(articles_router.router)


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException):
    # Shape every raised HTTPException (401/403/404/...) like this API's
    # existing ad hoc error bodies ({"error": ...}) so the dashboard's
    # shared formatApiError() handles them without special-casing.
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(AppError)
async def _app_error_handler(request: Request, exc: AppError):
    # See api/errors.py - replaces the routes that used to return HTTP 200
    # with an {"error": ...} body instead of a real status code.
    content = {"error": exc.message}
    if exc.detail:
        content["detail"] = exc.detail
    return JSONResponse(status_code=exc.status_code, content=content)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    # Catch-all for anything a route or a store function lets through
    # uncaught. Without this, an unexpected error (e.g. a raised database
    # failure) surfaces as FastAPI's bare default 500 instead of the
    # {"error": ...} shape the dashboard expects, and - more importantly -
    # it is logged with a stack trace instead of vanishing into a swallowed
    # `except Exception: return []` somewhere downstream.
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": "Internal server error."})


@app.on_event("startup")
async def _apply_migrations():
    """Bring the schema up to date before anything reads or writes it.

    Registered ahead of the admin bootstrap on purpose: that depends on roles the
    baseline migration seeds. Failures are deliberately fatal — a backend serving
    requests against a schema it does not match returns wrong answers silently,
    which is worse than refusing to start. Set MIGRATE_ON_STARTUP=false to manage
    migrations out of band (`python migrate.py`) instead.
    """
    if not config.MIGRATE_ON_STARTUP:
        logger.info("Startup migrations disabled (MIGRATE_ON_STARTUP=false).")
        return
    if not config.DATABASE_URL:
        logger.warning("DATABASE_URL is missing; skipping migrations.")
        return
    migrate.run_on_startup()


@app.on_event("startup")
async def _bootstrap_admin():
    users_store.bootstrap_admin()


@app.on_event("startup")
async def _start_scheduler():
    # SINGLE-PROCESS ONLY: every worker/replica would start its own tick.
    # claim_due_project() (see scheduler.py) makes the tick itself an atomic
    # DB claim, so two schedulers ticking concurrently would not double-run a
    # project - but see services/pipeline/pipeline.py's _active_processes and
    # app/core/jobs.py's JobRegistry for the two pieces of
    # per-run state that are NOT safe under more than one process today.
    app.state.scheduler_task = asyncio.create_task(scheduler_loop())


@app.on_event("shutdown")
async def _stop_scheduler():
    task = getattr(app.state, "scheduler_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@app.on_event("shutdown")
async def _close_db_pool():
    db.close_pool()


@app.get("/")
def root():
    return {"service": "Scraper App API", "ok": True, "see": "/api/health"}


@app.get("/api/health")
def health_check(response: Response):
    try:
        db.fetch_one("select 1")
    except Exception:
        logger.exception("Health check: database is unreachable.")
        response.status_code = 503
        return {"status": "degraded", "service": "Scraper App API", "database": "unreachable"}
    return {"status": "healthy", "service": "Scraper App API", "database": "ok"}


# --- Auth --------------------------------------------------------------


def _public_user(user: dict) -> dict:
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "email": user.get("email"),
        "role": user.get("role"),
        "status": user.get("status"),
        "permissions": sorted(permissions_store.user_permission_keys(user)),
    }


def _client_ip(request: Request) -> str:
    # nginx (the only reverse proxy in front of this app - see
    # nginx/default.conf) sets X-Forwarded-For to
    # "<whatever the client sent>, <the real connecting IP>" via
    # $proxy_add_x_forwarded_for - the last entry is the one nginx itself
    # observed, so it's the only one worth trusting; a client can put
    # anything it wants in the earlier entries.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


@app.post("/api/auth/login")
def login(payload: dict, request: Request, response: Response):
    payload = payload or {}
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password are required.")

    # Keyed by IP always (covers credential stuffing/CPU exhaustion from one
    # source trying many usernames) and by account only once the account is
    # known to exist (an unbounded set of fabricated usernames must not be
    # able to grow the throttle's own memory without bound). Checked before
    # verify_password() runs at all - bcrypt is deliberately expensive, so
    # throttling only the outcome would still let a locked-out attacker
    # saturate CPU with the hash itself.
    ip_key = f"ip:{_client_ip(request)}"
    row = users_store.get_user_by_login(username)
    throttle_keys = (ip_key, f"user:{row['id']}") if row else (ip_key,)

    wait = login_throttle.seconds_until_allowed(*throttle_keys)
    if wait > 0:
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Try again shortly.",
            headers={"Retry-After": str(int(wait) + 1)},
        )

    if not row or row.get("status") != "active" or not users_store.verify_password(password, row["password_hash"]):
        login_throttle.record_failure(*throttle_keys)
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    login_throttle.record_success(*throttle_keys)
    raw_token, csrf_token, expires_at = sessions_store.create_session(row["id"])
    users_store.record_login(row["id"])
    set_auth_cookies(response, raw_token, csrf_token, expires_at)
    return {"user": _public_user(row)}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, user: dict = Depends(require_permission())):
    raw_token = request.cookies.get(config.SESSION_COOKIE_NAME)
    sessions_store.delete_session(raw_token)
    clear_auth_cookies(response)
    return {"ok": True}


@app.get("/api/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {"user": _public_user(user)}


@app.get("/api/competitors/export")
def export_competitors_jsonl(
    project_id: int,
    user: dict = Depends(require_permission("competitors.view")),
):
    """Tracked competitors for one competitor-mode project, JSONL - the
    companion to /api/articles/export for the same project (see CLAUDE.md's
    Handoff section). A project's tracked-competitor list is dozens of rows at
    most, so unlike the article export this builds the whole body in memory
    rather than streaming a generator page by page.
    """
    ensure_project_visible(project_id, user)
    rows = export_competitors(project_id)
    body = "".join(json.dumps(row, ensure_ascii=False, default=str) + "\n" for row in rows)
    filename = "competitors-export.jsonl"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": "application/x-ndjson; charset=utf-8",
    }
    return Response(content=body, headers=headers, media_type="application/x-ndjson")


