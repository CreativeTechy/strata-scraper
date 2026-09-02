-- Scraper App - Postgres schema for the article collection pipeline.
--
-- Applied as migration `0001_baseline` by backend/migrate.py, and mounted into
-- docker-entrypoint-initdb.d so a fresh volume starts from it. Every statement
-- is idempotent, so re-running it is safe and is how an existing database
-- converges with a fresh one.
--
-- This file is a squash: migrations 0002-0028 were folded back into it once the
-- last database that had applied them piecemeal was gone. See
-- backend/migrations/README.md for when that is legitimate and what it costs.
--
-- =============================================================================
-- Contents
-- =============================================================================
--   1. Conventions
--   2. Shared helpers          set_updated_at()
--   3. Projects                projects
--   4. Sources                 sources
--   5. Access control          roles, permissions, role_permissions,
--                              users, sessions
--   6. Project membership      project_sources, project_users
--   7. Pipeline runs           pipeline_runs, pipeline_run_sources
--   8. Articles                articles, story_groups, article_projects
--   9. Competitor study        business_profiles, competitors,
--                              competitor_accounts, competitor_findings
--  10. Seed data               permissions, roles, role_permissions
--
-- =============================================================================
-- 1. Conventions
-- =============================================================================
--
-- Identity keys
--   Surrogate keys are `bigint generated always as identity primary key`.
--   Two tables deliberately differ: `pipeline_runs.id` is a caller-supplied
--   text run id, and `sessions` is keyed by its own `token_hash`. Pure link
--   tables (project_sources, project_users, article_projects, role_permissions,
--   pipeline_run_sources) have no surrogate key - the pair *is* the identity.
--
-- Cascade vs. set null
--   `on delete cascade` where the child cannot exist without the parent: it is
--   a part of the parent, not a reference to it (a project's competitors, a
--   run's per-source breakdown, a user's sessions).
--   `on delete set null` where the row is *provenance* and must outlive what it
--   points at: articles.pipeline_run_id, articles.story_id,
--   story_groups.canonical_article_id, competitor_accounts.source_id,
--   pipeline_runs.project_id, competitor_findings.pipeline_run_id. Deleting a
--   pipeline run must never delete the articles it collected.
--
-- created_at / updated_at
--   These are row-audit timestamps and are `timestamptz not null default now()`
--   on every table, without exception. Every table carrying `updated_at` also
--   carries a `set_<table>_updated_at` trigger calling set_updated_at() - the
--   column is maintained by the database, never by the application.
--   Domain timestamps are a different thing and keep their own semantics:
--   started_at / finished_at / last_seen_at / embedded_at / scraped_at describe
--   something that may not have happened yet, so they stay nullable even where
--   they happen to default to now().
--
-- Explicit constraint naming
--   Every CHECK constraint is named explicitly. Postgres would otherwise
--   auto-name an inline check `<table>_<column>_check`, which does not match
--   the shorter names several of these have carried since they were first
--   added by `alter table ... add constraint` - and a name that does not match
--   is a name a later `drop constraint if exists` cannot find.
--   PRIMARY KEY / UNIQUE / FOREIGN KEY constraints are left to Postgres's
--   generated `<table>_<column>_{pkey,key,fkey}` names, which are deterministic
--   and are already the names in use.
--
-- Every foreign key has a usable index
--   An unindexed FK makes every parent delete or update scan the whole child
--   table. Where the FK's columns are not already the leading columns of the
--   primary key or another index, an index is declared for it explicitly.
--
-- Row-level security
--   Deliberately absent. This schema used to enable RLS on most tables and
--   attach a `Public read access` policy granting SELECT to Supabase's `anon`
--   and `authenticated` roles. That was inert scaffolding: the backend connects
--   as the table owner via psycopg, which bypasses RLS entirely, and those two
--   roles were NOLOGIN and held no table grants at all - RLS narrows privilege,
--   it never grants it, so the policies could not have enabled access even if
--   the roles could connect. Dropping it also removes the reason this file used
--   to `create role anon` up front: without those roles a policy referencing
--   them aborts the whole file under initdb's ON_ERROR_STOP=1, which broke the
--   documented `docker compose down -v` reset on a vanilla postgres image.


-- =============================================================================
-- 2. Shared helpers
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;


-- =============================================================================
-- 3. Projects
-- =============================================================================
-- A project declares a `mode`. Sentiment projects are the default path;
-- competitor projects additionally own the business profile / competitor set in
-- section 9. The `repeat_*` / `next_run_at` columns drive the scheduler
-- (services/pipeline/scheduler.py) for both modes.

