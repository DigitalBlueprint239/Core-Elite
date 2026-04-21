-- =============================================================================
-- MIGRATION 024: Enterprise Importer — Hardware Verification Moat
-- Core Elite Combine 2026
-- =============================================================================
--
-- MISSION N: Secure CSV Ingestion Pipeline
--
-- CHANGES:
--
--   1. results.is_hardware_verified BOOLEAN NOT NULL DEFAULT false
--      The "Verified Truth" moat column. Set TRUE only via submit_result_secure
--      when p_source_type = 'live_ble'. CSV imports are permanently FALSE.
--
--   2. results.band_id / station_id — made nullable.
--      Legacy imports have no band or station context. NULL is only valid when
--      source_type = 'legacy_csv'. Enforced by CHECK constraint below.
--
--   3. submit_result_secure v7 — adds is_hardware_verified to INSERT.
--      live_ble → true. manual_staff / legacy_csv → false.
--
--   4. import_legacy_results_batch(p_event_id UUID, p_records JSONB)
--      Batch RPC for the EnterpriseImporter UI. Deduplicates athletes by
--      (first_name, last_name) and parent_email within the event, creates stubs
--      for unknowns, inserts results with is_hardware_verified = false and
--      source_type = 'legacy_csv'. Returns summary JSONB.
--
-- IDEMPOTENCY: Safe to run multiple times (IF NOT EXISTS / CREATE OR REPLACE).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. is_hardware_verified column
-- ---------------------------------------------------------------------------

ALTER TABLE results
  ADD COLUMN IF NOT EXISTS is_hardware_verified BOOLEAN NOT NULL DEFAULT false;

-- Back-fill: existing live_ble rows are hardware-verified by definition
UPDATE results
  SET is_hardware_verified = true
  WHERE source_type = 'live_ble'
    AND is_hardware_verified = false;

-- Index: fast filter for verified-only exports (college scouting, ARMS reports)
CREATE INDEX IF NOT EXISTS idx_results_hw_verified
    ON results (athlete_id, drill_type)
    WHERE is_hardware_verified = true;

-- ---------------------------------------------------------------------------
-- 2. Allow NULL band_id / station_id for legacy imports only
-- ---------------------------------------------------------------------------

ALTER TABLE results ALTER COLUMN band_id    DROP NOT NULL;
ALTER TABLE results ALTER COLUMN station_id DROP NOT NULL;

