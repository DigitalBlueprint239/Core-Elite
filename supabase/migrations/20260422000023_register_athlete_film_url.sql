-- =============================================================================
-- MIGRATION 023 (supabase/): register_athlete_secure v6 — Film URL Persistence
-- Core Elite Combine 2026 · Mission R.2 Persistence Patch
-- =============================================================================
--
-- PROBLEM STATEMENT:
--   Mission R added a film_url text column to profiles and wired the optional
--   input into Register.tsx + the Zod schema, but the bridge that converts
--   form state into DB rows — register_athlete_secure — was not touched. The
--   RPC silently drops the URL, so every athlete registered after Mission R
--   lost their film link.
--
-- HOME-TABLE DECISION (profiles vs athletes):
--   The directive references an "INSERT INTO profiles" block. No such block
--   exists in register_athlete_secure — the RPC creates athletes, waivers,
--   token_claims, and parent_portals. profiles is strictly auth-user-scoped
--   (id UUID PK REFERENCES auth.users(id)) and no auth.users row is created
--   during an event registration — athletes register pseudonymously, the
--   parent's email is the only identifier.
--
--   Film URL is athlete-indexed data (it's about the player being scouted),
--   not account-indexed data. It belongs on athletes, matching the exact
--   pattern used by height_in / weight_lb / high_school in RPC v5 (legacy
--   migration 023). The Scout View renders from athletes, so this is also
--   the closest-to-query home.
--
--   profiles.film_url (from migration 022) is retained for the future case
--   where an athlete creates an auth account and manages their reel from
--   a profile page. Keeping both columns nullable costs 8 bytes per row
--   each and decouples the two surfaces cleanly.
--
-- CHANGES:
--
--   1. athletes.film_url — nullable text column, no CHECK.
--      Validation of URL shape lives in the Zod schema (src/lib/types.ts)
--      and src/lib/hudl.ts at render time. We store the raw string so the
--      parser can evolve without a schema migration.
--
--   2. register_athlete_secure v6 — adds p_film_url TEXT DEFAULT NULL as the
--      last parameter (backward compatible: existing callers without the
--      param continue to work unchanged).
--
--      Write mapping: NULLIF(trim(coalesce(p_film_url, '')), '') → athletes.film_url.
--      Trims whitespace, coerces empty string to NULL (so the Scout View's
--      empty-state path triggers cleanly for athletes who typed-then-deleted).
--
--   3. Same dynamic DROP pattern as legacy mig 023 to handle coexisting
--      overloads (v5 and v6 would otherwise both exist after CREATE).
--
-- FUNCTION HISTORY:
--   v5 — migrations/023_register_athlete_biometrics_rpc.sql : + height/weight/hs
--   v6 — THIS FILE                                          : + film_url
--
-- IDEMPOTENCY:
--   ADD COLUMN IF NOT EXISTS + dynamic DROP + CREATE OR REPLACE = re-runnable.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Add the column.
-- ---------------------------------------------------------------------------
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS film_url text;

COMMENT ON COLUMN athletes.film_url IS
  'Optional highlight-reel URL (Hudl, YouTube, Vimeo). Nullable by design — the Scout View renders a deliberate empty state on NULL.';

-- ---------------------------------------------------------------------------
-- Step 2: Drop every existing overload of register_athlete_secure by name.
-- Different param lists = different OIDs; we clear them all so the v6 create
-- below is unambiguous.
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
          AND  p.proname = 'register_athlete_secure'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 3: register_athlete_secure v6
--   Identical to v5 except: +p_film_url param, +athletes.film_url write.
--   Comments trimmed here — see migrations/023 for full gate-by-gate rationale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id                UUID,
    p_first_name              TEXT,
    p_last_name               TEXT,
    p_date_of_birth           DATE,
    p_grade                   TEXT    DEFAULT NULL,
    p_position                TEXT    DEFAULT NULL,
    p_parent_name             TEXT    DEFAULT NULL,
    p_parent_email            TEXT    DEFAULT NULL,
    p_parent_phone            TEXT    DEFAULT NULL,
    p_guardian_relationship   TEXT    DEFAULT NULL,
    p_emergency_contact_name  TEXT    DEFAULT NULL,
    p_emergency_contact_phone TEXT    DEFAULT NULL,
    p_signature_data_url      TEXT    DEFAULT NULL,
    p_injury_waiver_ack       BOOLEAN DEFAULT false,
    p_media_release           BOOLEAN DEFAULT false,
    p_data_consent            BOOLEAN DEFAULT false,
    p_marketing_consent       BOOLEAN DEFAULT false,
    p_height_in               INT     DEFAULT NULL,
    p_weight_lb               INT     DEFAULT NULL,
    p_high_school             TEXT    DEFAULT NULL,
    -- New in v6: optional highlight-reel URL.
    p_film_url                TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id      UUID;
    v_token           TEXT;
    v_portal_token    TEXT;
    v_age_years       INTEGER;

    v_email_regex TEXT := '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$';

    v_first_name_display  TEXT;
    v_last_name_display   TEXT;
    v_first_name_lower    TEXT;
    v_last_name_lower     TEXT;
    v_parent_email        TEXT;
    v_parent_phone        TEXT;
    v_emergency_phone     TEXT;
    -- v6: normalise film URL — trim + empty-to-NULL. We do NOT validate URL
    -- shape here; that lives in Zod + src/lib/hudl.ts at render time.
    v_film_url            TEXT;
BEGIN

    -- =========================================================================
    -- GATE 1: Input Validation — zero DB I/O
    -- =========================================================================

    v_first_name_display := trim(coalesce(p_first_name, ''));
    v_last_name_display  := trim(coalesce(p_last_name,  ''));
    v_first_name_lower   := lower(v_first_name_display);
    v_last_name_lower    := lower(v_last_name_display);
    v_parent_email       := lower(trim(coalesce(p_parent_email, '')));
    v_parent_phone       := regexp_replace(trim(coalesce(p_parent_phone, '')),             '[^0-9]', '', 'g');
    v_emergency_phone    := regexp_replace(trim(coalesce(p_emergency_contact_phone, '')), '[^0-9]', '', 'g');
    v_film_url           := NULLIF(trim(coalesce(p_film_url, '')), '');

    IF v_first_name_display = '' OR v_last_name_display = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'First and last name are required.', 'code', 'INVALID_NAME');
    END IF;

    IF p_date_of_birth IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Date of birth is required.', 'code', 'DOB_REQUIRED', 'field', 'date_of_birth');
    END IF;

    IF p_date_of_birth > CURRENT_DATE THEN
        RETURN jsonb_build_object('success', false, 'error', 'Date of birth cannot be in the future.', 'code', 'INVALID_DOB_FUTURE', 'field', 'date_of_birth');
    END IF;

    v_age_years := EXTRACT(YEAR FROM AGE(CURRENT_DATE, p_date_of_birth))::INT;
    IF v_age_years < 10 OR v_age_years > 19 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   CASE
                WHEN v_age_years < 10 THEN 'Athlete must be at least 10 years old to participate.'
                ELSE 'Athlete must be 19 or younger to participate.'
            END,
            'code',    'INVALID_AGE',
            'field',   'date_of_birth'
        );
    END IF;

    IF length(v_parent_email) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Parent or guardian email is required.', 'code', 'EMAIL_REQUIRED', 'field', 'parent_email');
    END IF;

    IF v_parent_email !~* v_email_regex THEN
        RETURN jsonb_build_object('success', false, 'error', 'Please enter a valid email address.', 'code', 'INVALID_EMAIL', 'field', 'parent_email');
    END IF;

    IF length(v_parent_phone) != 10 THEN
        RETURN jsonb_build_object('success', false, 'error', 'A valid 10-digit parent phone number is required.', 'code', 'INVALID_PHONE', 'field', 'parent_phone');
    END IF;

    IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Position is required.', 'code', 'POSITION_REQUIRED', 'field', 'position');
    END IF;

    IF p_data_consent IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'error', 'Data consent must be accepted to complete registration.', 'code', 'CONSENT_REQUIRED');
    END IF;

    -- =========================================================================
    -- GATE 2: Event Validation
    -- =========================================================================

    IF NOT EXISTS (
        SELECT 1 FROM events
        WHERE  id = p_event_id AND status IN ('live', 'draft')
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid or inactive event.', 'code', 'INVALID_EVENT');
    END IF;

    -- =========================================================================
    -- GATE 3: Rate Limit — 5 / email / event / hour
    -- =========================================================================

    IF (
        SELECT count(*) FROM athletes
        WHERE  parent_email = v_parent_email
          AND  event_id     = p_event_id
          AND  created_at   > now() - INTERVAL '1 hour'
    ) >= 5 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Too many registration attempts. Please try again in an hour.', 'code', 'RATE_LIMITED');
    END IF;

    -- =========================================================================
    -- GATE 4: Duplicate Athlete Check
    -- =========================================================================

    IF EXISTS (
        SELECT 1 FROM athletes
        WHERE  event_id                = p_event_id
          AND  lower(trim(first_name)) = v_first_name_lower
          AND  lower(trim(last_name))  = v_last_name_lower
          AND  date_of_birth           = p_date_of_birth
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'A registration for this athlete may already exist. Please check with event staff.', 'code', 'DUPLICATE_REG');
    END IF;

    -- =========================================================================
    -- WRITE PHASE
    -- =========================================================================

    INSERT INTO athletes (
        event_id,
        first_name,
        last_name,
        date_of_birth,
        grade,
        position,
        parent_name,
        parent_email,
        parent_phone,
        height_in,
        weight_lb,
        high_school,
        film_url
    )
    VALUES (
        p_event_id,
        v_first_name_display,
        v_last_name_display,
        p_date_of_birth,
        trim(coalesce(p_grade, '')),
        trim(p_position),
        trim(coalesce(p_parent_name, '')),
        v_parent_email,
        v_parent_phone,
        p_height_in,
        p_weight_lb,
        trim(coalesce(p_high_school, '')),
        v_film_url                          -- v6: already NULLIF'd + trimmed
    )
    RETURNING id INTO v_athlete_id;

    UPDATE athletes
    SET    high_school = NULLIF(high_school, '')
    WHERE  id          = v_athlete_id
      AND  high_school = '';

    INSERT INTO waivers (
        athlete_id,
        event_id,
        guardian_name,
        guardian_relationship,
        emergency_contact_name,
        emergency_contact_phone,
        signature_data_url,
        agreed,
        media_release,
        data_consent,
        marketing_consent
    )
    VALUES (
        v_athlete_id,
        p_event_id,
        trim(coalesce(p_parent_name, '')),
        trim(coalesce(p_guardian_relationship, '')),
        trim(coalesce(p_emergency_contact_name, '')),
        v_emergency_phone,
        p_signature_data_url,
        p_injury_waiver_ack,
        p_media_release,
        p_data_consent,
        p_marketing_consent
    );

    v_token := encode(gen_random_bytes(16), 'hex');
    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + INTERVAL '24 hours');

    v_portal_token := encode(gen_random_bytes(16), 'hex');
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE  table_schema = 'public' AND table_name = 'parent_portals'
    ) THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, v_portal_token);
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'athlete_id',   v_athlete_id,
        'claim_token',  v_token,
        'portal_token', v_portal_token
    );

