-- =============================================================================
-- MIGRATION 019: Cryptographic Verification — B2B Hardware-Attestation Layer
-- Core Elite Combine 2026
-- =============================================================================
--
-- CONTEXT:
--   Core Elite sells verified combine data to college recruiting programs.
--   This migration adds the server-side columns required for the
--   generate-verified-export Edge Function to attest that a result was
--   captured live by BLE laser hardware and not manually keyed in.
--
-- CHANGES:
--
--   1. results.verification_hash TEXT (nullable)
--      Populated by the generate-verified-export Edge Function.
--      HMAC-SHA-256(VERIFICATION_SECRET, canonical_payload_string).
--      NULL = result has not been verified yet, or source_type = 'manual'.
--
--   2. results.source_type TEXT NOT NULL DEFAULT 'manual'
--      Set by the client at write time.
--      'live_ble'     — result was captured via BLE hardware; eligible for
--                       cryptographic verification.
--      'manual' — result was entered manually; can never be
--                       hardware-verified; verification_hash remains NULL.
--
--   3. results.session_id TEXT (nullable)
--      Allows grouping results by combine wave/session.
--      The generate-verified-export function accepts session_id as an
--      alternative to athlete_id for bulk session exports.
--
--   4. capture_telemetry.clock_offset_ms REAL (nullable)
--      The BLE inter-device clock offset at capture time (ms, signed).
--      Sourced from ClockSyncEngine.currentOffsetNs() / 1_000_000.
--      Embedded in the verification hash payload — attests to the sync
--      quality of the BLE timing chain.
--
--   5. capture_telemetry.rtt_ms REAL (nullable)
--      The round-trip time of the last successful clock sync exchange (ms).
--      Sourced from ClockSyncInfo.rttNs / 1_000_000.
--      Also embedded in the verification hash payload.
--
--   6. submit_result_secure v6 — adds p_source_type and p_session_id params.
--      Existing callers without the new params get 'manual' / NULL.
--
--   7. upsert_capture_telemetry_lww v2 — adds p_clock_offset_ms and p_rtt_ms.
--      Existing callers default to NULL for both.
--
--   8. Performance indexes for the verification export query pattern.
--
-- IDEMPOTENCY: Safe to run multiple times (IF NOT EXISTS / CREATE OR REPLACE).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. results — new columns
-- ---------------------------------------------------------------------------

ALTER TABLE results ADD COLUMN IF NOT EXISTS verification_hash TEXT;
ALTER TABLE results ADD COLUMN IF NOT EXISTS source_type       TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE results ADD COLUMN IF NOT EXISTS session_id        TEXT;

-- Check constraint: only valid source types
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'results' AND constraint_name = 'results_source_type_check'
    ) THEN
        ALTER TABLE results
          ADD CONSTRAINT results_source_type_check
          CHECK (source_type IN ('live_ble', 'manual'));
    END IF;
END $$;

-- Back-fill source_type for existing rows:
-- If a result has a matching capture_telemetry row, it was hardware-captured.
UPDATE results r
SET    source_type = 'live_ble'
WHERE  source_type = 'manual'
  AND  EXISTS (
      SELECT 1 FROM capture_telemetry ct WHERE ct.result_id = r.id
  );

-- Index: export function queries by (athlete_id, source_type) and (session_id)
CREATE INDEX IF NOT EXISTS idx_results_athlete_source
    ON results (athlete_id, source_type);

CREATE INDEX IF NOT EXISTS idx_results_session_id
    ON results (session_id)
    WHERE session_id IS NOT NULL;

-- Index: verification hash presence check (find unverified live_ble rows)
CREATE INDEX IF NOT EXISTS idx_results_unverified_ble
    ON results (athlete_id, drill_type)
    WHERE source_type = 'live_ble' AND verification_hash IS NULL;

-- ---------------------------------------------------------------------------
-- 2. capture_telemetry — clock sync quality columns
-- ---------------------------------------------------------------------------

ALTER TABLE capture_telemetry ADD COLUMN IF NOT EXISTS clock_offset_ms REAL;
ALTER TABLE capture_telemetry ADD COLUMN IF NOT EXISTS rtt_ms          REAL;

