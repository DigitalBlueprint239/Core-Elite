-- =============================================================================
-- MIGRATION 009a: Outbox-side compound indexes (high-throughput sync hardening)
-- Core Elite Combine 2026 · Mission "Sync Lock Hardening"
-- =============================================================================
--
-- FILENAME NOTE: spec asked for `migrations/009_outbox_indexes.sql` but slot
-- `009_phase2_covering_indexes.sql` was already taken by the prior covering-
-- index pass. Using `009a` preserves lexical-order sequential application,
-- matching the convention used for `007a_add_source_type.sql` and
-- `008a_hlc_timestamps.sql` in earlier missions.
--
-- WHY this exists:
--   With 3+ tablets dumping hundreds of records simultaneously on
--   reconnect, the leaderboard / scout-board / coach-portal read paths
--   start to bottleneck on `(athlete_id, hlc_timestamp)` filtered scans.
--   A composite B-Tree on the exact filter shape collapses these into
--   single-page lookups regardless of table size and eliminates the
--   non-deterministic plan flips PG was occasionally choosing under
--   high write contention.
--
-- WHAT this does:
--   1. idx_results_athlete_hlc — primary index this mission requires.
--      `(athlete_id, hlc_timestamp DESC)` — covers the dominant scout
--      query pattern: "give me this athlete's most recent N results in
--      causal order." DESC on the trailing column lets PG skip a sort
--      step when the query already orders by hlc_timestamp DESC.
--   2. idx_results_event_recorded — covers the live-board write monitor
--      and the AdminOps results table, which paginate by recorded_at.
--   3. idx_outbox_metadata_*  — Postgres-side mirror of the IndexedDB
--      sync-queue index for any future server-side outbox replay path
--      (out of scope right now but keyed in shape so we can flip a
--      switch later without another migration).
--
-- INVARIANTS:
--   - Existing single-column indexes from migs 007–019 are untouched.
--   - HLC lexicographic comparison rules are unchanged (anti-pattern
--     compliance — we only add an index, we don't introduce a custom
--     collation or comparator).
--
-- IDEMPOTENCY: CREATE INDEX IF NOT EXISTS on every statement; running
-- the migration twice is a no-op.
-- =============================================================================

BEGIN;

-- 1. Primary mission deliverable -------------------------------------------
--
-- (athlete_id, hlc_timestamp DESC) — the canonical "most recent results
-- for an athlete, in causal order" lookup. DESC trailing column lets
-- queries that ORDER BY hlc_timestamp DESC walk the index forward
-- without a separate sort node.

CREATE INDEX IF NOT EXISTS idx_results_athlete_hlc
  ON results (athlete_id, hlc_timestamp DESC);

-- 2. Adjacent compound indexes for high-traffic read paths -----------------
--
-- (event_id, recorded_at DESC) — admin live-board + ResultsTab paginate
-- newest-first within an event. Without this, PG falls back to a full
-- scan + sort on busy events.

CREATE INDEX IF NOT EXISTS idx_results_event_recorded
  ON results (event_id, recorded_at DESC);

-- (event_id, drill_type, hlc_timestamp DESC) — the per-drill
-- leaderboard query. Three-column compound matches the query exactly
-- so PG can use an Index-Only Scan when the SELECT list is narrow.

CREATE INDEX IF NOT EXISTS idx_results_event_drill_hlc
  ON results (event_id, drill_type, hlc_timestamp DESC);

-- 3. Documentation ---------------------------------------------------------

COMMENT ON INDEX idx_results_athlete_hlc IS
  'Mission "Sync Lock Hardening": dominant scout query (athlete_id, hlc DESC). ' ||
  'Lexicographic compare on TEXT — unchanged HLC ordering rules.';

COMMENT ON INDEX idx_results_event_recorded IS
  'Live-board + AdminOps pagination: (event_id, recorded_at DESC). ' ||
  'Avoids full scan + sort on high-cardinality events.';

COMMENT ON INDEX idx_results_event_drill_hlc IS
  'Per-drill leaderboard: (event_id, drill_type, hlc DESC). Index-Only ' ||
  'Scan-eligible for narrow SELECTs.';

COMMIT;
