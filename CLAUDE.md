# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Pipeline: Scrapy spider → validate/dedup → Postgres → FastAPI → React dashboard.

**This app collects only.** There is no AI analysis stage: an article is stored with its analysis columns left NULL, and leaves through the JSONL export for whatever analyzes it (strata-media, this repo's upstream, is the intended consumer - see "Handoff" below). The LLM that remains is used to decide *what to collect*, never to interpret what was collected.

- `backend/scraper/spiders/source_rss.py` - Scrapy spider; reads sources from the `sources` table (scoped to the selected project's sources when `PIPELINE_PROJECT_ID` is set), discovers article links, extracts text via trafilatura. `keyword` sources are crawled three ways: their Google News RSS feed (`googlenewsdecoder` resolves each item's `news.google.com/rss/articles/...` redirect-wrapper link to the real publisher URL before fetching it), GDELT's free news-search API (`backend/scraper/gdelt.py`, on by default - toggle with `GDELT_ENABLED`) fetched directly as articles, and - when `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_ENGINE_ID` are set - a general web search via `backend/scraper/web_search.py`, crawled like a `web` source. `hashtag` sources (`x.com/hashtag/<tag>`) can't be crawled directly - unlike a `username`/`social` profile page, which X still server-renders a few `/status/` links into, a hashtag/search page is a pure client-rendered shell with no tweets or links anywhere in its raw HTML (confirmed against the live site, including with a spoofed Googlebot user-agent - X's `robots.txt` allows Googlebot there, but the response it actually serves is still just meta tags). When `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_ENGINE_ID` are set, `start()` instead asks Google CSE for individual tweet URLs mentioning the hashtag (best-effort and often sparse, since X blocks most of its own site from being indexed) and only follows the results that are actual `/status/` links, feeding them through the same fxtwitter hydration path (`_yield_article`/`_hydrate_tweet`) used for tweets discovered via a profile page. Without CSE configured, a hashtag source reports 0 articles with an explanatory fetch note (see `source_diagnostics.py`) rather than a silent miss.
- `backend/services/articles/collect.py` - the four checks one article has to pass, and the per-source counters the dashboard reports them by: **validation** (long enough, has a title, isn't a consent/search/error page - `clean_articles`, with `content_guard.py` doing the URL/title test), **duplicate** (same URL already seen this run; near-identical bodies are additionally grouped into a `story_group` at save time, see `dedup.py`), **date window** (`_article_matches_project_window`), **already scraped** (`store.get_existing_urls`, gated on `SKIP_EXISTING_URLS`). Its own `main()` is a batch CLI entry point (reads a raw-scrape JSON file, runs the whole batch through those checks) for the manual/offline workflow below; `backend/scraper/pipelines.py`'s `StreamingCollectPipeline` reuses these same functions per-article from inside the live crawl instead - see below.
- `backend/scraper/pipelines.py` - Scrapy item pipeline that validates and saves each article the moment it's scraped (calling into `collect.py`'s functions), rather than waiting for the whole crawl to finish. Self-disables (`NotConfigured`) unless `PIPELINE_RUN_ID` is set, so a bare manual `scrapy crawl` is unaffected. This is why the dashboard's per-source breakdown for a run fills in source by source instead of only appearing once the slowest source finishes. Synchronous, unlike strata-media's equivalent: with no LLM/embedding call there is no multi-second blocking work left to overlap, only short local-Postgres round trips, so it processes items on the reactor thread rather than paying for a worker pool and the lock/counter bookkeeping that comes with one.
- `backend/services/articles/store.py` - upserts articles into Postgres, assigns each one its `story_group` (`dedup.py`), and links it to every project that owns the source it came from (`list_project_ids_for_source_url`), so one source shared by several projects feeds all of them from a single scrape.
- `backend/services/pipeline/pipeline.py` - `run_scraper_pipeline()`: runs the single `scrapy crawl source_rss` subprocess described above end to end (scrape+validate+save all interleaved), then folds the spider's end-of-run fetch diagnostics (blocked/404/DNS-failed - only knowable once the whole crawl closes) into the per-source rows the streaming pipeline already wrote live.
- `backend/main.py` - FastAPI app: scraping, sources, projects, articles (list/stats/export/import) endpoints.
- `backend/services/projects/projects_ai.py` / `backend/services/projects/project_discovery.py` - call the configured LLM via `llm_client.chat_completion` for hashtag/keyword/username/source discovery.
- `backend/config.py` - single source of truth for source list and credentials; loads `backend/.env` manually (not python-dotenv). Also resolves the active LLM provider (`LLM_PROVIDER`) and its credentials/base URL/model.
- `backend/llm_client.py` - provider-neutral `chat_completion(...)` client; the only module aware of OpenAI vs. DeepSeek request/response differences.
- `backend/services/` - business-logic modules grouped by domain: `auth/` (login, sessions, users, RBAC), `projects/`, `sources/`, `competitors/` (competitor study), `articles/` (collect/store/export/import), `pipeline/` (scrape→save execution, run tracking, scheduling). `migrate.py` stays at `backend/` root.
- `dashboard/` - React 19 + Vite dashboard, calls the backend API. `/dashboard` is a deliberate "coming soon" placeholder - the metrics worth charting here are collection metrics (volume by source over time, coverage gaps, fetch failures) and they aren't built yet.

Tests live in `backend/tests/` (unittest, run with pytest). There is no dashboard test suite.

## Handoff: export → import

The JSONL export is the only way articles leave this app, so it has to round-trip losslessly into a database that *will* analyze them:

- `articles_store._export_select()` selects exactly the columns `store.save_articles()` writes (`stored_article_fields()`), built from the live table rather than hardcoded. The narrow `ARTICLES_SELECT` the dashboard uses is not enough - the upsert behind the import sets every mutable column from `excluded`, so a column the export omits comes back NULL.
- **`ARTICLE_MUTABLE_FIELDS` and the `articles` schema must stay identical to strata-media's.** A column dropped here silently becomes NULL there. This is why the analysis columns are still in the schema even though nothing populates them.
- `story_id` is deliberately *not* exported: its values name a row in this database's own `story_groups`, and the importing side regroups by body similarity itself.
- `POST /api/articles/import` (`services/articles/import_jobs.py`) filters incoming keys against `ARTICLE_MUTABLE_FIELDS` and calls the same `save_articles()` the pipeline uses - no analysis required on either side.

## Commands

Backend (from `backend/`):
```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8000
python -m pytest tests/ -q
```
Run pipeline manually (offline/dev, no `PIPELINE_RUN_ID` - the streaming item pipeline stays disabled): `scrapy crawl source_rss -O articles.json` then `python -m services.articles.collect`. The backend-triggered pipeline (`/scrape` endpoint, scheduler) instead runs a single `scrapy crawl source_rss` with `PIPELINE_RUN_ID` set, streaming validate+save per article - see `backend/scraper/pipelines.py`.

Dashboard (from `dashboard/`):
```
npm install
npm run dev       # dev server, expects backend at http://localhost:8000 (override via VITE_API_TARGET)
npm run build
npm run lint      # eslint .
```

Docker (full stack from repo root): `docker compose up --build`
- Public app on `:8211` (nginx), backend proxied at `/api` and `/scrape`, Adminer on `:8083`, Postgres in `db` service. Ports deliberately differ from strata-media's so both stacks can run at once.
- Backend container reads `backend/.env`.

## Constraints

- Required backend env vars: `DATABASE_URL`, plus the active LLM provider's key (`DEEPSEEK_API_KEY` by default; `OPENAI_API_KEY` if `LLM_PROVIDER=openai`; not needed for `LLM_PROVIDER=ollama`). The LLM is used only for discovery: project metadata suggestions, project keyword/hashtag/username/source discovery, and competitor discovery.
- **Separate database from strata-media.** The two apps exchange data through the JSONL export/import, never a shared table - `docker-compose.yml` uses its own `scraper` database and its own compose-project volume.
- `LLM_PROVIDER` (`deepseek` default, or `openai`, or `ollama` for a fully local/offline setup) picks the app-wide provider; all provider selection, credentials, and request-shape differences are centralized in `backend/config.py` and `backend/llm_client.py`. Feature modules only call `llm_client.chat_completion(...)` and never branch on the provider. `ollama` talks to a local `ollama serve` (default `http://localhost:11434/v1/chat/completions`), which speaks the same OpenAI-compatible chat-completions shape as DeepSeek.
- OpenAI is called via its Responses API (`OPENAI_CHAT_MODEL`/`OPENAI_CHAT_BASE_URL` overridable; default model `gpt-5-nano`); DeepSeek via its OpenAI-compatible chat-completions API (`DEEPSEEK_CHAT_MODEL`/`DEEPSEEK_CHAT_BASE_URL` overridable; default model `deepseek-chat`).
- Keep `VITE_API_TARGET` (dashboard) consistent with the backend's actual base URL if deployed separately.
- `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_ENGINE_ID` (both optional, unset by default) enable the general-web-search tier for `keyword` sources - see `backend/scraper/web_search.py`. Unset, keyword sources are scraped via Google News RSS + GDELT only. The same two vars also enable `hashtag` sources' only working tier (tweet-link discovery via CSE, see `source_rss.py`'s `start()`) - unset, a `hashtag` source cannot find any tweets at all.
- `GDELT_ENABLED` (`true` by default, no credentials needed) - GDELT's free DOC 2.0 news-search API tier for `keyword` sources, see `backend/scraper/gdelt.py`. GDELT itself rate-limits to roughly one request per 5 seconds (undocumented exactly, observed stricter in practice); `gdelt.py` throttles its own calls to stay under that, so a project with many keywords takes correspondingly longer to seed this tier. Set `false` to disable.
- `SKIP_EXISTING_URLS` (`true` by default) - skip re-saving a URL already in `articles`, counted per source as "already scraped". Set `false` to re-save everything each run (refreshes `fetched_at`, re-runs story-group assignment).
- A competitor study's confirmed channels only become scrapable once `POST /api/competitor/studies/{id}/sync-sources` writes them into `sources`. Analysis used to trigger that on every run; now the workspace's "Sync sources" button does it, and saving a schedule with tracking enabled does it too. Removing both would leave a study scheduled to scrape nothing.
- `backend/schema.sql` is the migration runner's checksummed `0001_baseline` (see `migrate.py`) - editing it after it has been applied to a database is a hard error. Add a `backend/migrations/NNNN_name.sql` instead.
