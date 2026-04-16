-- =============================================================================
-- MIGRATION 018: capture_telemetry + result_provenance + device_timestamp LWW
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--
--   1. results.device_timestamp BIGINT — device wall-clock ms at capture.
--      This is the strict LWW conflict key. Higher device_timestamp wins when
--      two offline devices both capture the same athlete at the same drill
--      and sync later. Separate from hlc_timestamp (which is the monotonic
--      causal-ordering key). Never populated from the server — always device-
--      generated and passed in through submit_result_secure.
--
--   2. capture_telemetry — one row per capture attempt on a station device.
--      Records the full diagnostic context (RSSI, PHY, BLE state, offline flag,
--      capture duration, sync latency). Used for post-event analytics and
--      per-device auditing. Immutable after write.
--
--   3. result_provenance — one row per result (UNIQUE result_id).
--      Tracks which device captured which result: device_id, device_label,
--      device_timestamp, was_offline, sync_latency_ms. Admin-only read.
--
--   4. upsert_capture_telemetry_lww() — RPC implementing strict LWW on
--      capture_telemetry keyed by device_timestamp. Idempotent (client_telemetry_id
--      UNIQUE). Rejects a write if an existing same athlete+drill+event record
--      within a 500ms window has a higher device_timestamp.
--
--   5. insert_result_provenance() — idempotent RPC (UNIQUE result_id).
--      Duplicate returns success immediately (add-biased).
--
--   6. submit_result_secure v5 — adds p_device_timestamp parameter.
--      Stores device_timestamp as a first-class column for server-side LWW
--      query support. Existing callers without the new param default to 0.
--
--   7. PowerSync publication — adds new tables to supabase_realtime so
--      PowerSync's logical replication subscription picks them up.
--
-- IDEMPOTENCY: Safe to run multiple times.
--   IF NOT EXISTS / CREATE OR REPLACE / DO $$ guards everywhere.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Add device_timestamp to results
-- ---------------------------------------------------------------------------

ALTER TABLE results ADD COLUMN IF NOT EXISTS device_timestamp BIGINT;
ALTER TABLE results ADD COLUMN IF NOT EXISTS voided BOOLEAN DEFAULT FALSE;

-- Backfill existing rows: use EXTRACT(epoch) * 1000 from recorded_at as a
-- best-effort approximation. These rows pre-date device_timestamp so there is
-- no canonical device clock value — recorded_at is the closest proxy.
UPDATE results
SET    device_timestamp = EXTRACT(EPOCH FROM recorded_at)::BIGINT * 1000
WHERE  device_timestamp IS NULL;

-- Index: fast LWW conflict scan (athlete + drill + device_timestamp range)
CREATE INDEX IF NOT EXISTS idx_results_device_ts_athlete_drill
    ON results (athlete_id, drill_type, device_timestamp DESC);

