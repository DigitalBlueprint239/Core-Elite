# Core Elite — Database Migration Sequence

## How to provision a fresh database

Run the numbered SQL files against your Supabase project **in strict numeric order**:

```
001_initial_schema.sql          ← baseline tables + RLS policies
002_create_events_and_core_tables.sql
003_device_status_updates.sql
...
020_add_override_pin_to_events.sql
021                             ← reserved (supabase/migrations/ only)
022_add_high_school_column.sql
```

Use the Supabase SQL editor, `psql`, or the Supabase CLI:
```bash
supabase db push   # applies supabase/migrations/ via CLI
# or
psql $DATABASE_URL -f migrations/001_initial_schema.sql
psql $DATABASE_URL -f migrations/002_create_events_and_core_tables.sql
# ... and so on
```

## Numbering conventions

| Range    | Status     | Notes                                              |
|----------|------------|----------------------------------------------------|
| 001      | Seed       | Baseline schema. Always run first.                 |
| 002–019  | Core       | Schema evolution, hardening, Phase 2 features.     |
| 020      | Feature    | Override PIN column on events.                     |
| 021      | Reserved   | Exists only in `supabase/migrations/` (CLI format).|
| 022+     | Feature    | Post-Mission A additions (high_school column, …).  |

## Two migration directories

| Directory             | Format                   | Used by                  |
|-----------------------|--------------------------|--------------------------|
| `migrations/`         | `NNN_description.sql`    | Manual / psql runs       |
| `supabase/migrations/`| `YYYYMMDDHHmmss_desc.sql`| Supabase CLI (`db push`) |

Migrations 018–021 exist in both directories (different filename formats, same SQL).
When adding a new migration, add it to **both** directories to keep them in sync.

## What NOT to use

`supabase_schema.sql` at the repo root is a **historical snapshot** of the
original baseline schema. It is intentionally out of date and carries a warning
header. Do not use it to provision a new database — use `001_initial_schema.sql`
and the numbered sequence instead.
