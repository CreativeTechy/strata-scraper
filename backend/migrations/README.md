# Schema migrations

This directory is empty on purpose. It is tracked in git by this file so the
migration runner has somewhere to look and the next migration has somewhere to
go — an untracked empty directory would simply not exist on a fresh clone.

The whole schema currently lives in [`../schema.sql`](../schema.sql), which the
runner applies as version `0001_baseline`.

## Filename convention

```
NNNN_short_snake_case_name.sql
```

- `NNNN` is a zero-padded four-digit number, applied in ascending order.
- `0001` is **reserved** for the `schema.sql` baseline. `backend/migrate.py`
  rejects a file that tries to claim it.
- The rest of the name is lowercase letters, digits and underscores. Anything
  else is a hard error at discovery time, not a file that gets quietly skipped.
- Numbers must be unique. Duplicates are a hard error.

Start the next migration at `0002`. The numbers `0002`–`0028` were used once and
squashed away (see below); reusing them is fine, because no database that
recorded them still exists.

## Never edit a migration that has been applied

`schema_migrations` stores each version alongside a SHA-256 of the file that was
applied. On every startup the runner re-hashes what is on disk and compares.

If the hashes disagree, the runner **refuses to start** rather than continuing:

```
Migration failed: These migrations were modified after being applied: 0007_...
Add a new migration instead of editing an applied one.
```

This is deliberate. A migration that has already run cannot be un-run by editing
it — the database that applied the old text still has the old shape, while a
fresh database gets the new one. The two silently diverge, and the schema in git
stops describing either of them. Editing is only ever safe on a migration that
has not reached any database yet, and the runner cannot tell the difference, so
it treats every change as the dangerous case.

Correct the mistake with a new, higher-numbered migration.

The baseline is the one exception: `schema.sql` is expected to keep evolving, is
idempotent, and is re-applied whenever its checksum moves. That is how an
existing database picks up additive baseline changes.

## When squashing is legitimate

Folding every migration back into the baseline is safe **only when no database
that applied them piecemeal still needs to be reached** — in practice, when
every environment is disposable and gets recreated from the baseline.

That was true when `0002`–`0028` were squashed into `schema.sql`, and it is the
only condition under which the operation is sound. If any long-lived database
exists that you cannot recreate, do not squash: its rows are the reason those
migrations were written one at a time.

Two consequences worth knowing before doing it again:

1. **Orphaned tracking rows are harmless.** A database that recorded
   `0002`–`0028` keeps those rows in `schema_migrations` after the files are
   gone. The runner only iterates the files it discovers on disk, so rows with
   no matching file are never looked at — they do not count as pending and they
   do not count as drift. Leaving them is fine.

2. **A squash cannot remove things from an existing database.** The baseline is
   built from `create table if not exists`, which does nothing at all when the
   table is already there. So on a database that already has the old schema, a
   new baseline will *add* what is missing but will **not**:
   - drop a table or column the new baseline no longer declares,
   - tighten a column's nullability,
   - remove a policy, or disable row-level security,
   - add a constraint to a table that already exists.

   Anything in that list has to reach existing databases as a real numbered
   migration, or be accepted as fresh-database-only and documented. See
   "Squash convergence" in the project README for what the `0002`–`0028` squash
   deliberately left behind.

## Running it

```
python migrate.py            # apply anything pending
python migrate.py --status   # show applied/pending, change nothing
python migrate.py --verify   # exit non-zero if pending or drifted (CI)
```

The API process calls `run_on_startup()` and refuses to serve if it fails: a
backend answering requests against a schema it does not match gives wrong
answers silently, which is worse than not starting.