create table if not exists public.projects (
    id                    bigint generated always as identity primary key,
    name                  text not null,
    status                text not null default 'draft',
    mode                  text not null default 'sentiment',
    description           text,
    location              text,
    location_type         text,
    target_audience       text,
    hashtags              jsonb default '[]'::jsonb,
    keywords              jsonb default '[]'::jsonb,
    usernames             jsonb default '[]'::jsonb,
    start_date            date,
    end_date              date,
    -- Scheduling: repeat_enabled + an interval, or an explicit weekday list.
    repeat_enabled        boolean not null default false,
    repeat_interval_value integer,
    repeat_interval_unit  text,
    repeat_weekdays       jsonb default '[]'::jsonb,
    first_run_at          timestamptz,
    next_run_at           timestamptz,
    last_run_at           timestamptz,
    last_run_status       text,
    embedding_json        jsonb default '[]'::jsonb,
    embedding_model       text,
    embedding_source      text,
    embedded_at           timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    constraint projects_mode_check
        check (mode in ('sentiment', 'competitor')),
    constraint projects_location_type_check
        check (location_type is null or location_type in ('on_site', 'remote', 'hybrid')),
    constraint projects_repeat_interval_unit_check
        check (repeat_interval_unit is null
               or repeat_interval_unit in ('minutes', 'hours', 'days'))
);

create index if not exists projects_status_idx on public.projects (status);
create index if not exists projects_mode_idx on public.projects (mode);
create index if not exists projects_created_idx on public.projects (created_at desc);
-- The scheduler only ever asks for due repeating projects; the partial index
-- keeps it to just those rows.
create index if not exists projects_next_run_idx
    on public.projects (next_run_at) where repeat_enabled = true;

drop trigger if exists set_projects_updated_at on public.projects;
create trigger set_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();


-- =============================================================================
-- 4. Sources
-- =============================================================================
-- What the spider is pointed at. `source_type` selects the crawl strategy
-- (rss / web / keyword / hashtag / username / social - see
-- scraper/spiders/source_rss.py); `limited` caps how deep that crawl goes.

