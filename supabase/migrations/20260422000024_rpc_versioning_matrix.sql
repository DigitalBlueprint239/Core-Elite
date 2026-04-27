-- =============================================================================
-- MIGRATION 024 (supabase/): RPC Versioning Matrix — submit_result_secure
-- Core Elite Combine 2026 · Mission S
-- =============================================================================
--
-- PROBLEM STATEMENT:
--   submit_result_secure has accreted three signature changes in two quarters:
--     v1 (hardening_migration)  — 9 params
--     v5 (mig 018)              — +p_device_timestamp                      (10)
--     v6 (mig 019)              — +p_source_type, +p_session_id            (12)
--   Each change relied on DEFAULT-valued new params for backward compatibility,
--   which works for in-process upgrades but degrades at the edges:
--     • Offline-first tablets may hold outbox rows serialised under v1 shape
--       for hours or days before syncing.
--     • An accidental param rename in the future would silently drop data
--       (unmatched named-param RPC → function-does-not-exist → retry storm
--       → eventually marked failed in the local outbox → lost).
--     • We cannot evolve the wire format (e.g. switch to JSONB-first) without
--       breaking every client in the fleet simultaneously.
--
-- SOLUTION — Versioning Matrix:
--
--   1. Two concrete versioned implementations, both JSONB-in:
--        submit_result_secure_v1(p_payload JSONB)  — 9-field legacy shape
--        submit_result_secure_v2(p_payload JSONB)  — 12-field current shape
--      _v1 is a thin delegator to _v2 with defaults applied — there is only
--      ONE real implementation to audit, version labels serve as input-shape
--      contracts.
--
--   2. JSONB router:
--        submit_result_secure(p_payload JSONB)
--      Inspects the payload and dispatches:
--        • Explicit: `_v: 1` or `_v: 2` short-circuits the sniff.
--        • Sniff:    presence of source_type/session_id/device_timestamp → v2
--                    else → v1 (if required v1 keys are present).
--        • Fallback: missing required keys → write raw payload to
--                    failed_rpc_logs (DLQ). Never silently drop.
--
--   3. Named-param adapter (backward compatibility):
--        submit_result_secure(p_client_result_id UUID, ..., p_session_id TEXT)
--      Verbatim v6 signature. Packs its arguments into a JSONB and delegates
--      to the router. Every existing caller (useOfflineSync, powersync
--      connector) keeps working with zero code change.
--
--   4. failed_rpc_logs — append-only DLQ table.
--      Captures (raw_payload, rpc_name, reason, caller_role, created_at).
--      RLS: admin-read only, service-role write. Staff never see the table.
--
-- INVARIANTS PRESERVED:
--   • Every success path that worked before still works, byte-for-byte.
--   • Every failure path (UNAUTHORIZED, SUSPICIOUS_DUPLICATE, INTERNAL_ERROR)
--     returns the same JSONB shape callers already parse.
--   • Named-param callers get identical return objects.
--   • No results row schema change — only the RPC surface is versioned.
--
-- IDEMPOTENCY: Safe to re-run. Existing same-signature functions get
-- CREATE OR REPLACE'd; new overloads are add-only.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. failed_rpc_logs — Dead Letter Queue
-- ---------------------------------------------------------------------------
-- WHY a table and not RAISE LOG alone:
--   Postgres RAISE LOG lands in pg_log which is (a) not queryable from the app,
--   (b) rotated aggressively on Supabase, and (c) has no row-level ACL. A
--   real table gives admins a SQL-queryable audit surface that can be joined
--   to events/athletes for forensics, retention-policied like any other row,
--   and surfaced in AdminOps.

CREATE TABLE IF NOT EXISTS failed_rpc_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rpc_name        TEXT        NOT NULL,
    reason          TEXT        NOT NULL,          -- e.g. 'unknown_version', 'missing_required_keys'
    raw_payload     JSONB       NOT NULL,          -- the original JSONB sent by the client
    error_context   JSONB       NOT NULL DEFAULT '{}',
    caller_role     TEXT,                          -- auth.role() at time of call
    caller_uid      UUID,                          -- auth.uid()   at time of call
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Manual-review workflow fields. A future admin UI flips these.
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     UUID,
    resolution      TEXT                           -- e.g. 'replayed', 'discarded', 'client_fixed'
);

