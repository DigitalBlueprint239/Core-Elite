-- =============================================================================
-- MIGRATION 007a: source_type discriminator + CHECK + index
-- Core Elite Combine 2026 · Mission "p_source_type"
-- =============================================================================
--
-- FILENAME NOTE: the mission spec asked for `migrations/007_add_source_type.sql`
-- but slot `007_phase2_hlc_timestamp.sql` was already taken by the HLC
-- timestamp column work. Overwriting that file would destroy a foundational
-- migration. We use `007a` to preserve numeric proximity (sorts after 007,
-- before 008) so psql's lexical-order sequential application stays correct.
--
-- WHY this exists:
--   The system must definitively distinguish hand-typed data from BLE-
--   captured data. Without that distinction, the "verified by hardware"
--   trust signal that backs the $36k dashboard collapses — every row looks
--   the same and recruiters lose the moat.
--
-- WHAT this does:
--   1. Adds `results.source_type TEXT NOT NULL DEFAULT 'manual'`. If migration
--      019 already added the column with default `'manual_staff'`, we
--      back-fill it to align with the new four-value domain.
--   2. Drops the legacy CHECK constraint installed by mig 019 (which
--      allowed only `'live_ble' | 'manual_staff'`).
--   3. Installs the new CHECK constraint with the spec's full domain:
--          'manual' | 'live_ble' | 'imported_csv' | 'webhook'
--   4. Sets the column DEFAULT to `'manual'` (the safe, conservative default
--      — never claim hardware verification by accident).
--   5. Creates the single-column `idx_results_source_type` for the
--      `source_type IN (...)` filters that the export verifier and the
--      AdminDiagnostics dashboard use.
--
-- IDEMPOTENCY: Re-runnable. ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF
-- EXISTS, conditional UPDATE only on rows still carrying the legacy value,
-- CREATE INDEX IF NOT EXISTS.
-- =============================================================================

BEGIN;

-- 1. Column ----------------------------------------------------------------
--
-- IF NOT EXISTS makes this a no-op when migration 019 has already run.
-- The column was originally introduced with DEFAULT 'manual_staff'; we'll
-- override that DEFAULT below to align with the new spec.
ALTER TABLE results
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'manual';

-- 2. Drop the legacy CHECK constraint --------------------------------------
--
-- Mig 019 installed `results_source_type_check` with the two-value domain
-- ('live_ble', 'manual_staff'). The new four-value domain supersedes it.
ALTER TABLE results
  DROP CONSTRAINT IF EXISTS results_source_type_check;

-- 3. Back-fill legacy values onto the new domain ---------------------------
--
-- 'manual_staff' → 'manual' (one-to-one mapping; the new domain drops the
-- now-redundant '_staff' suffix). 'live_ble' is preserved unchanged.
UPDATE results
SET    source_type = 'manual'
WHERE  source_type = 'manual_staff';

-- 4. Realign the column DEFAULT to the new safe value ----------------------
ALTER TABLE results
  ALTER COLUMN source_type SET DEFAULT 'manual';

-- 5. Install the new CHECK constraint --------------------------------------
ALTER TABLE results
  ADD CONSTRAINT results_source_type_check
  CHECK (source_type IN ('manual', 'live_ble', 'imported_csv', 'webhook'));

-- 6. Single-column index per spec ------------------------------------------
--
-- A composite (athlete_id, source_type) index already exists from mig 019
-- for the per-athlete export query. The spec also wants a single-column
-- index for the broader `WHERE source_type IN (...)` scans used by the
-- AdminDiagnostics counter row and the trust-center dashboard.
CREATE INDEX IF NOT EXISTS idx_results_source_type
  ON results (source_type);

-- 7. Documentation ---------------------------------------------------------
COMMENT ON COLUMN results.source_type IS
  'Provenance discriminator: manual | live_ble | imported_csv | webhook. ' ||
  'Required on every insert via submit_result_secure. Hardware-verified ' ||
  'rows (live_ble) are the only ones eligible for the cryptographic ' ||
  'verification_hash signing path.';

COMMIT;
