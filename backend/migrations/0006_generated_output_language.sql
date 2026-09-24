-- Record the locale used for persisted LLM prose. Existing rows remain NULL:
-- their language cannot be inferred safely from the UI locale at migration time.
alter table public.business_profiles
    add column if not exists generated_language text;

alter table public.cultural_analyses
    add column if not exists generated_language text;

alter table public.competitors
    add column if not exists generated_language text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'business_profiles_generated_language_check'
          and conrelid = 'public.business_profiles'::regclass
    ) then
        alter table public.business_profiles
            add constraint business_profiles_generated_language_check
            check (generated_language is null or generated_language in ('en', 'ar'));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conname = 'cultural_analyses_generated_language_check'
          and conrelid = 'public.cultural_analyses'::regclass
    ) then
        alter table public.cultural_analyses
            add constraint cultural_analyses_generated_language_check
            check (generated_language is null or generated_language in ('en', 'ar'));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conname = 'competitors_generated_language_check'
          and conrelid = 'public.competitors'::regclass
    ) then
        alter table public.competitors
            add constraint competitors_generated_language_check
            check (generated_language is null or generated_language in ('en', 'ar'));
    end if;
end $$;
