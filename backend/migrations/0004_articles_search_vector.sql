-- Search used to be a bounded in-Python scan: _search_results() pulled the
-- newest SEARCH_SCAN_LIMIT (1000) rows - including full article text - and
-- scored them in Python. Anything older than that was unfindable within a
-- couple of days at this app's collection rate, `total` reported the scan
-- size rather than the real match count, and a filtered export silently
-- capped at 1000 rows with no warning - in the one feature this app exists
-- to provide.
--
-- A generated tsvector column plus a GIN index lets Postgres do the ranking
-- instead: unbounded, indexed, and with an accurate count(*). Generated
-- (not maintained by application code) so it can never drift from the
-- columns it's built from, and STORED so the GIN index has something to
-- index without recomputing the vector on every read.
alter table public.articles
    add column if not exists search_vector tsvector
        generated always as (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(author, '') || ' ' || coalesce(source, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(text, '')), 'C')
        ) stored;

create index if not exists articles_search_vector_idx on public.articles using gin (search_vector);

comment on column public.articles.search_vector is
    'Generated tsvector over title/author/source/text, weighted title > author/source > body - backs full-text search (see services/articles/articles_store.py) instead of the old bounded in-Python ILIKE scan.';
