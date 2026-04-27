-- =============================================================================
-- MIGRATION 008a: HLC timestamps across results, athletes, bands, waivers
-- Core Elite Combine 2026 · Mission "HLC v2 corpus"
-- =============================================================================
--
-- FILENAME NOTE: the mission spec asked for `migrations/008_hlc_timestamps.sql`
-- but slot `008_phase2_attempt_number.sql` was already taken by the Phase 2
-- attempt-number column work. Using `008a` preserves the lexical-order
-- semantics psql applies sequentially. The same naming convention was used
-- for `007a_add_source_type.sql` in the prior mission.
--
-- WHY this exists:
--   Multi-tablet offline reconnect at a 150-athlete combine produced
--   non-deterministic conflict resolution under wall-clock LWW: two
--   tablets writing the "same" event at the "same" Date.now() millisecond
--   would race, and the loser's row was silently overwritten on sync.
--   Replacing wall-clock with a Hybrid Logical Clock (Kulkarni & Demirbas
--   2014, framework v2 §3.1.3) gives every write a globally-unique,
--   lexicographically-sortable string key that all nodes agree on without
--   coordination.
--
--   Migration 007 already added `hlc_timestamp` to `results`. This
--   migration extends the same column + index pattern to the three other
--   write-heavy tables that take cross-tablet hits during a busy event:
--     - athletes (registration on the parent tablet, claim on the staff
--                 tablet — both create or update the same row)
--     - bands    (status flips: 'unassigned' → 'assigned' → 'released';
--                 a stale offline release must not clobber a fresh assign)
--     - waivers  (a parent on one device + a guardian on a second device
--                 may both submit the e-signature concurrently)
--
-- WHAT this does:
--   1. Idempotently adds `hlc_timestamp TEXT` to all four tables. The
--      results add is a no-op if migration 007 already applied.
--   2. Creates a B-Tree index per table. The TEXT column carries a
--      zero-padded `pt(16)_l(10)_id` string, so standard B-Tree gives
--      lexicographic ordering — that IS the temporal ordering.
--   3. Backfills legacy rows that pre-date HLC instrumentation by
--      synthesising an HLC from `created_at`. Format:
--        LPAD(EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 || '', 16, '0')
--          || '_0000000000_legacy'
--      Logical counter pinned to 0; nodeId pinned to 'legacy' so backfilled
--      rows never tie-break against a real tablet.
--
-- IDEMPOTENCY: Re-runnable. ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS, conditional UPDATE only on rows where hlc_timestamp IS NULL.
-- =============================================================================

BEGIN;

-- 1. Columns ----------------------------------------------------------------

ALTER TABLE results  ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;
ALTER TABLE bands    ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;
ALTER TABLE waivers  ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;

-- 2. B-Tree indexes ---------------------------------------------------------
--
-- TEXT column with the zero-padded pt(16)_l(10) prefix sorts
-- lexicographically equal to its temporal order. No custom collation
-- required; the default lexicographic compare is the conflict-resolution
-- comparator the application layer relies on.

CREATE INDEX IF NOT EXISTS idx_results_hlc_timestamp  ON results  (hlc_timestamp);
CREATE INDEX IF NOT EXISTS idx_athletes_hlc_timestamp ON athletes (hlc_timestamp);
CREATE INDEX IF NOT EXISTS idx_bands_hlc_timestamp    ON bands    (hlc_timestamp);
CREATE INDEX IF NOT EXISTS idx_waivers_hlc_timestamp  ON waivers  (hlc_timestamp);

-- 3. Backfill ---------------------------------------------------------------
--
-- Synthesises an HLC for any pre-existing row that has no live HLC value.
-- Pattern (per spec):
--   LPAD(EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 || '', 16, '0')
--     || '_0000000000_legacy'
--
-- COALESCE(created_at, NOW()) defends against the rare case where a row
-- has been created without a created_at default — the synthesised HLC
-- still uses NOW() as the physical-time anchor so we never produce a
-- malformed string.

UPDATE results
SET    hlc_timestamp =
       LPAD(EXTRACT(EPOCH FROM COALESCE(created_at, NOW()))::BIGINT * 1000 || '', 16, '0')
       || '_0000000000_legacy'
WHERE  hlc_timestamp IS NULL;

UPDATE athletes
SET    hlc_timestamp =
       LPAD(EXTRACT(EPOCH FROM COALESCE(created_at, NOW()))::BIGINT * 1000 || '', 16, '0')
       || '_0000000000_legacy'
WHERE  hlc_timestamp IS NULL;

UPDATE bands
SET    hlc_timestamp =
       LPAD(EXTRACT(EPOCH FROM COALESCE(created_at, NOW()))::BIGINT * 1000 || '', 16, '0')
       || '_0000000000_legacy'
WHERE  hlc_timestamp IS NULL;

UPDATE waivers
SET    hlc_timestamp =
       LPAD(EXTRACT(EPOCH FROM COALESCE(created_at, NOW()))::BIGINT * 1000 || '', 16, '0')
       || '_0000000000_legacy'
WHERE  hlc_timestamp IS NULL;

-- 4. Documentation ---------------------------------------------------------

COMMENT ON COLUMN results.hlc_timestamp IS
  'Hybrid Logical Clock — pt(16)_l(10)_nodeId. Lexicographically sortable. ' ||
  'Server-side LWW: greater string wins. Backfilled rows carry _legacy node id.';
COMMENT ON COLUMN athletes.hlc_timestamp IS
  'Hybrid Logical Clock — see results.hlc_timestamp. Disambiguates concurrent ' ||
  'registration/claim writes across the parent + staff tablets.';
COMMENT ON COLUMN bands.hlc_timestamp IS
  'Hybrid Logical Clock — see results.hlc_timestamp. Prevents stale offline ' ||
  'band-release writes from clobbering a fresh assign.';
COMMENT ON COLUMN waivers.hlc_timestamp IS
  'Hybrid Logical Clock — see results.hlc_timestamp. Resolves dual-guardian ' ||
  'concurrent e-signature submissions deterministically.';

COMMIT;
