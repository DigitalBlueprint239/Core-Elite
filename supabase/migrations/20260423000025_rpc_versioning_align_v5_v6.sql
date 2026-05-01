-- =============================================================================
-- MIGRATION 025 (supabase/): RPC Versioning Matrix — align to v5/v6 namespace
-- Core Elite Combine 2026 · Mission S (continuation)
-- =============================================================================
--
-- WHY this exists:
--   Mig 024 introduced the versioning matrix using *semantic* names — _v1
--   (legacy 9-field shape) and _v2 (current 12-field shape). Useful while
--   designing the router, but the audit-mandated convention is to mirror
--   the actual signature evolution count so an engineer reading pg_proc
--   can correlate function-name → originating migration.
--
-- HISTORICAL SIGNATURE LADDER (named-param form):
--   v1  hardening_migration.sql       — 9 params, no telemetry, no attempt_num
--   v2  mig 008                       — +p_attempt_number                (10)
--   v3  mig 015                       — composite-uniqueness body change (10, sig stable)
--   v4  (skipped — body-only)         — covering-index work
--   v5  mig 015 final operational     — pre-telemetry 9-field shape       (9)*
--   v6  mig 018 + 019 combined        — +device_timestamp/+source_type
--                                       /+session_id                       (12)
--
--   *NOTE: the previous mission collapsed v1..v5 into a single "v5"
--    contract because the only field-shape difference that survives in
--    long-lived offline outboxes is the absence of the v6-only telemetry
--    keys. Resurrecting v1..v4 bodies has zero benefit — those clients
--    were updated long ago and any payload routed by the explicit-pin
--    path with `_v: '1'..'4'` is a misconfiguration that belongs in the
--    DLQ for manual review.
--
-- WHAT this migration does:
--   1. Renames submit_result_secure_v2(JSONB) → submit_result_secure_v6(JSONB)
--   2. Renames submit_result_secure_v1(JSONB) → submit_result_secure_v5(JSONB)
--   3. Re-creates the JSONB router to dispatch on `_v: '5'|'6'` and the
--      same sniff rules as before (any v6-only marker promotes to v6).
--   4. Adds explicit DLQ paths for `_v: '1'|'2'|'3'|'4'` — these versions
--      have no concrete body any more; misconfigured callers get logged.
--   5. Updates the named-param adapter to pin `_v: '6'` (instead of '2').
--
-- WHAT this migration preserves:
--   • Every named-param caller (useOfflineSync, powersync connector,
--     AdminDiagnostics) keeps working byte-for-byte. They never reference
--     the internal `_v*` name — only the public router.
--   • The DLQ table (failed_rpc_logs) and its RLS policies are unchanged.
--   • Return shape JSONB matches mig 024 — { success, code, error, ... }.
--
-- IDEMPOTENCY: Re-runnable. ALTER FUNCTION ... RENAME TO is wrapped in a
-- DO block that checks current state before acting, so applying twice is
-- a no-op on the rename and a CREATE OR REPLACE on the router.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Rename internal versioned implementations
--
-- ALTER FUNCTION ... RENAME TO is non-idempotent — it errors if the source
-- name is already gone. We guard with pg_proc lookups so re-running this
-- migration after a successful first apply is a clean no-op.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'submit_result_secure_v2'
          AND pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb'
    ) THEN
        EXECUTE 'ALTER FUNCTION submit_result_secure_v2(JSONB) RENAME TO submit_result_secure_v6';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'submit_result_secure_v1'
          AND pg_get_function_identity_arguments(p.oid) = 'p_payload jsonb'
    ) THEN
        EXECUTE 'ALTER FUNCTION submit_result_secure_v1(JSONB) RENAME TO submit_result_secure_v5';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Re-create the JSONB router with v5/v6 dispatch
