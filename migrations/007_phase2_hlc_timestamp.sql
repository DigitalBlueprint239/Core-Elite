-- Migration 007: Phase 2 — Promote hlc_timestamp to first-class column
--
-- Framework ref: v2 §3.1.3, v3 §3.1.2
--
-- Problem (God-Tier Framework §Phase 2):
--   The v1 schema has no hlc_timestamp column on results. The HLC string is
--   embedded in meta JSONB, which means:
--     1. It cannot be indexed for efficient sync-delta queries.
--     2. The server cannot enforce or validate the format.
--     3. Conflict resolution logic cannot reference the column directly in SQL.
--
-- Solution: promote hlc_timestamp to a TEXT column on results.
--   Format: "{pt:016d}_{l:010d}_{nodeId}" — lexicographically sortable,
--   so a standard B-Tree index gives correct temporal order (v3 §3.1.2).
--
-- This migration is idempotent (IF NOT EXISTS / CREATE OR REPLACE).

-- 1. Add hlc_timestamp column to results
ALTER TABLE results ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;

-- 2. Backfill from existing meta JSONB for any rows already present
UPDATE results
SET hlc_timestamp = meta->>'hlc_timestamp'
WHERE hlc_timestamp IS NULL
  AND meta->>'hlc_timestamp' IS NOT NULL;

-- 3. Index for sync-delta queries — replaces the conceptual "idx_results_updated_at"
--    from v2 §3.3.3 (the HLC is our authoritative write-order field, not updated_at).
CREATE INDEX IF NOT EXISTS idx_results_hlc_timestamp
    ON results (hlc_timestamp);

-- 4. Update submit_result_secure to store hlc_timestamp as a first-class column.
--    The value is extracted from p_meta->>'hlc_timestamp' so the RPC signature
--    is unchanged — callers that already embed hlc_timestamp in meta work without
--    modification. The dedicated column is populated server-side.
CREATE OR REPLACE FUNCTION submit_result_secure(
    p_client_result_id UUID,
    p_event_id         UUID,
    p_athlete_id       UUID,
    p_band_id          TEXT,
    p_station_id       TEXT,
    p_drill_type       TEXT,
    p_value_num        NUMERIC,
    p_meta             JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result_id    UUID;
    v_hlc          TEXT;
BEGIN
    -- Validate role (must be authenticated)
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Idempotency check — duplicate client_result_id means the record already
    -- exists. Return success with status='duplicate' so the client removes it
    -- from the outbox. Add-biased LWW: never discard a result (v2 §3.1.2).
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

    -- Extract hlc_timestamp from meta if the caller embedded it there.
    -- Phase 2: this becomes the canonical server-side storage path.
    v_hlc := p_meta->>'hlc_timestamp';

    -- Insert result with hlc_timestamp promoted to its own column
    INSERT INTO results (
        client_result_id,
        event_id,
        athlete_id,
        band_id,
        station_id,
        drill_type,
        value_num,
        meta,
        hlc_timestamp,
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
        p_meta,
        v_hlc,
        auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