-- Enforce: NULL columns are only valid for legacy CSV imports
ALTER TABLE results DROP CONSTRAINT IF EXISTS results_legacy_nullable_check;
ALTER TABLE results
  ADD CONSTRAINT results_legacy_nullable_check
  CHECK (
    source_type = 'legacy_csv'
    OR (band_id IS NOT NULL AND station_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 3. submit_result_secure v7
--
-- Identical to v6 (migration 019) except is_hardware_verified added to INSERT.
-- is_hardware_verified = (p_source_type = 'live_ble') — evaluated at write time.
-- All existing callers get false by default (p_source_type defaults 'manual_staff').
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
    p_source_type      TEXT    DEFAULT 'manual_staff',
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
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized', 'code', 'UNAUTHORIZED');
    END IF;

    SELECT id INTO v_result_id
    FROM results
    WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    END IF;

    IF p_attempt_number <= 1 THEN
        SELECT
            id,
            value_num      AS existing_value,
            recorded_at    AS existing_recorded_at,
            attempt_number AS existing_attempt_number
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

    v_hlc               := p_meta->>'hlc_timestamp';
    v_validation_status := CASE
        WHEN (p_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id, event_id, athlete_id, band_id, station_id,
        drill_type, value_num, attempt_number, meta, hlc_timestamp,
        validation_status, device_timestamp, source_type, session_id,
        recorded_by, is_hardware_verified
    )
    VALUES (
        p_client_result_id, p_event_id, p_athlete_id, p_band_id, p_station_id,
        p_drill_type, p_value_num, p_attempt_number, p_meta, v_hlc,
        v_validation_status, p_device_timestamp, p_source_type, p_session_id,
        auth.uid(),
        (p_source_type = 'live_ble')
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_result_id FROM results WHERE client_result_id = p_client_result_id;
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'submit_result_secure v7 error: athlete=% drill=% sqlerrm=%',
                  p_athlete_id, p_drill_type, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.', 'code', 'INTERNAL_ERROR');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. import_legacy_results_batch
--
-- Input p_records: JSON array of objects. Each object:
--   Required:  first_name TEXT, last_name TEXT, dob TEXT (YYYY-MM-DD)
--   Optional:  email TEXT, position TEXT
--   Drills:    forty NUMERIC, pro_agility NUMERIC, vertical NUMERIC, broad NUMERIC
--
-- Dedup logic (within the target event):
--   Primary:   lower(first_name) + lower(last_name) match
--   Secondary: parent_email match (if email provided and name lookup fails)
--
-- Inserted results always have:
--   is_hardware_verified = false   (cannot be promoted — permanent)
--   source_type          = 'legacy_csv'
--   band_id              = NULL    (no station context for legacy data)
--   station_id           = NULL
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION import_legacy_results_batch(
    p_event_id UUID,
    p_records  JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_record         JSONB;
    v_athlete_id     UUID;
    v_first_name     TEXT;
    v_last_name      TEXT;
    v_email          TEXT;
    v_dob            DATE;
    v_position       TEXT;
    v_drill_val      NUMERIC;
    v_count_inserted INT  := 0;
    v_count_athletes INT  := 0;
    v_row_num        INT  := 0;
    v_errors         JSONB := '[]'::jsonb;
BEGIN
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized', 'code', 'UNAUTHORIZED');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Event not found.', 'code', 'INVALID_EVENT');
    END IF;

    IF p_records IS NULL OR jsonb_array_length(p_records) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'No records provided.', 'code', 'EMPTY_BATCH');
    END IF;

    FOR v_record IN SELECT * FROM jsonb_array_elements(p_records) LOOP
        v_row_num    := v_row_num + 1;
        v_athlete_id := NULL;

        v_first_name := trim(coalesce(v_record->>'first_name', ''));
        v_last_name  := trim(coalesce(v_record->>'last_name',  ''));
        v_email      := lower(trim(coalesce(v_record->>'email', '')));
        v_position   := trim(coalesce(v_record->>'position', 'ATH'));

        IF v_first_name = '' OR v_last_name = '' THEN
            v_errors := v_errors || jsonb_build_array(
                jsonb_build_object('row', v_row_num, 'reason', 'First and last name are required.')
            );
            CONTINUE;
        END IF;

        v_dob := NULL;
        BEGIN
            v_dob := (v_record->>'dob')::DATE;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        IF v_dob IS NULL THEN
            v_errors := v_errors || jsonb_build_array(
                jsonb_build_object('row', v_row_num, 'reason',
                    'Invalid date of birth: ' || coalesce(v_record->>'dob', '(empty)'))
            );
            CONTINUE;
        END IF;

        -- Dedup: try name match first, then email
        SELECT id INTO v_athlete_id
        FROM   athletes
        WHERE  event_id                = p_event_id
          AND  lower(trim(first_name)) = lower(v_first_name)
          AND  lower(trim(last_name))  = lower(v_last_name)
        LIMIT 1;

        IF v_athlete_id IS NULL AND v_email != '' THEN
            SELECT id INTO v_athlete_id
            FROM   athletes
            WHERE  event_id      = p_event_id
              AND  parent_email  = v_email
            LIMIT 1;
        END IF;

        -- Create stub athlete if not found
        IF v_athlete_id IS NULL THEN
            INSERT INTO athletes (
                event_id, first_name, last_name, date_of_birth, position,
                parent_name, parent_email, parent_phone, grade
            ) VALUES (
                p_event_id,
                v_first_name,
                v_last_name,
                v_dob,
                NULLIF(v_position, ''),
                'Legacy Import',
                CASE WHEN v_email != '' THEN v_email ELSE 'legacy@import.local' END,
                '0000000000',
                'UNK'
            )
            RETURNING id INTO v_athlete_id;

            v_count_athletes := v_count_athletes + 1;
        END IF;

        -- forty (40-yard dash)
        v_drill_val := NULL;
        BEGIN v_drill_val := (v_record->>'forty')::NUMERIC; EXCEPTION WHEN OTHERS THEN NULL; END;
        IF v_drill_val IS NOT NULL AND v_drill_val > 0 THEN
            INSERT INTO results (
                client_result_id, event_id, athlete_id,
                drill_type, value_num, attempt_number,
                source_type, is_hardware_verified, validation_status,
                recorded_at, meta
            ) VALUES (
                gen_random_uuid(), p_event_id, v_athlete_id,
                'forty', v_drill_val, 1,
                'legacy_csv', false, 'clean', now(),
                jsonb_build_object('import_source', 'enterprise_importer', 'importer_email', v_email)
            );
            v_count_inserted := v_count_inserted + 1;
        END IF;

        -- pro_agility → shuttle_5_10_5
        v_drill_val := NULL;
        BEGIN v_drill_val := (v_record->>'pro_agility')::NUMERIC; EXCEPTION WHEN OTHERS THEN NULL; END;
        IF v_drill_val IS NOT NULL AND v_drill_val > 0 THEN
            INSERT INTO results (
                client_result_id, event_id, athlete_id,
                drill_type, value_num, attempt_number,
                source_type, is_hardware_verified, validation_status,
                recorded_at, meta
            ) VALUES (
                gen_random_uuid(), p_event_id, v_athlete_id,
                'shuttle_5_10_5', v_drill_val, 1,
                'legacy_csv', false, 'clean', now(),
                jsonb_build_object('import_source', 'enterprise_importer', 'importer_email', v_email)
            );
            v_count_inserted := v_count_inserted + 1;
        END IF;

        -- vertical
        v_drill_val := NULL;
        BEGIN v_drill_val := (v_record->>'vertical')::NUMERIC; EXCEPTION WHEN OTHERS THEN NULL; END;
        IF v_drill_val IS NOT NULL AND v_drill_val > 0 THEN
            INSERT INTO results (
                client_result_id, event_id, athlete_id,
                drill_type, value_num, attempt_number,
                source_type, is_hardware_verified, validation_status,
                recorded_at, meta
            ) VALUES (
                gen_random_uuid(), p_event_id, v_athlete_id,
                'vertical', v_drill_val, 1,
                'legacy_csv', false, 'clean', now(),
                jsonb_build_object('import_source', 'enterprise_importer', 'importer_email', v_email)
            );
            v_count_inserted := v_count_inserted + 1;
        END IF;

        -- broad
        v_drill_val := NULL;
        BEGIN v_drill_val := (v_record->>'broad')::NUMERIC; EXCEPTION WHEN OTHERS THEN NULL; END;
        IF v_drill_val IS NOT NULL AND v_drill_val > 0 THEN
            INSERT INTO results (
                client_result_id, event_id, athlete_id,
                drill_type, value_num, attempt_number,
                source_type, is_hardware_verified, validation_status,
                recorded_at, meta
            ) VALUES (
                gen_random_uuid(), p_event_id, v_athlete_id,
                'broad', v_drill_val, 1,
                'legacy_csv', false, 'clean', now(),
                jsonb_build_object('import_source', 'enterprise_importer', 'importer_email', v_email)
            );
            v_count_inserted := v_count_inserted + 1;
        END IF;

    END LOOP;

    RETURN jsonb_build_object(
        'success',      true,
        'inserted',     v_count_inserted,
        'skipped',      0,
        'new_athletes', v_count_athletes,
        'total',        v_row_num,
        'errors',       v_errors
    );

EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'import_legacy_results_batch fatal: event=% sqlerrm=%', p_event_id, SQLERRM;
    RETURN jsonb_build_object(
        'success', false,
        'error',   'Batch import failed. Check server logs.',
        'code',    'INTERNAL_ERROR'
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION import_legacy_results_batch FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION import_legacy_results_batch TO authenticated;

COMMIT;
