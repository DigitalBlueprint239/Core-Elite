-- =============================================================================
-- MIGRATION 020: Legacy CSV Import Support
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--
--   1. Expands the results.source_type check constraint to include 'imported_csv'.
--      This allows the process-vendor-import Edge Function to tag imported
--      rows distinctly from live BLE captures and manual staff entries.
--
--   2. Partial index on source_type = 'imported_csv' so admin queries (e.g.
--      "show only imported records") stay fast as the table grows.
--
--   3. Partial index for Realtime filter: Supabase Realtime subscriptions can
--      now use filter = 'source_type=neq.imported_csv' to exclude imports from
--      live dashboards without a full-table scan.
--
-- WHY NOT USE 'manual':
--   Legacy CSV rows differ semantically from staff manual entry — they lack a
--   station operator, may predate the current event, and should be hidden from
--   real-time combine dashboards. Using a dedicated source_type makes filtering
--   unambiguous and prevents accidental inclusion in live analytics.
--
-- IDEMPOTENCY: Safe to run multiple times.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ensure source_type column exists, then set/expand check constraint
--
-- Migration 019 added this column but may not have been applied to all
-- environments. This migration is self-contained and handles both cases:
--   a) Column doesn't exist yet → ADD COLUMN, then ADD CONSTRAINT
--   b) Column exists with old 2-value constraint → DROP + re-ADD CONSTRAINT
-- ---------------------------------------------------------------------------

-- Ensure the column exists (idempotent IF NOT EXISTS)
ALTER TABLE results
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';

-- Also ensure other columns from 019 exist in case that migration was skipped
ALTER TABLE results ADD COLUMN IF NOT EXISTS verification_hash TEXT;
ALTER TABLE results ADD COLUMN IF NOT EXISTS session_id        TEXT;

-- Ensure the source_type constraint allows all three values
ALTER TABLE results DROP CONSTRAINT IF EXISTS results_source_type_check;

ALTER TABLE results
  ADD CONSTRAINT results_source_type_check
  CHECK (source_type IN ('live_ble', 'manual', 'imported_csv'));

-- Back-fill any rows that may have been inserted before the constraint with
-- unexpected values — defensive only, should be a no-op on a healthy DB.

-- ---------------------------------------------------------------------------
-- 2. Partial index: import rows
-- (Use only columns guaranteed to exist across all schema versions)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_results_imported_csv
    ON results (event_id, athlete_id, drill_type)
    WHERE source_type = 'imported_csv';

-- ---------------------------------------------------------------------------
-- 3. Partial index: non-legacy rows (supports Realtime filter exclusion)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_results_non_legacy
    ON results (event_id)
    WHERE source_type != 'imported_csv';

COMMIT;