create table if not exists public.sources (
    id          bigint generated always as identity primary key,
    url         text not null unique,
    name        text,
    enabled     boolean not null default true,
    source_type text not null default 'rss',
    limited     boolean not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists sources_enabled_idx on public.sources (enabled);
create index if not exists sources_created_idx on public.sources (created_at desc);

drop trigger if exists set_sources_updated_at on public.sources;
create trigger set_sources_updated_at
before update on public.sources
for each row
execute function public.set_updated_at();


-- =============================================================================
-- 5. Access control
-- =============================================================================
-- Dynamic roles/permissions: a role is just a named, editable set of
-- permissions. `is_system` protects the seeded 'admin' role from deletion;
-- `full_access` grants every permission automatically (also only seeded on
-- 'admin') so the app always keeps one role that can't be locked out of.

create table if not exists public.roles (
    id          bigint generated always as identity primary key,
    name        text not null unique,
    description text,
    is_system   boolean not null default false,
    full_access boolean not null default false,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

drop trigger if exists set_roles_updated_at on public.roles;
create trigger set_roles_updated_at
before update on public.roles
for each row
execute function public.set_updated_at();

create table if not exists public.permissions (
    id          bigint generated always as identity primary key,
    key         text not null unique,
    description text
);

create table if not exists public.role_permissions (
    role_id       bigint not null references public.roles(id) on delete cascade,
    permission_id bigint not null references public.permissions(id) on delete cascade,
    primary key (role_id, permission_id)
);

-- role_id already leads the primary key; only permission_id needs its own index.
create index if not exists role_permissions_permission_idx
    on public.role_permissions (permission_id);

-- users.role_id has no `on delete` action on purpose: deleting a role out from
-- under its users would silently strip their access rather than failing loudly.
create table if not exists public.users (
    id            bigint generated always as identity primary key,
    username      text not null unique,
    email         text unique,
    password_hash text not null,
    role_id       bigint not null references public.roles(id),
    status        text not null default 'active',
    last_login_at timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint users_status_check check (status in ('active', 'disabled'))
);

create index if not exists users_role_id_idx on public.users (role_id);

drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

-- Keyed by the hash of the session token, never the token itself.
create table if not exists public.sessions (
    token_hash   text primary key,
    user_id      bigint not null references public.users(id) on delete cascade,
    csrf_token   text not null,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz default now(),
    expires_at   timestamptz not null
);

create index if not exists sessions_user_idx on public.sessions (user_id);
create index if not exists sessions_expires_idx on public.sessions (expires_at);


-- =============================================================================
-- 6. Project membership
-- =============================================================================
-- One source shared by several projects feeds all of them from a single scrape
-- (see services/articles/store.py's list_project_ids_for_source_url).

create table if not exists public.project_sources (
    project_id bigint not null references public.projects(id) on delete cascade,
    source_id  bigint not null references public.sources(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (project_id, source_id)
);

create index if not exists project_sources_project_idx on public.project_sources (project_id);
create index if not exists project_sources_source_idx on public.project_sources (source_id);

create table if not exists public.project_users (
    project_id bigint not null references public.projects(id) on delete cascade,
    user_id    bigint not null references public.users(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (project_id, user_id)
);

create index if not exists project_users_project_idx on public.project_users (project_id);
create index if not exists project_users_user_idx on public.project_users (user_id);


-- =============================================================================
-- 7. Pipeline runs
-- =============================================================================

create table if not exists public.pipeline_runs (
    id                  text primary key,
    pipeline            text not null default 'scrape',
    status              text not null default 'queued',
    stage               text not null default 'queued',
    message             text,
    articles_scraped    integer not null default 0,
    articles_cleaned    integer not null default 0,
    articles_saved      integer not null default 0,
    crawl_pages         integer not null default 0,
    error               text,
    -- Provenance, not ownership: deleting a project must not delete the record
    -- that a run happened.
    project_id          bigint references public.projects(id) on delete set null,
    started_at          timestamptz default now(),
    finished_at         timestamptz,
    cancel_requested_at timestamptz,
    cancelled_at        timestamptz,
    -- Per-stage timing plus a has_detail flag are only ever populated for runs
    -- created after per-stage tracking existed; older rows keep
    -- has_detail = false so the dashboard can show a "details unavailable for
    -- legacy run" fallback instead of guessing.
    has_detail          boolean not null default false,
    scrape_started_at   timestamptz,
    scrape_finished_at  timestamptz,
    clean_started_at    timestamptz,
    clean_finished_at   timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists pipeline_runs_created_idx on public.pipeline_runs (created_at desc);
create index if not exists pipeline_runs_status_idx on public.pipeline_runs (status);
create index if not exists pipeline_runs_project_idx on public.pipeline_runs (project_id);

drop trigger if exists set_pipeline_runs_updated_at on public.pipeline_runs;
create trigger set_pipeline_runs_updated_at
before update on public.pipeline_runs
for each row
execute function public.set_updated_at();

-- Per-source breakdown for a single run. Written live, article by article, by
-- scraper/pipelines.py's StreamingCollectPipeline, which is why the dashboard's
-- breakdown fills in source by source instead of only appearing once the
-- slowest source finishes.
--
-- The fetch diagnostics (http_status / network_blocked / fetch_note) are folded
-- in at the end of the crawl instead: whether a source was reachable at all is
-- only knowable once the whole crawl closes, and a source blocked at the
-- network level before any article existed would otherwise have no row here at
-- all. "content_filtered" is a different, unrelated count (articles rejected
-- by content_guard for being too short/titleless/a consent page - nothing to
-- do with the source being blocked), hence network_blocked rather than a name
-- that could be confused with it.
create table if not exists public.pipeline_run_sources (
    run_id           text not null references public.pipeline_runs(id) on delete cascade,
    source           text not null,
    -- `source` is sometimes a bare domain ("x.com") rather than the configured
    -- page/feed address, so the real URL is kept alongside it for linking out.
    source_url       text,
    scraped          integer not null default 0,
    duplicate        integer not null default 0,
    content_filtered integer not null default 0,
    date_filtered    integer not null default 0,
    skipped_existing integer not null default 0,
    kept             integer not null default 0,
    saved            integer not null default 0,
    http_status      integer,
    network_blocked  boolean not null default false,
    fetch_note       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    primary key (run_id, source)
);

-- No index on run_id alone: it already leads the primary key
-- (run_id, source), which serves both lookups by run and the foreign key's own
-- delete-cascade check. The standalone `pipeline_run_sources_run_idx` this
-- schema used to declare was pure duplication - a second btree to maintain on
-- every insert, and this table is written once per source per run.

drop trigger if exists set_pipeline_run_sources_updated_at on public.pipeline_run_sources;
create trigger set_pipeline_run_sources_updated_at
before update on public.pipeline_run_sources
for each row
execute function public.set_updated_at();


-- =============================================================================
-- 8. Articles
-- =============================================================================
-- This app collects only - nothing here populates the analysis columns. They
-- exist because the JSONL export has to round-trip losslessly into strata-media,
-- whose `articles` table this one must stay identical to: a column dropped here
-- silently arrives as NULL there. See "Handoff" in CLAUDE.md and
-- services/articles/articles_store.py's _export_select().
--
-- `analysis_status` defaults to 'success' rather than 'pending' because the
-- column was added to a database whose rows had all been analyzed. Collection
-- therefore stamps every article 'pending' explicitly (collect.mark_unanalyzed,
-- with a matching fallback in store._article_row) - inheriting this default
-- would mean a whole collection run silently never gets analyzed downstream.
--
-- `published` is free text, whatever the feed emitted, kept as provenance.
-- `published_at` is the parsed value and `published_precision` records how much
-- of it the source actually gave us, so trend math can exclude rows it cannot
-- place in time:
--   exact   - the source carried a time
--   day     - the source carried a calendar date only
--   unknown - nothing usable; published_at stays null
-- Parsing in Python on every read used to fall back to created_at, which
-- silently turns "when it was said" into "when we scraped it".
--
-- `content_hash` is over the whitespace-collapsed body, so reflowed markup is
-- not mistaken for news; `content_changed_at` advances only when that hash
-- moves. Re-scraping upserts on `url`, so created_at keeps its first-seen value
-- while fetched_at moves on every crawl - right for a feed item, published once,
-- but for a page on a competitor's own site it loses the only thing worth
-- knowing. Its default was added separately from the column so existing rows
-- stayed null: backfilling them all with one timestamp would read as
-- "everything changed at once". Null means "never observed changing", and
-- callers fall back to created_at.
create table if not exists public.articles (
    id                         bigint generated always as identity primary key,
    url                        text not null unique,
    source                     text,
    source_url                 text,
    title                      text,
    author                     text,
    published                  text,
    published_at               timestamptz,
    published_precision        text,
    text                       text,
    fetched_at                 timestamptz,
    content_hash               text,
    content_changed_at         timestamptz default now(),
    -- Whether the resolved URL belongs to an editorially reputable publisher
    -- (backend/trusted_sources.py). Judged per article, not inherited from the
    -- configured source: a keyword source resolves to a different publisher
    -- every time.
    verified                   boolean not null default false,
    -- Provenance: which run most recently saved this article. Nullable -
    -- articles saved outside a scrape run (a manual import) have no run to scope
    -- to. Excluded from the JSONL export: it is a foreign key into *this*
    -- database's pipeline_runs, so exported it would fail the FK on the
    -- importing side and land nothing.
    pipeline_run_id            text references public.pipeline_runs(id) on delete set null,
    -- ---- Analysis columns: populated downstream, never by this app ----------
    summary                    text,
    sentiment                  text,
    sentiment_score            numeric,
    sentiment_low_confidence   boolean not null default false,
    sentiment_model            text,
    relevance_score            numeric,
    category                   text,
    category_confidence        numeric,
    article_category           text,
    writer_tone                text,
    writer_tone_confidence     numeric,
    article_tone               text,
    article_tone_confidence    numeric,
    gender                     text not null default 'unknown',
    age_range                  text not null default 'unknown',
    region                     text not null default 'unknown',
    segment                    text not null default 'unknown',
    insight_json               jsonb default '{}'::jsonb,
    organizations              jsonb default '[]'::jsonb,
    entities                   jsonb default '[]'::jsonb,
    topics                     jsonb default '[]'::jsonb,
    key_points                 jsonb default '[]'::jsonb,
    risks                      jsonb default '[]'::jsonb,
    opportunities              jsonb default '[]'::jsonb,
    brands                     jsonb default '[]'::jsonb,
    car_models                 jsonb default '[]'::jsonb,
    classification_model       text,
    extraction_model           text,
    analysis_model             text,
    analysis_prompt_version    text,
    analysis_pipeline_version  text,
    analyzed_at                timestamptz,
    analysis_status            text not null default 'success',
    analysis_error             text,
    analysis_started_at        timestamptz,
    analysis_finished_at       timestamptz,
    analysis_attempt_count     integer not null default 0,
    reprocess_requested_at     timestamptz,
    source_language            text,
    source_language_confidence numeric,
    embedding_json             jsonb default '[]'::jsonb,
    embedding_model            text,
    embedding_source           text,
    embedding_dimensions       integer,
    embedded_at                timestamptz,
    created_at                 timestamptz not null default now(),
    constraint articles_analysis_status_check
        check (analysis_status in ('pending', 'processing', 'success', 'failed', 'partial')),
    constraint articles_published_precision_check
        check (published_precision is null
               or published_precision in ('exact', 'day', 'unknown'))
);

-- Syndication collapse: group near-identical article bodies into one story.
-- Prevalence must be counted per independent story, not per URL - one wire story
-- republished on 30 sites is one story that 30 outlets carried, and counting it
-- as 30 independent sources inflates every number downstream.
--
-- `signature` is a 128-permutation MinHash sketch (see backend/dedup.py); the
-- fraction of agreeing positions estimates Jaccard similarity over the body's
-- 4-word shingles. `band_keys` are 16 LSH band hashes: two bodies sharing any
-- band key are candidate duplicates, which turns lookup into one indexed array
-- overlap instead of a scan. MinHash rather than SimHash because a fixed Hamming
-- threshold is not scale invariant across article lengths - see the module
-- docstring for the measured failure that motivated it.
--
-- Both are null for a *singleton* group: an article whose body is too short to
-- profile meaningfully. Such an article is still an independent story - we
-- simply cannot prove it duplicates anything - so it gets its own group rather
-- than being left unassigned. A null band_keys never overlaps, so singletons are
-- naturally excluded from duplicate matching, and downstream counting stays
-- uniform (`count(distinct story_id)`) with no nulls to special-case.
create table if not exists public.story_groups (
    id                   bigint generated always as identity primary key,
    project_id           bigint references public.projects(id) on delete cascade,
    canonical_article_id bigint references public.articles(id) on delete set null,
    signature            integer[],
    band_keys            bigint[],
    member_count         integer not null default 1,
    first_seen_at        timestamptz not null default now(),
    last_seen_at         timestamptz not null default now(),
    created_at           timestamptz not null default now(),
    constraint story_groups_signature_pairing
        check ((signature is null) = (band_keys is null))
);

-- GIN supports the `&&` (overlap) operator used for candidate lookup.
create index if not exists story_groups_band_keys_idx
    on public.story_groups using gin (band_keys);
create index if not exists story_groups_project_idx
    on public.story_groups (project_id);
create index if not exists story_groups_canonical_article_idx
    on public.story_groups (canonical_article_id);

-- articles <-> story_groups is a genuine cycle: an article names its group and a
-- group names its canonical article. One of the two directions has to be added
-- after both tables exist; this is that direction, and it is the only ALTER in
-- this file that is not redundant with a CREATE above it.
--
-- Both sides are `on delete set null`, so neither deletion cascades into the
-- other: dropping a story group unassigns its articles, and deleting an article
-- clears the group's canonical pointer without destroying the group.
--
-- `story_id` is excluded from the JSONL export for the same reason as
-- pipeline_run_id - it names a local story_groups row, and the importing side
-- regroups by body similarity itself.
alter table public.articles
    add column if not exists story_id bigint references public.story_groups(id) on delete set null;

create index if not exists articles_published_idx on public.articles (published desc);
create index if not exists articles_fetched_at_idx on public.articles (fetched_at desc);
create index if not exists articles_analyzed_at_idx on public.articles (analyzed_at desc);
create index if not exists articles_sentiment_idx on public.articles (sentiment);
create index if not exists articles_article_category_idx on public.articles (article_category);
create index if not exists articles_analysis_status_idx on public.articles (analysis_status);
create index if not exists articles_source_language_idx on public.articles (source_language);
create index if not exists articles_gender_idx on public.articles (gender);
create index if not exists articles_age_range_idx on public.articles (age_range);
create index if not exists articles_region_idx on public.articles (region);
create index if not exists articles_segment_idx on public.articles (segment);
create index if not exists articles_verified_idx on public.articles (verified);
create index if not exists articles_content_changed_idx on public.articles (content_changed_at);
create index if not exists articles_story_idx on public.articles (story_id);
create index if not exists articles_pipeline_run_id_idx on public.articles (pipeline_run_id);

-- Trend and "latest" queries order by published_at; the partial index keeps it
-- small by skipping the rows that have no usable date.
create index if not exists articles_published_at_idx
    on public.articles (published_at desc)
    where published_at is not null;
-- Resumable backfills: the rows still needing a parse / grouping pass are
-- exactly the ones these partial indexes cover.
create index if not exists articles_reprocess_requested_idx
    on public.articles (reprocess_requested_at)
    where reprocess_requested_at is not null;
create index if not exists articles_published_unparsed_idx
    on public.articles (id)
    where published_precision is null;
create index if not exists articles_story_unassigned_idx
    on public.articles (id)
    where story_id is null;

create table if not exists public.article_projects (
    article_id bigint not null references public.articles(id) on delete cascade,
    project_id bigint not null references public.projects(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (article_id, project_id)
);

create index if not exists article_projects_article_idx on public.article_projects (article_id);
create index if not exists article_projects_project_idx on public.article_projects (project_id);


-- =============================================================================
-- 9. Competitor study
-- =============================================================================
-- A second experience alongside sentiment projects. Competitor websites and
-- accounts become rows in `sources` linked through `project_sources`, so the
-- existing scraper, pipeline_runs, cancel support and projects.repeat_*
-- scheduler drive competitor scraping with no new machinery.

-- The user's own business. One per project: it is the reference point every
-- competitor and every "how does this affect us" judgement is measured against.
-- `context_summary` is the AI's reading of the market, derived from the scraped
-- website rather than from what the user typed, so the model reasons about the
-- business as it actually presents itself.
--
-- No CHECK on target_countries: ISO 3166-1 alpha-2 is ~249 codes, unmaintainable
-- as a SQL `in (...)` list. Validated in services/competitors/countries.py
-- instead, same as offerings/audience/differentiators/keywords already are.
create table if not exists public.business_profiles (
    id               bigint generated always as identity primary key,
    project_id       bigint not null unique references public.projects(id) on delete cascade,
    name             text not null,
    website          text,
    description      text,
    industry         text,
    market           text,
    geography        text,
    positioning      text,
    offerings        jsonb not null default '[]'::jsonb,
    audience         jsonb not null default '[]'::jsonb,
    differentiators  jsonb not null default '[]'::jsonb,
    keywords         jsonb not null default '[]'::jsonb,
    -- Which countries competitors should be located in; steers discovery.
    target_countries jsonb not null default '[]'::jsonb,
    -- Website scrape used to build the context above.
    scrape_status    text not null default 'pending',
    scrape_error     text,
    scraped_pages    integer not null default 0,
    scraped_chars    integer not null default 0,
    scraped_at       timestamptz,
    context_summary  text,
    embedding_json   jsonb default '[]'::jsonb,
    embedding_model  text,
    embedded_at      timestamptz,
    analysis_model   text,
    prompt_version   text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint business_profiles_scrape_status_check
        check (scrape_status in ('pending', 'running', 'success', 'failed', 'skipped'))
);

drop trigger if exists set_business_profiles_updated_at on public.business_profiles;
create trigger set_business_profiles_updated_at
before update on public.business_profiles
for each row
execute function public.set_updated_at();

-- Competitors, ranked. `size_rank` is the ordering the workspace presents
-- (1 = largest); `size_signals` records what that ranking was actually based on
-- so a user can see why one competitor outranks another instead of trusting an
-- opaque number.
--
-- `country` is where the company is headquartered, which for a large
-- multinational (McDonald's) is not where it actually competes with the user's
-- business (Lebanon). `operates_in_countries` records that instead - the target
-- countries this competitor was matched against during discovery - so the UI can
-- show "competes with you in Lebanon" alongside "based in United States".
--
-- `aliases` are other names the same company is published under. Attribution
-- otherwise matches only the exact `name`, that name with a legal suffix
-- stripped, and its bare domain label - which misses a Lebanese roaster reported
-- on in Arabic, a group trading under a different retail brand, or a name the
-- press routinely misspells. It is also the fix for the opposite failure: a
-- competitor whose name is an ordinary word ("Stories") fires on every article
-- containing it, so such names are dropped as automatic aliases. An alias listed
-- here is a deliberate human statement that this string identifies this company,
-- so it is trusted where a derived one is not.
--
-- The embedding is of the competitor's own identity (name, aliases,
-- description), so attribution can fall back to semantic similarity when a
-- competitor is never named literally - a rebrand, a translation, an indirect
-- reference. Same column shape as projects/articles, so
-- embeddings.cosine_similarity works against it unchanged.
create table if not exists public.competitors (
    id                    bigint generated always as identity primary key,
    project_id            bigint not null references public.projects(id) on delete cascade,
    name                  text not null,
    aliases               jsonb not null default '[]'::jsonb,
    website               text,
    domain                text,
    description           text,
    country               text,
    operates_in_countries jsonb not null default '[]'::jsonb,
    -- Ranking + why.
    size_tier             text not null default 'unknown',
    size_rank             integer,
    size_signals          jsonb not null default '{}'::jsonb,
    relevance_score       numeric,
    -- Lifecycle: discovered -> the user chooses what to actually track.
    status                text not null default 'suggested',
    discovery_source      text not null default 'ai',
    discovery_query       text,
    last_scraped_at       timestamptz,
    last_analyzed_at      timestamptz,
    embedding_json        jsonb default '[]'::jsonb,
    embedding_model       text,
    embedding_source      text,
    embedded_at           timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    constraint competitors_status_check
        check (status in ('suggested', 'tracked', 'ignored')),
    constraint competitors_size_tier_check
        check (size_tier in ('enterprise', 'mid_market', 'smb', 'startup', 'unknown'))
);

-- One row per competitor per project. Domain is the identity where present (two
-- discovery passes finding "Acme" and "Acme Inc." must not duplicate); name is
-- the fallback for competitors with no website yet.
create unique index if not exists competitors_project_domain_key
    on public.competitors (project_id, domain) where domain is not null;
create unique index if not exists competitors_project_name_key
    on public.competitors (project_id, lower(name)) where domain is null;

create index if not exists competitors_project_idx on public.competitors (project_id);
create index if not exists competitors_rank_idx on public.competitors (project_id, size_rank);
create index if not exists competitors_status_idx on public.competitors (project_id, status);

drop trigger if exists set_competitors_updated_at on public.competitors;
create trigger set_competitors_updated_at
before update on public.competitors
for each row
execute function public.set_updated_at();

-- Social/web accounts belonging to a competitor. Discovery guesses handles from
-- the competitor's name, and guesses are wrong often enough that they carry an
-- explicit validation state: nothing feeds analysis until it is `valid`. A
-- wrongly-attributed account would otherwise put another company's activity into
-- a report someone plans against.
create table if not exists public.competitor_accounts (
    id                bigint generated always as identity primary key,
    competitor_id     bigint not null references public.competitors(id) on delete cascade,
    platform          text not null,
    handle            text,
    url               text not null,
    confidence        numeric,
    validation_status text not null default 'pending',
    validation_reason text,
    -- Provenance: unlinking the scrapable source must not delete the account.
    source_id         bigint references public.sources(id) on delete set null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint competitor_accounts_validation_check
        check (validation_status in ('pending', 'valid', 'rejected'))
);

create unique index if not exists competitor_accounts_key
    on public.competitor_accounts (competitor_id, platform, lower(url));
create index if not exists competitor_accounts_competitor_idx
    on public.competitor_accounts (competitor_id);
create index if not exists competitor_accounts_source_idx
    on public.competitor_accounts (source_id);

drop trigger if exists set_competitor_accounts_updated_at on public.competitor_accounts;
create trigger set_competitor_accounts_updated_at
before update on public.competitor_accounts
for each row
execute function public.set_updated_at();

-- The analysis cards. Each answers exactly three questions:
--   whats_up - what the competitor is up to
--   impact   - how it affects us (judged against the business profile)
--   actions  - what we should do about it
--
-- `evidence` carries the source rows behind the card so every claim is one click
-- from the article that produced it; `story_count` counts distinct story_groups
-- rather than URLs, so a syndicated announcement carried by twenty outlets does
-- not read as twenty separate moves.
--
-- `confidence` is a bare 0.0-1.0 the model assigns itself; `confidence_reason`
-- is why. A reader deciding whether to act needs to know why it is a 0.4,
-- because "low confidence" and "low confidence because every source is the
-- company's own press release" call for different responses. Nullable with no
-- default: a finding generated before it existed has no explanation and must
-- read as absent rather than as an empty one.
create table if not exists public.competitor_findings (
    id                bigint generated always as identity primary key,
    project_id        bigint not null references public.projects(id) on delete cascade,
    competitor_id     bigint not null references public.competitors(id) on delete cascade,
    -- Provenance: which run the evidence was scoped to. A finding generated over
    -- a period_days date window instead simply has no run to scope to.
    pipeline_run_id   text references public.pipeline_runs(id) on delete set null,
    period_start      timestamptz,
    period_end        timestamptz,
    headline          text not null,
    whats_up          text not null,
    impact            text not null,
    impact_level      text not null default 'medium',
    actions           jsonb not null default '[]'::jsonb,
    signals           jsonb not null default '[]'::jsonb,
    evidence          jsonb not null default '[]'::jsonb,
    confidence        numeric,
    confidence_reason text,
    article_count     integer not null default 0,
    story_count       integer not null default 0,
    validation_status text not null default 'pending',
    validation_notes  text,
    analysis_model    text,
    prompt_version    text,
    generated_at      timestamptz not null default now(),
    created_at        timestamptz not null default now(),
    constraint competitor_findings_impact_check
        check (impact_level in ('high', 'medium', 'low')),
    constraint competitor_findings_validation_check
        check (validation_status in ('pending', 'validated', 'rejected'))
);

create index if not exists competitor_findings_project_idx
    on public.competitor_findings (project_id, generated_at desc);
create index if not exists competitor_findings_competitor_idx
    on public.competitor_findings (competitor_id, generated_at desc);
create index if not exists competitor_findings_impact_idx
    on public.competitor_findings (project_id, impact_level);
create index if not exists competitor_findings_pipeline_run_id_idx
    on public.competitor_findings (pipeline_run_id);


-- =============================================================================
-- 10. Seed data
-- =============================================================================

insert into public.permissions (key, description) values
    ('projects.view', 'View projects'),
    ('projects.create', 'Create projects'),
    ('projects.update', 'Edit projects'),
    ('projects.delete', 'Delete projects'),
    ('projects.link_users', 'Manage which dashboard users are linked to a project'),
    ('sources.view', 'View sources'),
    ('sources.create', 'Create sources'),
    ('sources.update', 'Edit sources'),
    ('sources.delete', 'Delete sources'),
    ('articles.view', 'View articles'),
    ('articles.delete', 'Delete all stored articles'),
    ('articles.import', 'Import articles from a JSONL export'),
    ('pipeline.view', 'View pipeline runs'),
    ('pipeline.run', 'Trigger the scraper pipeline'),
    ('pipeline.stop', 'Stop a running pipeline'),
    ('users.view', 'View dashboard users'),
    ('users.create', 'Create dashboard users'),
    ('users.update', 'Edit dashboard users (role/status)'),
    ('users.delete', 'Delete dashboard users'),
    ('roles.view', 'View roles and their permissions'),
    ('roles.create', 'Create new roles'),
    ('roles.update', 'Edit roles and their permission assignments'),
    ('roles.delete', 'Delete roles'),
    ('competitors.view', 'View competitor studies, competitors, and findings'),
    ('competitors.manage', 'Create and edit the business profile and competitors'),
    ('competitors.analyze', 'Run competitor discovery and generate analysis')
on conflict (key) do nothing;

insert into public.roles (name, description, is_system, full_access) values
    ('admin', 'Full access to every part of the app.', true, true),
    ('editor', 'Manage projects and sources; view articles and pipeline runs.', false, false),
    ('operator', 'Run and stop the pipeline; view and clear articles.', false, false),
    ('viewer', 'Read-only access to projects, sources, articles, and pipeline runs.', false, false)
on conflict (name) do nothing;

-- admin has full_access so it needs no explicit grant.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
    ('editor', 'projects.view'), ('editor', 'projects.create'), ('editor', 'projects.update'), ('editor', 'projects.delete'),
    ('editor', 'sources.view'), ('editor', 'sources.create'), ('editor', 'sources.update'), ('editor', 'sources.delete'),
    ('editor', 'articles.view'), ('editor', 'pipeline.view'),
    ('editor', 'competitors.view'), ('editor', 'competitors.manage'), ('editor', 'competitors.analyze'),
    ('operator', 'projects.view'), ('operator', 'sources.view'),
    ('operator', 'articles.view'), ('operator', 'articles.delete'), ('operator', 'articles.import'),
    ('operator', 'pipeline.view'), ('operator', 'pipeline.run'), ('operator', 'pipeline.stop'),
    ('operator', 'competitors.view'), ('operator', 'competitors.analyze'),
    ('viewer', 'projects.view'), ('viewer', 'sources.view'),
    ('viewer', 'articles.view'), ('viewer', 'pipeline.view'),
    ('viewer', 'competitors.view')
) as seed(role_name, perm_key)
join public.roles r on r.name = seed.role_name
join public.permissions p on p.key = seed.perm_key
on conflict do nothing;

-- Every project must be linked to every full_access ("admin") user by default.
-- New projects get this from projects_store.create_project(); this backfills any
-- project/admin created before that link existed.
insert into public.project_users (project_id, user_id)
select p.id, u.id
from public.projects p
cross join public.users u
join public.roles r on r.id = u.role_id
where r.full_access = true
on conflict (project_id, user_id) do nothing;
