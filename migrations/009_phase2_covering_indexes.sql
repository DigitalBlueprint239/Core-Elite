-- Migration 009: Phase 2 — Composite covering indexes per v2 §3.3.3
--
-- Framework ref: v2 §3.3.3, God-Tier Framework §Phase 2
--
-- Spec (verbatim):
--   "Add composite covering indexes at the SQLite layer. v2 §3.3.3 provides
--    the exact SQL:
--      idx_results_athlete_event   — most common query: all results for an athlete in an event
--      idx_results_updated_at      — sync delta query
--      idx_results_pending_validation — partial index on unvalidated results
--      idx_athletes_event_deleted  — check-in flow
--      idx_outbox_pending          — partial index on sync outbox
--    Without these, each reactive WatermelonDB query triggers a full table
--    scan during sync, blocking the UI thread even in JSI mode."
--
-- Stack adaptation notes:
--   - "SQLite layer" maps to Supabase PostgreSQL for server-side tables and
--     IndexedDB for the client outbox (IndexedDB upgrade handled in offline.ts).
--   - "idx_results_updated_at" → idx_results_hlc_timestamp (created in 007).
--     The HLC is the authoritative write-order field on this stack.
--   - "idx_outbox_pending" → idx_report_jobs_pending on the server-side async
--     queue (report_jobs). The client IndexedDB outbox gains by_status index
--     via offline.ts DB version bump.
--   - "idx_results_pending_validation" requires a validation_status column
--     to create a meaningful partial index.
--   - "idx_athletes_event_deleted" requires a deleted_at column for soft-delete.
--
-- This migration is idempotent (IF NOT EXISTS / CREATE OR REPLACE).

-- -----------------------------------------------------------------------
-- 1. Add validation_status to results
--    'clean'        — passed all 4 gates automatically
--    'extraordinary' — Gate 4 fired; scout confirmed; pending admin review
--    'reviewed'     — admin has reviewed and signed off
-- -----------------------------------------------------------------------
ALTER TABLE results
    ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'clean'
    CHECK (validation_status IN ('clean', 'extraordinary', 'reviewed'));

-- Backfill rows where Gate 4 was flagged via meta JSONB
UPDATE results
SET validation_status = 'extraordinary'
WHERE validation_status = 'clean'
  AND (meta->>'extraordinary_result')::boolean IS TRUE;

-- -----------------------------------------------------------------------
-- 2. Add soft-delete support to athletes (idx_athletes_event_deleted)
--    Allows an athlete to be removed from a combine without hard-deleting
--    their registration record. NULL = active; non-null = soft-deleted.
-- -----------------------------------------------------------------------
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- -----------------------------------------------------------------------
-- 3. Composite covering indexes
-- -----------------------------------------------------------------------

-- (a) idx_results_athlete_event
--     Most common query: "all results for athlete X in event Y"
--     Used by: admin dashboard, BES scoring pipeline, parent portal
--     Replaces the weaker single-column idx_results_athlete_id.
DROP INDEX IF EXISTS idx_results_athlete_id;
CREATE INDEX IF NOT EXISTS idx_results_athlete_event
    ON results (athlete_id, event_id);

-- (b) idx_results_hlc_timestamp (created in 007 — listed here for completeness)
--     Sync delta query: "all results written after HLC timestamp T"
--     Already exists; no-op if re-run.
CREATE INDEX IF NOT EXISTS idx_results_hlc_timestamp
    ON results (hlc_timestamp);

-- (c) idx_results_pending_validation
--     Partial index — only rows in 'extraordinary' status.
--     Used by: admin review queue, Scout Review dashboard panel.
--     Small index (only extraordinary results) → near-zero overhead.
CREATE INDEX IF NOT EXISTS idx_results_pending_validation
    ON results (event_id, recorded_at)
    WHERE validation_status = 'extraordinary';

-- (d) idx_athletes_event_deleted
--     Check-in flow: "all active athletes for event Y"
--     Partial index excludes soft-deleted athletes → clean active-only queries.
CREATE INDEX IF NOT EXISTS idx_athletes_event_deleted
    ON athletes (event_id)
    WHERE deleted_at IS NULL;

-- (e) idx_report_jobs_pending
--     Server-side async queue partial index (maps to "idx_outbox_pending").
--     report_jobs is the server-side processing queue equivalent.
CREATE INDEX IF NOT EXISTS idx_report_jobs_pending
    ON report_jobs (event_id, id)
    WHERE status = 'pending';

-- -----------------------------------------------------------------------
-- 4. Update submit_result_secure to set validation_status from meta
--    (attempt_number + hlc_timestamp already added in 007/008)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_result_secure(
    p_client_result_id UUID,
    p_event_id         UUID,
    p_athlete_id       UUID,
    p_band_id          TEXT,
    p_station_id       TEXT,
    p_drill_type       TEXT,
    p_value_num        NUMERIC,
    p_attempt_number   INT  DEFAULT 1,
    p_meta             JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result_id        UUID;
    v_hlc              TEXT;
    v_validation_status TEXT;
BEGIN
    -- Validate role (must be authenticated)
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Idempotency — add-biased LWW (v2 §3.1.2): never discard a result.
    SELECT id INTO v_result_id
    FROM results
    WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success',   true,
            'result_id', v_result_id,
            'status',    'duplicate'
        );
    END IF;

    -- Extract first-class fields from meta
    v_hlc := p_meta->>'hlc_timestamp';

    -- Determine validation_status from Gate 4 flag in meta
    -- 'extraordinary' = scout-confirmed result pending admin review
    v_validation_status := CASE
        WHEN (p_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id,
        event_id,
        athlete_id,
        band_id,
        station_id,
        drill_type,
        value_num,
        attempt_number,
        meta,
        hlc_timestamp,
        validation_status,
        recorded_by
    )
    VALUES (
        p_client_result_id,
        p_event_id,
        p_athlete_id,
        p_band_id,
        p_station_id,
        p_drill_type,
        p_value_num,
        p_attempt_number,
        p_meta,
        v_hlc,
        v_validation_status,
        auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