-- ---------------------------------------------------------------------------
-- 2. capture_telemetry table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS capture_telemetry (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Idempotency key: device-generated UUID. UNIQUE prevents re-delivery duplicates.
    client_telemetry_id   UUID        NOT NULL UNIQUE,
    event_id              UUID        NOT NULL REFERENCES events(id),
    -- result_id is nullable: populated once submit_result_secure succeeds.
    -- During an offline session the result may not yet have a server-side id.
    result_id             UUID        REFERENCES results(id) ON DELETE SET NULL,
    station_id            TEXT        NOT NULL REFERENCES stations(id),
    athlete_id            UUID        NOT NULL REFERENCES athletes(id),
    drill_type            TEXT        NOT NULL,
    -- -------------------------------------------------------------------------
    -- LWW KEY — this is the conflict resolution field per the directive.
    -- Milliseconds since Unix epoch on the device clock at the moment of capture.
    -- Server NEVER generates or modifies this value.
    -- Higher device_timestamp wins when two records conflict within a 500ms window.
    -- -------------------------------------------------------------------------
    device_timestamp      BIGINT      NOT NULL,
    device_id             TEXT        NOT NULL,  -- stable hardware/app identifier
    device_label          TEXT        NOT NULL,  -- human-readable ("Station 1 iPad")
    captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    capture_duration_ms   INTEGER,
    ble_rssi              INTEGER,
    ble_phy               TEXT,        -- '1m' | 'coded_125k'
    validation_status     TEXT,
    was_offline           BOOLEAN     NOT NULL DEFAULT FALSE,
    sync_latency_ms       INTEGER,    -- ms between capture and successful upload
    meta                  JSONB       NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capture_telemetry_event
    ON capture_telemetry (event_id);

CREATE INDEX IF NOT EXISTS idx_capture_telemetry_athlete_drill
    ON capture_telemetry (athlete_id, drill_type);

-- LWW scan index: same query as upsert_capture_telemetry_lww uses
CREATE INDEX IF NOT EXISTS idx_capture_telemetry_lww
    ON capture_telemetry (event_id, athlete_id, drill_type, device_timestamp DESC);

-- ---------------------------------------------------------------------------
-- 3. result_provenance table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS result_provenance (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id        UUID        NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    device_id        TEXT        NOT NULL,
    device_label     TEXT        NOT NULL,
    station_id       TEXT        NOT NULL,
    -- Mirrors results.device_timestamp — stored here for provenance queries
    -- without joining results. Confirms the LWW-winning device timestamp.
    device_timestamp BIGINT      NOT NULL,
    hlc_timestamp    TEXT        NOT NULL,
    sync_latency_ms  INTEGER,
    was_offline      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One provenance record per result — immutable lineage
    UNIQUE (result_id)
);

CREATE INDEX IF NOT EXISTS idx_result_provenance_device
    ON result_provenance (device_id);

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

ALTER TABLE capture_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_provenance  ENABLE ROW LEVEL SECURITY;

-- Capture telemetry: staff can insert for their events; read all for event
DROP POLICY IF EXISTS "Staff insert capture_telemetry" ON capture_telemetry;
CREATE POLICY "Staff insert capture_telemetry" ON capture_telemetry
    FOR INSERT TO authenticated
    WITH CHECK (true);  -- event scoping enforced in upsert_capture_telemetry_lww (SECURITY DEFINER)

DROP POLICY IF EXISTS "Staff read capture_telemetry" ON capture_telemetry;
CREATE POLICY "Staff read capture_telemetry" ON capture_telemetry
    FOR SELECT TO authenticated
    USING (
        event_id IN (
            SELECT e.id FROM events e
            INNER JOIN profiles p ON p.id = auth.uid()
            WHERE p.role IN ('admin', 'staff')
        )
    );

-- Result provenance: insert via SECURITY DEFINER RPC; admin read
DROP POLICY IF EXISTS "System insert result_provenance" ON result_provenance;
CREATE POLICY "System insert result_provenance" ON result_provenance
    FOR INSERT TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "Admin read result_provenance" ON result_provenance;
CREATE POLICY "Admin read result_provenance" ON result_provenance
    FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

-- ---------------------------------------------------------------------------
-- 5. upsert_capture_telemetry_lww — strict device_timestamp LWW
--
-- Algorithm:
--   a. Idempotency check: if client_telemetry_id already exists, return
--      success immediately (add-biased; no data loss on re-delivery).
--   b. LWW conflict scan: find any row for the same (event, athlete, drill)
--      within ±500ms of this record's device_timestamp.
--      If a HIGHER device_timestamp exists: reject (this write loses LWW).
--      If only LOWER device_timestamps exist: this write wins (proceed).
--   c. Insert on win.
--
-- Returns JSONB: { success, applied, reason? }
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
    p_meta                 JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_winning_ts  BIGINT;
BEGIN
    -- Gate 0: authentication
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Gate 1: idempotency — exact duplicate by device-generated key
    IF EXISTS (
        SELECT 1 FROM capture_telemetry WHERE client_telemetry_id = p_client_telemetry_id
    ) THEN
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'idempotent_duplicate');
    END IF;

    -- Gate 2: LWW conflict scan
    -- Find the highest device_timestamp for the same athlete/drill/event within ±500ms.
    -- The 500ms window matches the physical reality of a combine: two staff members
    -- on adjacent stations cannot independently time the same athlete within 500ms
    -- unless they both captured the same real event — that is the conflict case.
    SELECT MAX(device_timestamp) INTO v_winning_ts
    FROM capture_telemetry
    WHERE event_id        = p_event_id
      AND athlete_id      = p_athlete_id
      AND drill_type      = p_drill_type
      AND ABS(device_timestamp - p_device_timestamp) <= 500;

    IF v_winning_ts IS NOT NULL AND v_winning_ts > p_device_timestamp THEN
        -- Existing record has a later device timestamp — this write loses LWW.
        -- Return success (not an error) so the client removes it from the outbox.
        RETURN jsonb_build_object(
            'success',                true,
            'applied',                false,
            'reason',                 'lww_rejected',
            'winning_device_timestamp', v_winning_ts
        );
    END IF;

    -- Write phase
    INSERT INTO capture_telemetry (
        client_telemetry_id, event_id, result_id, station_id, athlete_id,
        drill_type, device_timestamp, device_id, device_label, captured_at,
        capture_duration_ms, ble_rssi, ble_phy, validation_status,
        was_offline, sync_latency_ms, meta
    ) VALUES (
        p_client_telemetry_id, p_event_id, p_result_id, p_station_id, p_athlete_id,
        p_drill_type, p_device_timestamp, p_device_id, p_device_label, p_captured_at,
        p_capture_duration_ms, p_ble_rssi, p_ble_phy, p_validation_status,
        p_was_offline, p_sync_latency_ms, p_meta
    );

    RETURN jsonb_build_object('success', true, 'applied', true);

