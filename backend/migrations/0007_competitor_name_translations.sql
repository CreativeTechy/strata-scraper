-- Competitor names as written in each non-English interface language, for
-- display only ({"ar": "ستاربكس"}). `name` stays the canonical identity used
-- for dedupe, search, and attribution. Existing rows start empty and are
-- filled lazily the first time the competitor list is loaded in that language.
alter table public.competitors
    add column if not exists name_translations jsonb not null default '{}'::jsonb;
