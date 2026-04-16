-- =============================================================================
-- Migration 017: HLC-ordered device_status writes
-- Core Elite Combine 2026
-- =============================================================================
--
-- Problem:
--   The device_status table has no hlc_timestamp column. The direct
--   .upsert() path in StationMode.tsx and the outbox sync path in
--   useOfflineSync.ts both overwrite unconditionally — a stale heartbeat
--   queued during an offline period can arrive after a fresher one and
--   silently corrupt the displayed device status.
--
-- Concrete failure sequence:
--   t=100  Device A goes offline. Heartbeat queued (HLC: ...100_0...).
--   t=200  Device A reconnects. Online heartbeat fires → server row shows t=200.
--   t=201  Outbox drains → stale t=100 heartbeat arrives via sync.
--          Without HLC guard: server row is overwritten with t=100 status. BAD.
--          With HLC guard:    RPC detects incoming HLC < existing → NO-OP. CORRECT.
--
-- Solution:
--   1. Add hlc_timestamp TEXT to device_status.
--   2. Create upsert_device_status_hlc() RPC that enforces LWW ordering:
--      only write if incoming HLC > current HLC (strict inequality —
--      mutable records use strict > so ties keep the existing state stable).
--
-- References: v2 §3.1.2 (deviceStatusShouldUpdate), lww.ts (strict >)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add hlc_timestamp column to device_status
-- ---------------------------------------------------------------------------

ALTER TABLE device_status ADD COLUMN IF NOT EXISTS hlc_timestamp TEXT;

-- Index for monitoring queries ("which devices have the freshest status?")
CREATE INDEX IF NOT EXISTS idx_device_status_hlc
    ON device_status (hlc_timestamp);

-- ---------------------------------------------------------------------------
-- 2. upsert_device_status_hlc — HLC-guarded device heartbeat write
--
-- Called by:
--   - StationMode.tsx online heartbeat path (replaces direct .upsert())
--   - useOfflineSync.ts device_status sync branch (replaces direct .upsert())
--
-- LWW rule (mutable record, strict >):
--   incoming HLC > existing HLC  → UPDATE proceeds
--   incoming HLC <= existing HLC → NO-OP (return success, caller drains outbox)
--
-- Returns:
--   { success: true,  applied: true  }  — row was written
--   { success: true,  applied: false }  — stale write rejected by HLC guard
--   { success: false, error: '...' }    — unexpected error
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION upsert_device_status_hlc(
    p_event_id          UUID,
    p_station_id        TEXT,
    p_device_label      TEXT,
    p_last_seen_at      TIMESTAMPTZ,
    p_is_online         BOOLEAN,
    p_pending_count     INT     DEFAULT 0,
    p_last_sync_at      TIMESTAMPTZ DEFAULT NULL,
    p_hlc_timestamp     TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_existing_hlc TEXT;
BEGIN
    -- Read the existing HLC for this device row (if any).
    SELECT hlc_timestamp
    INTO   v_existing_hlc
    FROM   device_status
    WHERE  event_id    = p_event_id
      AND  station_id  = p_station_id
      AND  device_label = p_device_label;

    -- LWW guard: if an existing row has a higher HLC than the incoming write,
    -- the incoming write is stale — reject it silently.
    --
    -- Cases:
    --   No existing row          → always write (first write wins by default)
    --   Existing HLC is NULL     → incoming write wins (schema migration applied
    --                               to an existing row that predates this migration)
    --   incoming HLC is NULL     → write unconditionally (caller did not supply HLC;
    --                               acceptable for the online fast-path before this
    --                               migration is fully wired — downgrade gracefully)
    --   incoming > existing      → write (newer data)
    --   incoming = existing      → NO-OP (ties keep existing — strict > for mutable)
    --   incoming < existing      → NO-OP (stale write rejected)
    IF NOT FOUND
       OR v_existing_hlc IS NULL
       OR p_hlc_timestamp IS NULL
       OR p_hlc_timestamp > v_existing_hlc
    THEN
        INSERT INTO device_status (
            event_id, station_id, device_label,
            last_seen_at, is_online,
            pending_queue_count, last_sync_at,
            hlc_timestamp
        )
        VALUES (
            p_event_id, p_station_id, p_device_label,
            p_last_seen_at, p_is_online,
            p_pending_count, p_last_sync_at,
            p_hlc_timestamp
        )
        ON CONFLICT (event_id, station_id, device_label)
        DO UPDATE SET
            last_seen_at        = EXCLUDED.last_seen_at,
            is_online           = EXCLUDED.is_online,
            pending_queue_count = EXCLUDED.pending_queue_count,
            last_sync_at        = EXCLUDED.last_sync_at,
            hlc_timestamp       = EXCLUDED.hlc_timestamp;

        RETURN jsonb_build_object('success', true, 'applied', true);
    END IF;

    -- Stale write — HLC guard rejected it. Return success so the caller
    -- removes the item from the outbox. The server already has fresher data;
    -- keeping the stale item would cause it to retry forever.
    RETURN jsonb_build_object('success', true, 'applied', false);

EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'upsert_device_status_hlc error: station=% device=% error=%',
              p_station_id, p_device_label, SQLERRM;
    RETURN jsonb_build_object(
        'success', false,
        'error',   'An unexpected error occurred.',
        'code',    'INTERNAL_ERROR'
    );
END;
$$;