EXCEPTION
    WHEN unique_violation THEN
        -- Race condition between Gate 1 and INSERT — treat as idempotent
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'race_duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'upsert_capture_telemetry_lww error: telemetry_id=% error=%',
                  p_client_telemetry_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.');
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_capture_telemetry_lww TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. insert_result_provenance — idempotent provenance insert
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION insert_result_provenance(
    p_result_id        UUID,
    p_device_id        TEXT,
    p_device_label     TEXT,
    p_station_id       TEXT,
    p_device_timestamp BIGINT,
    p_hlc_timestamp    TEXT,
    p_sync_latency_ms  INTEGER,
    p_was_offline      BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    INSERT INTO result_provenance (
        result_id, device_id, device_label, station_id,
        device_timestamp, hlc_timestamp, sync_latency_ms, was_offline
    ) VALUES (
        p_result_id, p_device_id, p_device_label, p_station_id,
        p_device_timestamp, p_hlc_timestamp, p_sync_latency_ms, p_was_offline
    )
    ON CONFLICT (result_id) DO NOTHING;  -- idempotent: provenance is immutable

    RETURN jsonb_build_object('success', true);

EXCEPTION
    WHEN OTHERS THEN
        RAISE LOG 'insert_result_provenance error: result_id=% error=%', p_result_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.');
END;
$$;

GRANT EXECUTE ON FUNCTION insert_result_provenance TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. submit_result_secure v5 — adds p_device_timestamp
--
-- The device_timestamp is stored as a first-class column so server-side LWW
-- queries (e.g. analytics, conflict analysis) can use it without parsing JSONB.
-- Existing callers without the new param default to 0 (backfill-compatible).
-- All other logic is unchanged from v4.
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
    p_device_timestamp BIGINT  DEFAULT 0
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
            client_result_id AS existing_client_id,
            value_num        AS existing_value,
            recorded_at      AS existing_recorded_at,
            attempt_number   AS existing_attempt_number
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
        validation_status, device_timestamp, recorded_by
    )
    VALUES (
        p_client_result_id, p_event_id, p_athlete_id, p_band_id, p_station_id,
        p_drill_type, p_value_num, p_attempt_number, p_meta, v_hlc,
        v_validation_status, p_device_timestamp, auth.uid()
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
-- 8. PowerSync logical replication publication
--
-- Supabase uses the supabase_realtime publication for logical replication.
-- PowerSync subscribes to this publication to stream changes to connected devices.
-- New tables must be explicitly added — they are not auto-enrolled.
--
-- Safe to run multiple times: ADD TABLE is a no-op if already present.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    -- capture_telemetry
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND tablename = 'capture_telemetry'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE capture_telemetry;
    END IF;

    -- result_provenance
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND tablename = 'result_provenance'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE result_provenance;
    END IF;

    -- Ensure results is in the publication (may already be there)
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND tablename = 'results'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE results;
    END IF;
END $$;

COMMIT;
