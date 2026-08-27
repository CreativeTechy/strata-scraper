-- pipeline_run_id is a foreign key into this database's own pipeline_runs,
-- so it is deliberately dropped at export time (see
-- services/articles/articles_store.py's EXPORT_LOCAL_ONLY_FIELDS) - exported,
-- it would fail the FK constraint on the importing app's database, which has
-- no such run.
--
-- source_run_snapshot carries the same provenance across that boundary
-- without being a live reference: it is a denormalized copy of the run's
-- identity, captured once at save time, so it survives the JSONL
-- export/import round trip and lets the receiving app show "collected in
-- scraper-app run X on <date>" without ever needing to reach back into this
-- database.
alter table public.articles
    add column if not exists source_run_snapshot jsonb;

comment on column public.articles.source_run_snapshot is
    'Denormalized snapshot of the pipeline run that first collected this article - {id, started_at, project_id} - set alongside pipeline_run_id (same first-writer-wins semantics) but, unlike that column, included in the JSONL export because it is a self-contained copy, not a foreign key.';

-- Backfill for rows saved before this column existed, from the still-live
-- pipeline_run_id / pipeline_runs join.
update public.articles a
set source_run_snapshot = jsonb_build_object(
    'id', pr.id,
    'started_at', pr.started_at,
    'project_id', pr.project_id
)
from public.pipeline_runs pr
where a.pipeline_run_id = pr.id
  and a.source_run_snapshot is null;
