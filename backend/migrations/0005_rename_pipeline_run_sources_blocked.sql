-- pipeline_run_sources.blocked counted articles content_guard rejected for
-- being too short/titleless/a consent page - nothing to do with the source
-- itself being blocked (that's network_blocked/http_status). The name read
-- as "the website blocked the scrape", which it never meant. Renamed to
-- content_filtered to match date_filtered's naming and stop the confusion.
--
-- Guarded because schema.sql (re-applied idempotently on every startup)
-- already declares the column as content_filtered directly - on a fresh
-- database schema.sql creates it with the new name before this migration
-- ever runs, so "blocked" won't exist here to rename.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'pipeline_run_sources' and column_name = 'blocked'
    ) and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'pipeline_run_sources' and column_name = 'content_filtered'
    ) then
        alter table public.pipeline_run_sources rename column blocked to content_filtered;
    end if;
end $$;
