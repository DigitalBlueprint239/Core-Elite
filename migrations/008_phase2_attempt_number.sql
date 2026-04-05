-- Migration 008: Phase 2 — attempt_number for immutable per-rep records
--
-- Framework ref: v1 §3.6.4, God-Tier Framework §Phase 2
--
-- Spec (verbatim):
--   "Immutable timing records. v1 §3.6.4 correctly identifies this: each rep
--    is a separate record with a monotonically increasing attempt_number. Two
--    scouts recording the same athlete write NEW records, not updating the
--    same record. This eliminates the majority of LWW conflicts. Do not merge.
--    Do not deduplicate at the DB layer. Best result is computed at query time."
--
-- Without attempt_number:
--   - Intermediate attempts are silently discarded on the client before the
--     "best" is submitted. If two scouts cover the same athlete, one result
--     is lost under LWW. The framework forbids this.
--
-- With attempt_number:
--   - Every rep is its own immutable row, identified by
--     (athlete_id, event_id, drill_type, attempt_number, device_id).
--   - Best-of-N is computed at query time: MIN(value_num) for time drills,
--     MAX(value_num) for distance/height drills.
--   - LWW conflicts are eliminated because there is no "same record" to fight
--     over — each attempt has a unique client_result_id.
--
-- This migration is idempotent (IF NOT EXISTS / CREATE OR REPLACE).

-- 1. Add attempt_number column — defaults to 1 so existing rows are valid
ALTER TABLE results ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1;

-- 2. Update submit_result_secure to accept and store attempt_number.
--    Adds p_attempt_number parameter (DEFAULT 1 preserves backward compat).
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
    v_result_id UUID;
    v_hlc       TEXT;
BEGIN
    -- Validate role (must be authenticated)
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Idempotency — duplicate client_result_id: record already exists.
    -- Add-biased LWW (v2 §3.1.2): return success, never discard.
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

    -- Extract hlc_timestamp from meta (promoted to first-class column in 007)
    v_hlc := p_meta->>'hlc_timestamp';

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
        auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