EXCEPTION
    WHEN unique_violation THEN
        RAISE LOG 'register_athlete_secure DUPLICATE_REG event=% name=% %',
                  p_event_id, v_first_name_lower, v_last_name_lower;
        RETURN jsonb_build_object('success', false, 'error', 'A registration for this athlete may already exist. Please check with event staff.', 'code', 'DUPLICATE_REG');

    WHEN check_violation THEN
        RAISE LOG 'register_athlete_secure CHECK_VIOLATION event=% sqlerrm=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   CASE
                WHEN SQLERRM ILIKE '%dob_range%'  OR SQLERRM ILIKE '%date_of_birth%'
                    THEN 'Athlete date of birth is outside the eligible range for this event.'
                WHEN SQLERRM ILIKE '%email%'
                    THEN 'Please enter a valid email address.'
                ELSE 'Invalid registration data. Please verify all fields and try again.'
            END,
            'code',    'VALIDATION_ERROR'
        );

    WHEN not_null_violation THEN
        RAISE LOG 'register_athlete_secure NOT_NULL event=% sqlerrm=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'All required fields must be completed.', 'code', 'VALIDATION_ERROR');

    WHEN OTHERS THEN
        RAISE LOG 'register_athlete_secure INTERNAL_ERROR event=% sqlerrm=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred. Please try again or contact event staff.', 'code', 'INTERNAL_ERROR');
END;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: Re-apply the restrictive EXECUTE grants (DROP + CREATE loses them).
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION register_athlete_secure FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO anon;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO authenticated;

COMMIT;