-- ---------------------------------------------------------------------------
-- 3. submit_result_secure v6
--
-- Adds p_source_type TEXT and p_session_id TEXT parameters.
-- All v4/v5 behaviour is preserved exactly — zero breaking changes for
-- existing callers (both new params have defaults).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submit_result_secure(
    p_client_result_id UUID,
    p_event_id         UUID,
    p_athlete_id       UUID,
    p_band_id          TEXT,
    p_station_id       TEXT,
    p_drill_type       TEXT,
    p_value_num        NUMERIC,
    p_attempt_number   INT     DEFAULT 1,
    p_meta             JSONB   DEFAULT '{}'::jsonb,
    p_device_timestamp BIGINT  DEFAULT 0,
    p_source_type      TEXT    DEFAULT 'manual',
    p_session_id       TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result_id         UUID;
    v_hlc               TEXT;
    v_validation_status TEXT;
    v_suspicious        RECORD;
BEGIN
    -- Gate 0: Authentication
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized', 'code', 'UNAUTHORIZED');
    END IF;

    -- Gate 1: Idempotency (add-biased LWW)
    SELECT id INTO v_result_id
    FROM results
    WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    END IF;

    -- Gate 2: Suspicious duplicate detection (attempt_number = 1 only)
    IF p_attempt_number <= 1 THEN
        SELECT
            id,
            client_result_id  AS existing_client_id,
            value_num         AS existing_value,
            recorded_at       AS existing_recorded_at,
            attempt_number    AS existing_attempt_number
        INTO v_suspicious
        FROM results
        WHERE athlete_id  = p_athlete_id
          AND drill_type  = p_drill_type
          AND recorded_at > now() - interval '120 seconds'
          AND (voided IS NULL OR voided = false)
          AND ABS(value_num - p_value_num) <= (p_value_num * 0.10)
        ORDER BY recorded_at DESC
        LIMIT 1;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success',              false,
                'status',               'suspicious_duplicate',
                'code',                 'SUSPICIOUS_DUPLICATE',
                'existing_result_id',   v_suspicious.id,
                'existing_value',       v_suspicious.existing_value,
                'existing_recorded_at', v_suspicious.existing_recorded_at,
                'existing_attempt_num', v_suspicious.existing_attempt_number,
                'new_value',            p_value_num,
                'athlete_id',           p_athlete_id,
                'drill_type',           p_drill_type
            );
        END IF;
    END IF;

    -- Write phase
    v_hlc := p_meta->>'hlc_timestamp';

    v_validation_status := CASE
        WHEN (p_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id, event_id, athlete_id, band_id, station_id,
        drill_type, value_num, attempt_number, meta, hlc_timestamp,
        validation_status, device_timestamp, source_type, session_id, recorded_by
    )
    VALUES (
        p_client_result_id, p_event_id, p_athlete_id, p_band_id, p_station_id,
        p_drill_type, p_value_num, p_attempt_number, p_meta, v_hlc,
        v_validation_status, p_device_timestamp, p_source_type, p_session_id, auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_result_id FROM results WHERE client_result_id = p_client_result_id;
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'submit_result_secure error: athlete=% drill=% error=%',
                  p_athlete_id, p_drill_type, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.', 'code', 'INTERNAL_ERROR');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. upsert_capture_telemetry_lww v2 — adds clock sync quality params
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_capture_telemetry_lww(
    p_client_telemetry_id  UUID,
    p_event_id             UUID,
    p_result_id            UUID,
    p_station_id           TEXT,
    p_athlete_id           UUID,
    p_drill_type           TEXT,
    p_device_timestamp     BIGINT,
    p_device_id            TEXT,
    p_device_label         TEXT,
    p_captured_at          TIMESTAMPTZ,
    p_capture_duration_ms  INTEGER,
    p_ble_rssi             INTEGER,
    p_ble_phy              TEXT,
    p_validation_status    TEXT,
    p_was_offline          BOOLEAN,
    p_sync_latency_ms      INTEGER,
    p_meta                 JSONB    DEFAULT '{}',
    p_clock_offset_ms      REAL     DEFAULT NULL,
    p_rtt_ms               REAL     DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_winning_ts BIGINT;
BEGIN
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Gate 1: idempotency
    IF EXISTS (
        SELECT 1 FROM capture_telemetry WHERE client_telemetry_id = p_client_telemetry_id
    ) THEN
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'idempotent_duplicate');
    END IF;

    -- Gate 2: LWW conflict scan
    SELECT MAX(device_timestamp) INTO v_winning_ts
    FROM capture_telemetry
    WHERE event_id   = p_event_id
      AND athlete_id = p_athlete_id
      AND drill_type = p_drill_type
      AND ABS(device_timestamp - p_device_timestamp) <= 500;

    IF v_winning_ts IS NOT NULL AND v_winning_ts > p_device_timestamp THEN
        RETURN jsonb_build_object(
            'success', true, 'applied', false, 'reason', 'lww_rejected',
            'winning_device_timestamp', v_winning_ts
        );
    END IF;

    INSERT INTO capture_telemetry (
        client_telemetry_id, event_id, result_id, station_id, athlete_id,
        drill_type, device_timestamp, device_id, device_label, captured_at,
        capture_duration_ms, ble_rssi, ble_phy, validation_status,
        was_offline, sync_latency_ms, meta, clock_offset_ms, rtt_ms
    ) VALUES (
        p_client_telemetry_id, p_event_id, p_result_id, p_station_id, p_athlete_id,
        p_drill_type, p_device_timestamp, p_device_id, p_device_label, p_captured_at,
        p_capture_duration_ms, p_ble_rssi, p_ble_phy, p_validation_status,
        p_was_offline, p_sync_latency_ms, p_meta, p_clock_offset_ms, p_rtt_ms
    );

    RETURN jsonb_build_object('success', true, 'applied', true);

EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'race_duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'upsert_capture_telemetry_lww error: telemetry_id=% error=%',
                  p_client_telemetry_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. export_verified_results — read-only query function for the Edge Function
--
-- Called by generate-verified-export with the service role key.
-- Returns one row per non-voided result for the requested athlete or session,
-- with all capture_telemetry and result_provenance columns LEFT JOINed.
--
-- SECURITY DEFINER with search_path=public prevents schema injection.
-- The Edge Function validates the caller's JWT independently before calling this.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION export_verified_results(
    p_athlete_id UUID DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    result_id              UUID,
    client_result_id       UUID,
    athlete_id             UUID,
    event_id               UUID,
    band_id                TEXT,
    station_id             TEXT,
    drill_type             TEXT,
    value_num              NUMERIC,
    attempt_number         INT,
    validation_status      TEXT,
    hlc_timestamp          TEXT,
    device_timestamp       BIGINT,
    recorded_at            TIMESTAMPTZ,
    source_type            TEXT,
    verification_hash      TEXT,
    session_id             TEXT,
    meta                   JSONB,
    -- capture_telemetry
    ct_telemetry_id        UUID,
    ct_device_id           TEXT,
    ct_device_label        TEXT,
    ct_captured_at         TIMESTAMPTZ,
    ct_capture_duration_ms INTEGER,
    ct_ble_rssi            INTEGER,
    ct_ble_phy             TEXT,
    ct_was_offline         BOOLEAN,
    ct_sync_latency_ms     INTEGER,
    ct_clock_offset_ms     REAL,
    ct_rtt_ms              REAL,
    -- result_provenance
    prov_device_id         TEXT,
    prov_device_label      TEXT,
    prov_hlc_timestamp     TEXT,
    prov_was_offline       BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT
        r.id                        AS result_id,
        r.client_result_id,
        r.athlete_id,
        r.event_id,
        r.band_id,
        r.station_id,
        r.drill_type,
        r.value_num,
        r.attempt_number,
        r.validation_status,
        r.hlc_timestamp,
        r.device_timestamp,
        r.recorded_at,
        r.source_type,
        r.verification_hash,
        r.session_id,
        r.meta,
        -- capture_telemetry (LEFT JOIN — null for manual entries)
        ct.id                       AS ct_telemetry_id,
        ct.device_id                AS ct_device_id,
        ct.device_label             AS ct_device_label,
        ct.captured_at              AS ct_captured_at,
        ct.capture_duration_ms      AS ct_capture_duration_ms,
        ct.ble_rssi                 AS ct_ble_rssi,
        ct.ble_phy                  AS ct_ble_phy,
        ct.was_offline              AS ct_was_offline,
        ct.sync_latency_ms          AS ct_sync_latency_ms,
        ct.clock_offset_ms          AS ct_clock_offset_ms,
        ct.rtt_ms                   AS ct_rtt_ms,
        -- result_provenance (LEFT JOIN — null for manual entries)
        rp.device_id                AS prov_device_id,
        rp.device_label             AS prov_device_label,
        rp.hlc_timestamp            AS prov_hlc_timestamp,
        rp.was_offline              AS prov_was_offline
    FROM results r
    LEFT JOIN capture_telemetry ct ON ct.result_id = r.id
    LEFT JOIN result_provenance  rp ON rp.result_id  = r.id
    WHERE (r.voided IS NULL OR r.voided = FALSE)
      AND (p_athlete_id IS NULL OR r.athlete_id = p_athlete_id)
      AND (p_session_id IS NULL OR r.session_id = p_session_id)
    ORDER BY r.drill_type, r.attempt_number, r.device_timestamp;
$$;

GRANT EXECUTE ON FUNCTION export_verified_results TO authenticated;

COMMIT;
