# Scraper App - Source Collection

Scraper App ingests content from configured sources, validates and deduplicates
it, and stores it in PostgreSQL for the dashboard to browse and export.

It **collects only**. Articles are stored exactly as scraped, with no analysis
on them and `analysis_status='pending'`, and leave through a JSONL export for
whatever analyzes them. The one place AI is still used is deciding *what* to collect -
suggesting a project's keywords, hashtags, usernames and sources, and
discovering competitors - never interpreting what came back.

This repo is a fork of [strata-media](https://github.com/CreativeTechy/strata-media),
which is the intended consumer of its exports. The two run against **separate
databases**; see [Handing data to strata-media](#handing-data-to-strata-media).

## Pipeline

- `backend/scraper/` - Scrapy project for source and page extraction
- `backend/services/articles/collect.py` - validation, dedup, date window, already-scraped
- `backend/services/articles/store.py` - Postgres upsert layer
- `backend/main.py` - FastAPI API for scraping, sources, projects, and articles
- `dashboard/` - React + Vite dashboard

## Stages

1. **Scraper** - `backend/scraper/spiders/source_rss.py`. Reads sources from the
   `sources` table (scoped to the selected project's sources when running for a
   specific project), discovers article links, and extracts clean
   title/date/text with trafilatura. `keyword` sources also query GDELT's free
   news-search API (`backend/scraper/gdelt.py`, on by default) and, when
   `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_ENGINE_ID` are configured, a general web
   search via `backend/scraper/web_search.py` (Google Custom Search JSON API),
   alongside their Google News RSS feed.
2. **Collector** - `backend/services/articles/collect.py`. Every article has to
   pass four checks, each counted per source so the dashboard can show *why* a
   source yielded fewer rows than it scraped:
   - **validation** - long enough, has a title, isn't a consent/search/error
     page (`content_guard.py` does the URL/title test)
   - **duplicate** - same URL already seen in this run
   - **date window** - published inside the project's start/end dates
   - **already scraped** - the URL isn't already stored from an earlier run
   For a backend-triggered run this happens per article as it's scraped
   (`backend/scraper/pipelines.py`'s `StreamingCollectPipeline`, calling into
   `collect.py`'s own functions) rather than as a separate pass after the whole
   crawl finishes - see [Run the pipeline manually](#5-run-the-pipeline-manually)
   for the batch/offline alternative.
3. **Saver** - `backend/services/articles/store.py`. Upserts each article
   immediately, assigns its story group, and links it to every project that owns
   the source it came from.
4. **Dashboard** - `dashboard/`. Calls the backend API. A running pipeline's
   detail page polls for updates, so a source's results appear as soon as that
   source finishes, without waiting for the whole run.

The `/dashboard` page is a deliberate "coming soon" placeholder: the numbers
worth charting in a collection app are collection metrics (volume by source over
time, coverage gaps, fetch failures), and those aren't built yet. Articles and
Pipeline Runs already show the underlying data.

### What the LLM is used for

A single configured provider serves all of it, and none of it reads a collected
article:

- project metadata suggestions (`backend/services/projects/projects_ai.py`)
- project keyword/hashtag/username/source discovery
  (`backend/services/projects/project_discovery.py`)
- competitor discovery and channel finding
  (`backend/services/competitors/competitor_discovery.py`)

All provider selection and request formatting lives in
`backend/llm_client.py`; feature modules just call `chat_completion(...)` and
never know which provider is active.

### Choosing an LLM provider

Set `LLM_PROVIDER` in `backend/.env`:

- `deepseek` (default) - needs `DEEPSEEK_API_KEY`. OpenAI-compatible
  chat-completions API.
- `openai` - needs `OPENAI_API_KEY`. Called via the Responses API.
- `ollama` - no key needed. Point `OLLAMA_CHAT_BASE_URL` at wherever Ollama is
  actually running (see [Fully offline LLM](#fully-offline-llm-ollama-containerized)).

Because the only LLM work left is discovery - a handful of calls when someone
sets a project up, not one per article - provider choice has far less cost and
throughput impact here than it does in strata-media.

## Handing data to strata-media

Collection here, analysis there, with the JSONL export as the seam:

1. In Articles, filter to what you want and click **Export** - one JSON object
   per line, streamed, `GET /api/articles/export`.
2. In strata-media's Articles page, **Import** that file
   (`POST /api/articles/import`). It upserts each row through the same saver the
   pipeline uses; nothing needs to be analyzed for the import to succeed.
3. Analyze them there (its per-article and batch analyze endpoints), which also
   generates the embeddings this app doesn't produce.

The export selects the columns the import's upsert writes, so a round trip is
lossless. Two kinds of column are deliberately left out, both because their
values only mean something inside the database that produced them:

- `pipeline_run_id` - a foreign key into this database's `pipeline_runs`.
  Exported, every row fails that constraint on the importing side and nothing
  lands.
- `story_id` - names a row in this database's `story_groups`. The importing
  side regroups by body similarity itself.

Every exported article carries `analysis_status='pending'`, which is what makes
strata-media's analyze step pick it up: it skips anything already marked
`success`, and that is the column's own database default.

> Keep `ARTICLE_MUTABLE_FIELDS` and the `articles` schema identical between the
> two repos. A column dropped on this side silently arrives NULL on the other.
> That is why the analysis columns still exist in `schema.sql` here even though
> nothing populates them.

If an import finishes as **failed** with "All N rows were rejected by the
database", the backend log holds the first error - that is the signal that the
two schemas have drifted.

## Clone And Run

### 1. Clone the repository

```bash
git clone <repo-url>
cd scraper-app
```

### 2. Prepare the backend environment

Copy the example env file and edit the values for your machine:

```bash
cd backend
copy .env.example .env
```

On macOS/Linux, use `cp .env.example .env` instead of `copy`.

Set at minimum:

- `DATABASE_URL` - **its own database**, not the one strata-media uses.
- An LLM provider's credentials - by default `DEEPSEEK_API_KEY`, used for
  project/source and competitor discovery. See
  [Choosing an LLM provider](#choosing-an-llm-provider).

### 3. Run the backend locally

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --port 8000
```

There is no optional-requirements file: dropping the analysis stage dropped
torch, transformers and sentence-transformers with it, so this install is small
and the container starts cold in seconds.

Migrations run automatically on startup (see
[Schema migrations](#schema-migrations)), so a fresh, empty `DATABASE_URL` gets
every table created for you the first time you run `uvicorn`. To apply them
without starting the server:

```bash
python migrate.py
```

Run the tests:

```bash
python -m pytest tests/ -q
```

### 4. Run the dashboard locally

Open a second terminal:

```bash
cd dashboard
npm install
copy .env.example .env
npm run dev
```

On macOS/Linux, use `cp .env.example .env` instead of `copy`.

The dashboard expects the backend on `http://localhost:8000` unless you set
`VITE_API_TARGET`.

### 5. Run the pipeline manually

You can run the scrape/validate/save flow directly from the backend folder.
This is the offline/dev path - the streaming item pipeline that saves as it
scrapes (used by the `/scrape` endpoint and the scheduler) only activates when
`PIPELINE_RUN_ID` is set, so a bare manual run like this stays as two separate
steps against a plain JSON file:

```bash
scrapy crawl source_rss -O articles.json
python -m services.articles.collect
```

## Docker Deployment

This repo includes a full Docker stack:

- `db` runs PostgreSQL 16
- `backend` runs the FastAPI API
- `frontend` builds the React dashboard
- `nginx` exposes the public app on port 8211
- `adminer` provides a database UI on port 8083
- `ollama` / `ollama-pull` (opt-in, see below) run a fully local/offline LLM

Ports and the database name deliberately differ from strata-media's, so both
stacks can run on one machine at the same time without colliding.

### Start the stack

```bash
docker compose up --build
```

### Fully offline LLM (Ollama), containerized

To run the LLM entirely inside Docker instead of depending on a host-machine
install, set `LLM_PROVIDER=ollama` in `backend/.env`, then bring the stack up
with the `ollama` profile enabled:

```bash
docker compose --profile ollama up --build
```

This starts an `ollama` service (the official `ollama/ollama` image, model
weights persisted in the `ollama-data` volume) and a one-shot `ollama-pull` job
that waits for it to be healthy and pulls `OLLAMA_CHAT_MODEL` (default
`llama3.1`). Both stay off during a plain `docker compose up`. To pull a
different model after changing `OLLAMA_CHAT_MODEL`:

```bash
docker compose --profile ollama up ollama-pull
```

### What runs where

- Public app: `http://localhost:8211/`
- Adminer: `http://localhost:8083/`
- Backend API: proxied through nginx at `/api` and `/scrape`
- Database: `db:5432` inside the Docker network

### Required Docker env files

The backend container reads `backend/.env`. Make sure it contains values for:

- `DATABASE_URL=postgresql://scraper:scraper@db:5432/scraper`
- Whichever LLM provider is selected via `LLM_PROVIDER` (default `deepseek`,
  requiring `DEEPSEEK_API_KEY`)

### Adminer login

Use these values to inspect the local database:

- System: `PostgreSQL`
- Server: `db`
- Username: `scraper`
- Password: `scraper`
- Database: `scraper`

### Stop the stack

```bash
docker compose down
```

To remove the Postgres volume as well:

```bash
docker compose down -v
```

### Schema migrations

Schema changes are applied by `backend/migrate.py`, which runs automatically when
the API starts. Dropping the Postgres volume is not needed to pick up a schema
change.

```bash
# from backend/
python migrate.py            # apply anything pending
python migrate.py --status   # show applied vs pending, change nothing
python migrate.py --verify   # exit non-zero if pending or drifted (for CI)
```

How it works:

- `schema.sql` is version `0001_baseline`, and is currently the **whole**
  schema: migrations `0002`-`0028` were squashed back into it. It is organized
  into numbered sections with a table of contents, and states its conventions at
  the top (identity keys, cascade vs. set null, `created_at`/`updated_at`
  handling, explicit constraint naming, and the rule that every foreign key has
  a usable index). It is idempotent, so it is safe to re-run, and re-running it
  is how an existing database converges with a fresh one. It is also mounted
  into `docker-entrypoint-initdb.d`, so a brand-new volume starts from it
  directly.
- `backend/migrations/NNNN_name.sql` are the forward migrations, applied in
  numeric order, each in its own transaction. The directory is currently empty
  apart from its own [README](backend/migrations/README.md), which covers the
  filename convention, the never-edit-an-applied-migration rule, and when
  squashing is legitimate. Start the next one at `0002`.
- Applied versions and their checksums are recorded in `schema_migrations`.
  Editing a migration after it has been applied is a hard error: the runner
  refuses rather than letting environments diverge silently. Add a new migration
  instead. `schema.sql` is the exception - it is expected to keep evolving and
  is re-applied whenever its checksum moves.

Set `MIGRATE_ON_STARTUP=false` to manage migrations out of band instead - e.g.
when several backend replicas share one database and only the deploy step should
migrate it.

#### Squash convergence

The baseline is built from `create table if not exists`, which does nothing when
the table is already there. Re-applying it to a database that predates the
`0002`-`0028` squash therefore **adds** what is missing but does **not** undo
anything. Verified by building both schemas and diffing them, the following did
not converge and remain on any such database:

- the 13 tables the squash dropped (`article_tags`, `article_people_opinions`,
  `article_feedback_items`, `idea_clusters`, `idea_cluster_articles`,
  `segment_taxonomy`, `competitor_articles`, and the six
  `competitor_documents` / `project_documents` upload tables),
- the 4 columns it dropped (`pipeline_runs.enrich_started_at`,
  `pipeline_runs.enrich_finished_at`, `pipeline_run_sources.enriched`,
  `article_projects.similarity_score`) and the index on the last of them,
- `pipeline_run_sources_run_idx`, a standalone index on `run_id` that only
  duplicated the leading column of the `(run_id, source)` primary key,
- `created_at` / `updated_at` staying nullable where the new baseline declares
  them `not null`,
- row-level security staying enabled, with its `Public read access` policies
  still attached.

None of that affects correctness: every one of those is unused scaffolding that
the application neither reads nor writes, and RLS is inert here because the
backend connects as the table owner. They are cosmetic drift, not a broken
schema. The three things that *do* converge are the new foreign-key indexes and
the `set_updated_at` function, because `create index if not exists` and
`create or replace function` both apply to an existing database.

A fresh database - `docker compose down -v`, or any new environment - gets the
clean shape with none of this. If a leftover ever has to be removed from a
long-lived database, that is what a real numbered migration is for.

### The signal layer

Two derived columns are populated automatically as articles are stored - no
re-scraping and no model calls:

- **dates** - parses the free-text `articles.published` into `published_at` plus
  a `published_precision` of `exact`, `day`, or `unknown`. Rows whose date cannot
  be recovered keep a null `published_at` and must be excluded from time series
  rather than falling back to `created_at`, which would report when we scraped a
  story rather than when it was published.
- **stories** - groups near-identical bodies into `story_groups` (MinHash + LSH
  over body shingles, see `backend/dedup.py`) so prevalence can be counted per
  independent story instead of per URL. One wire story republished by thirty
  outlets is one story, not thirty sources. The Articles list shows each
  article's story group.

### Reset the database (fresh start)

To wipe all local data and rebuild from scratch:

```bash
docker compose down -v
docker compose up --build -d
```

The volume is recreated from `schema.sql`, then the backend applies any
migrations on top at startup. Since the `0002`-`0028` squash there are no
migrations to apply, so this rebuilds the schema from the baseline alone.

## Deployment Notes

For a production-style deployment, the important pieces are:

- PostgreSQL must be reachable by the backend container
- `backend/.env` must include the database URL and the active LLM provider's
  credentials

The current Docker setup is suitable for a single-server deployment where the
database, backend, frontend, and reverse proxy all run together.

If you deploy the backend separately from the dashboard, keep the API base URL
consistent with the frontend's `VITE_API_TARGET` setting.

## Authentication & Roles

The dashboard and API require a logged-in session (cookie-based, not tokens in
localStorage). The first admin is created on backend startup from
`ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_EMAIL` /
`ADMIN_BOOTSTRAP_PASSWORD` in `backend/.env`, but only if the `users` table is
still empty - it will not touch an existing account. Log in with either the
username or the email.

Every authenticated user, regardless of role, can view articles, sources,
projects, and pipeline runs. Roles add specific write/action permissions on top
of that shared read access (`admin` is the only role that automatically
satisfies every check below - `viewer`/`editor`/`operator` are otherwise
independent, not a ladder):

- **viewer** - read-only. No create, update, delete, or pipeline actions.
- **editor** - create, update, and delete sources and projects; link sources to
  projects; use AI project discovery/suggestions.
- **operator** - trigger scrapes (`POST /scrape`), stop pipeline runs, and
  delete all stored articles.
- **admin** - everything above, plus user management: create, delete, change
  roles for, and enable/disable users (`/admin/users` in the dashboard, or the
  `/api/users` endpoints); and role management: create, edit, and delete roles
  (`/admin/roles` in the dashboard, or the `/api/roles` endpoints).

Role administration is gated by its own granular permissions rather than one
combined "manage roles" permission:

- `roles.view` - view roles and their permission assignments.
- `roles.create` - create new roles.
- `roles.update` - rename a role, edit its description, or change its
  permission assignments.
- `roles.delete` - delete a role (blocked for the system `admin` role, and for
  any role still assigned to a user).

Similarly, user administration has a dedicated `users.delete` permission
alongside `users.view`/`users.create`/`users.update`. Deleting a user removes
their account and any active sessions; a user can never delete their own
account, from either the dashboard or the API.
