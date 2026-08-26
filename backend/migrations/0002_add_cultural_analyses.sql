-- Cultural analysis: how well the business's profile fits the culture(s) it
-- chose to target (business_profiles.target_countries). One row per project,
-- optional — a study with no target countries chosen never gets one. Mirrors
-- business_profiles' shape and its set_updated_at() trigger convention.
create table if not exists public.cultural_analyses (
    id               bigint generated always as identity primary key,
    project_id       bigint not null unique references public.projects(id) on delete cascade,
    status           text not null default 'pending',
    -- Snapshot of the countries this analysis was actually run against, since
    -- the profile's target_countries can change after the fact.
    target_countries jsonb not null default '[]'::jsonb,
    summary          text,
    success_factors  jsonb not null default '[]'::jsonb,
    benefits         jsonb not null default '[]'::jsonb,
    challenges       jsonb not null default '[]'::jsonb,
    insights         jsonb not null default '[]'::jsonb,
    error            text,
    analysis_model   text,
    prompt_version   text,
    generated_at     timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    constraint cultural_analyses_status_check
        check (status in ('pending', 'running', 'success', 'failed'))
);

create index if not exists cultural_analyses_project_idx on public.cultural_analyses (project_id);

drop trigger if exists set_cultural_analyses_updated_at on public.cultural_analyses;
create trigger set_cultural_analyses_updated_at
before update on public.cultural_analyses
for each row
execute function public.set_updated_at();