--
-- Dispatch rules (in order):
--   1. Validate JSONB type and required keys → DLQ on failure.
--   2. Explicit pin via `_v`:
--        '5' → submit_result_secure_v5
--        '6' → submit_result_secure_v6
--        '1','2','3','4' → DLQ as 'deprecated_version' (concrete body removed)
--        anything else  → DLQ as 'unknown_version'
--   3. Sniff: presence of any v6-only telemetry key promotes to v6, else v5.
--
-- Returns the same JSONB shape callers already parse — never throws.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submit_result_secure(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_explicit      TEXT;
    v_required      TEXT[] := ARRAY[
        'client_result_id','event_id','athlete_id','band_id',
        'station_id','drill_type','value_num'
    ];
    v_deprecated    TEXT[] := ARRAY['1','2','3','4'];
    v_known         TEXT[] := ARRAY['5','6'];
    v_missing       TEXT[];
    v_key           TEXT;
    v_has_v6_marker BOOLEAN;
BEGIN
    -- 1a. Type guard
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

    -- 1b. Required-key gate (every supported version needs all seven)
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

    -- 2. Explicit version pin
    v_explicit := p_payload->>'_v';
    IF v_explicit IS NOT NULL THEN
        IF v_explicit = '6' THEN
            RETURN submit_result_secure_v6(p_payload);
        ELSIF v_explicit = '5' THEN
            RETURN submit_result_secure_v5(p_payload);
        ELSIF v_explicit = ANY (v_deprecated) THEN
            INSERT INTO failed_rpc_logs (rpc_name, reason, raw_payload, error_context, caller_role, caller_uid)
            VALUES (
                'submit_result_secure',
                'deprecated_version',
                p_payload,
                jsonb_build_object(
                    'requested_version', v_explicit,
                    'note',              'v1..v4 bodies were retired; payload preserved for replay.',
                    'supported_versions', to_jsonb(v_known)
                ),
                auth.role(),
                auth.uid()
            );
            RETURN jsonb_build_object(
                'success',            false,
                'code',               'DEPRECATED_VERSION',
                'error',              'Requested RPC version has been retired.',
                'requested_version',  v_explicit,
                'supported_versions', to_jsonb(v_known)
            );
        ELSE
            INSERT INTO failed_rpc_logs (rpc_name, reason, raw_payload, error_context, caller_role, caller_uid)
            VALUES (
                'submit_result_secure',
                'unknown_version',
                p_payload,
                jsonb_build_object(
                    'requested_version', v_explicit,
                    'supported_versions', to_jsonb(v_known)
                ),
                auth.role(),
                auth.uid()
            );
            RETURN jsonb_build_object(
                'success',             false,
                'code',                'UNKNOWN_VERSION',
                'error',               'Requested RPC version is not supported.',
                'requested_version',   v_explicit,
                'supported_versions',  to_jsonb(v_known)
            );
        END IF;
    END IF;

    -- 3. Sniff — any v6-only telemetry key promotes to v6
    v_has_v6_marker := (p_payload ? 'device_timestamp')
                    OR (p_payload ? 'source_type')
                    OR (p_payload ? 'session_id');

    IF v_has_v6_marker THEN
        RETURN submit_result_secure_v6(p_payload);
    ELSE
        RETURN submit_result_secure_v5(p_payload);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Re-create the named-param adapter pinned to v6
--
-- Same 12-param signature as the historical mig 019 implementation. The
-- only behavior change is the version pin in the JSONB envelope. Every
-- existing named-param caller is unaffected.
-- ---------------------------------------------------------------------------

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
    p_source_type      TEXT    DEFAULT 'manual',
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
        '_v',               '6'   -- named-param callers are always full v6
    );

    RETURN submit_result_secure(v_payload);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Re-grant EXECUTE
--
-- The DROP CASCADE above wiped the named-param overload's grants. Internal
-- versioned functions remain RESTRICTED — only the router invokes them.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION submit_result_secure_v5(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_result_secure_v6(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_result_secure(JSONB)    FROM PUBLIC;

GRANT  EXECUTE ON FUNCTION submit_result_secure(JSONB)    TO authenticated;
GRANT  EXECUTE ON FUNCTION submit_result_secure(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INT, JSONB, BIGINT, TEXT, TEXT
)                                                           TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Function-level COMMENTs — surfaced in pg_description / Supabase Studio
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION submit_result_secure_v5(JSONB) IS
    'Internal — v5 contract (9-field, pre-telemetry). Invoke via the router only.';
COMMENT ON FUNCTION submit_result_secure_v6(JSONB) IS
    'Internal — v6 contract (12-field, +device_timestamp/source_type/session_id). Invoke via the router only.';
COMMENT ON FUNCTION submit_result_secure(JSONB) IS
    'Public router — sniffs payload shape, dispatches to v5 or v6, DLQs unmatched payloads to failed_rpc_logs.';
COMMENT ON FUNCTION submit_result_secure(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, INT, JSONB, BIGINT, TEXT, TEXT
) IS 'Named-param adapter — packs args into JSONB and calls the router with _v=6.';

COMMIT;