CREATE INDEX IF NOT EXISTS idx_failed_rpc_logs_rpc_name_created
    ON failed_rpc_logs (rpc_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_failed_rpc_logs_unreviewed
    ON failed_rpc_logs (created_at DESC)
    WHERE reviewed_at IS NULL;

ALTER TABLE failed_rpc_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin read failed_rpc_logs" ON failed_rpc_logs;
CREATE POLICY "Admin read failed_rpc_logs" ON failed_rpc_logs
    FOR SELECT TO authenticated
    USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

-- No INSERT policy — writes only happen via the SECURITY DEFINER router
-- below, which bypasses RLS on behalf of the calling user.

DROP POLICY IF EXISTS "Admin update failed_rpc_logs" ON failed_rpc_logs;
CREATE POLICY "Admin update failed_rpc_logs" ON failed_rpc_logs
    FOR UPDATE TO authenticated
    USING (
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    );

-- ---------------------------------------------------------------------------
-- 2. submit_result_secure_v2 — the real implementation
--
-- Lifts the v6 body from mig 019 verbatim and re-homes it under a versioned
-- name, with JSONB payload unpacking at the top. All gate logic, SQLERRM
-- handling, and return shapes are byte-for-byte identical.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submit_result_secure_v2(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- Unpacked fields — v2 contract
    v_client_result_id UUID;
    v_event_id         UUID;
    v_athlete_id       UUID;
    v_band_id          TEXT;
    v_station_id       TEXT;
    v_drill_type       TEXT;
    v_value_num        NUMERIC;
    v_attempt_number   INT;
    v_meta             JSONB;
    v_device_timestamp BIGINT;
    v_source_type      TEXT;
    v_session_id       TEXT;

    -- Working
    v_result_id         UUID;
    v_hlc               TEXT;
    v_validation_status TEXT;
    v_suspicious        RECORD;
BEGIN
    -- Unpack payload. JSONB ->> returns TEXT; we cast per column type.
    -- Null/missing keys become SQL NULL which then hit the DEFAULT handling below.
    v_client_result_id := (p_payload->>'client_result_id')::UUID;
    v_event_id         := (p_payload->>'event_id')::UUID;
    v_athlete_id       := (p_payload->>'athlete_id')::UUID;
    v_band_id          := p_payload->>'band_id';
    v_station_id       := p_payload->>'station_id';
    v_drill_type       := p_payload->>'drill_type';
    v_value_num        := (p_payload->>'value_num')::NUMERIC;
    v_attempt_number   := COALESCE((p_payload->>'attempt_number')::INT, 1);
    v_meta             := COALESCE(p_payload->'meta', '{}'::jsonb);
    v_device_timestamp := COALESCE((p_payload->>'device_timestamp')::BIGINT, 0);
    v_source_type      := COALESCE(p_payload->>'source_type', 'manual_staff');
    v_session_id       := p_payload->>'session_id';   -- may be NULL

    -- Gate 0: Authentication (same as v6)
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized', 'code', 'UNAUTHORIZED');
    END IF;

    -- Gate 1: Idempotency (add-biased LWW)
    SELECT id INTO v_result_id
    FROM   results
    WHERE  client_result_id = v_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    END IF;

    -- Gate 2: Suspicious duplicate detection (attempt_number = 1 only)
    IF v_attempt_number <= 1 THEN
        SELECT
            id,
            client_result_id  AS existing_client_id,
            value_num         AS existing_value,
            recorded_at       AS existing_recorded_at,
            attempt_number    AS existing_attempt_number
        INTO v_suspicious
        FROM   results
        WHERE  athlete_id  = v_athlete_id
          AND  drill_type  = v_drill_type
          AND  recorded_at > now() - interval '120 seconds'
          AND  (voided IS NULL OR voided = false)
          AND  ABS(value_num - v_value_num) <= (v_value_num * 0.10)
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
                'new_value',            v_value_num,
                'athlete_id',           v_athlete_id,
                'drill_type',           v_drill_type
            );
        END IF;
    END IF;

    -- Write phase
    v_hlc := v_meta->>'hlc_timestamp';

    v_validation_status := CASE
        WHEN (v_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id, event_id, athlete_id, band_id, station_id,
        drill_type, value_num, attempt_number, meta, hlc_timestamp,
        validation_status, device_timestamp, source_type, session_id, recorded_by
    )
    VALUES (
        v_client_result_id, v_event_id, v_athlete_id, v_band_id, v_station_id,
        v_drill_type, v_value_num, v_attempt_number, v_meta, v_hlc,
        v_validation_status, v_device_timestamp, v_source_type, v_session_id, auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_result_id FROM results WHERE client_result_id = v_client_result_id;
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'submit_result_secure_v2 error: athlete=% drill=% error=%',
                  v_athlete_id, v_drill_type, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.', 'code', 'INTERNAL_ERROR');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. submit_result_secure_v1 — legacy 9-field shape delegator
--
-- v1's contract had no device_timestamp / source_type / session_id. A v1
-- payload is just a subset of v2's. We strip any v2-only keys the caller
-- might accidentally include (defensive) and forward to _v2 which applies
-- its own defaults for the missing fields.
--
-- WHY a separate function and not a flag to _v2:
--   • Auditability — an ops engineer reading pg_stat_user_functions can see
--     how much v1-shape traffic is still flowing before we retire v1.
--   • Input-shape contract — _v1 can enforce "no v2 keys allowed" if we
--     ever need to tighten the rule to detect misconfigured clients.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submit_result_secure_v1(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_v1_payload JSONB;
BEGIN
    -- Keep only the v1-contract keys. Defaults for device_timestamp / source_type /
    -- session_id will be applied by _v2 when those keys are absent.
    v_v1_payload := jsonb_build_object(
        'client_result_id', p_payload->>'client_result_id',
        'event_id',         p_payload->>'event_id',
        'athlete_id',       p_payload->>'athlete_id',
        'band_id',          p_payload->>'band_id',
        'station_id',       p_payload->>'station_id',
        'drill_type',       p_payload->>'drill_type',
        'value_num',        p_payload->'value_num',     -- preserve numeric type via ->
        'attempt_number',   p_payload->'attempt_number',
        'meta',             COALESCE(p_payload->'meta', '{}'::jsonb)
    );

    RETURN submit_result_secure_v2(v_v1_payload);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. submit_result_secure(p_payload JSONB) — the router
--
-- Dispatch logic:
--
--   a. Explicit version pin:  p_payload->>'_v' IN ('1','2')
--      Clients that want deterministic routing set _v themselves. This is
--      the preferred path for any new client code.
--
--   b. Sniff:  presence of device_timestamp / source_type / session_id → v2.
--             else → v1 if required v1 keys are all present.
--
--   c. DLQ:   missing required keys, or unknown explicit _v → write the raw
--             payload to failed_rpc_logs and return a structured error.
--             We DO NOT throw — the router always returns a JSONB that
--             matches the normal success/error shape so clients don't have
--             to special-case HTTP vs function errors.
--
-- DLQ is written under the function's SECURITY DEFINER privileges, which
-- bypasses RLS (profiles must still allow SELECT for admin readers).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submit_result_secure(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_explicit   TEXT;
    v_required   TEXT[] := ARRAY[
        'client_result_id','event_id','athlete_id','band_id',
        'station_id','drill_type','value_num'
    ];
    v_missing    TEXT[];
    v_key        TEXT;
    v_has_v2_marker BOOLEAN;
    v_routed_to     TEXT;
BEGIN
    IF p_payload IS NULL OR jsonb_typeof(p_payload) != 'object' THEN
        INSERT INTO failed_rpc_logs (rpc_name, reason, raw_payload, error_context, caller_role, caller_uid)
        VALUES (
            'submit_result_secure',
            'invalid_payload_type',
            COALESCE(p_payload, 'null'::jsonb),
            jsonb_build_object('expected', 'jsonb object', 'received_type', jsonb_typeof(p_payload)),
            auth.role(),
            auth.uid()
        );
        RETURN jsonb_build_object(
            'success', false,
            'code',    'INVALID_PAYLOAD',
            'error',   'Payload must be a JSON object.'
        );
    END IF;

    -- Required-keys gate (both v1 and v2 need all seven)
    v_missing := ARRAY[]::TEXT[];
    FOREACH v_key IN ARRAY v_required LOOP
        IF NOT (p_payload ? v_key) OR p_payload->>v_key IS NULL THEN
            v_missing := array_append(v_missing, v_key);
        END IF;
    END LOOP;

    IF array_length(v_missing, 1) > 0 THEN
        INSERT INTO failed_rpc_logs (rpc_name, reason, raw_payload, error_context, caller_role, caller_uid)
        VALUES (
            'submit_result_secure',
            'missing_required_keys',
            p_payload,
            jsonb_build_object('missing_keys', to_jsonb(v_missing)),
            auth.role(),
            auth.uid()
        );
        RETURN jsonb_build_object(
            'success', false,
            'code',    'MISSING_REQUIRED_KEYS',
            'error',   'Payload is missing required fields.',
            'missing', to_jsonb(v_missing)
        );
    END IF;

    -- (a) Explicit version pin
    v_explicit := p_payload->>'_v';
    IF v_explicit IS NOT NULL THEN
        IF v_explicit = '1' THEN
            RETURN submit_result_secure_v1(p_payload);
        ELSIF v_explicit = '2' THEN
            RETURN submit_result_secure_v2(p_payload);
        ELSE
            INSERT INTO failed_rpc_logs (rpc_name, reason, raw_payload, error_context, caller_role, caller_uid)
            VALUES (
                'submit_result_secure',
                'unknown_version',
                p_payload,
                jsonb_build_object('requested_version', v_explicit, 'known_versions', to_jsonb(ARRAY['1','2'])),
                auth.role(),
                auth.uid()
            );
            RETURN jsonb_build_object(
                'success',       false,
                'code',          'UNKNOWN_VERSION',
                'error',         'Requested RPC version is not supported.',
                'known_versions', to_jsonb(ARRAY['1','2'])
            );
        END IF;
    END IF;

    -- (b) Sniff — any v2-only marker present promotes to v2
    v_has_v2_marker := (p_payload ? 'device_timestamp')
                    OR (p_payload ? 'source_type')
                    OR (p_payload ? 'session_id');

    IF v_has_v2_marker THEN
        v_routed_to := 'v2';
        RETURN submit_result_secure_v2(p_payload);
    ELSE
        v_routed_to := 'v1';
        RETURN submit_result_secure_v1(p_payload);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Named-param adapter — backward compatibility for existing callers
--
-- Signature is the v6 signature byte-for-byte. Every current caller
-- (src/hooks/useOfflineSync.ts, packages/powersync/src/connector.ts) uses
-- named-param invocation, which binds to this overload. We pack the args
-- into a JSONB and route through submit_result_secure(JSONB) so the router
-- is the single source of truth for dispatch rules.
--
-- WHY we don't just DROP the named-param form and force JSONB:
--   useOfflineSync has offline-queued retries that may resume from a prior
--   process boot. Changing the call shape would strand those retries. The
--   adapter is cheap (one jsonb_build_object + one function call) and buys
--   zero-downtime migration. We can delete it in a future migration once
--   all callers have switched to JSONB and no outbox rows remain.
-- ---------------------------------------------------------------------------

-- Drop all existing named-param overloads first (the current v6 body is
-- being replaced by this thin adapter).
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure::text AS sig
        FROM   pg_proc      p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'public'
          AND  p.proname = 'submit_result_secure'
          -- Keep the new JSONB overload we just created above.
          AND  pg_get_function_identity_arguments(p.oid) != 'p_payload jsonb'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END $$;

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
    p_source_type      TEXT    DEFAULT 'manual_staff',
    p_session_id       TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_payload JSONB;
BEGIN
    v_payload := jsonb_build_object(
        'client_result_id', p_client_result_id,
        'event_id',         p_event_id,
        'athlete_id',       p_athlete_id,
        'band_id',          p_band_id,
        'station_id',       p_station_id,
        'drill_type',       p_drill_type,
        'value_num',        p_value_num,
        'attempt_number',   p_attempt_number,
        'meta',             p_meta,
        'device_timestamp', p_device_timestamp,
        'source_type',      p_source_type,
        'session_id',       p_session_id,
        -- Named-param callers always carry the full v2 contract, so we
        -- pin explicitly — no sniff ambiguity.
        '_v',               '2'
    );

    RETURN submit_result_secure(v_payload);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. EXECUTE grants
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION submit_result_secure_v1(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_result_secure_v2(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_result_secure(JSONB)    FROM PUBLIC;

-- The versioned concrete functions are internal — only the router should
-- invoke them. authenticated callers go through submit_result_secure.
GRANT  EXECUTE ON FUNCTION submit_result_secure(JSONB)    TO authenticated;
GRANT  EXECUTE ON FUNCTION submit_result_secure(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INT, JSONB, BIGINT, TEXT, TEXT
)                                                           TO authenticated;

COMMIT;
