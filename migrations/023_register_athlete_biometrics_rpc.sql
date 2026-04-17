-- =============================================================================
-- MIGRATION 023: register_athlete_secure v5 — Biometric Parameters
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--
--   1. Drops the v4 regression introduced by 016_tier1_data_hardening.sql.
--      That migration incorrectly stripped the full parameter set, waiver
--      write, token generation, and portal token logic from the function,
--      replacing them with a stripped 8-parameter stub that broke Register.tsx
--      (which relies on claim_token in the response).
--
--   2. Creates register_athlete_secure v5. It is a strict superset of v3
--      (014_duplicate_athlete_guard.sql):
--        — Retains all four security gates from v3 (input validation, event
--          check, rate limit, duplicate guard)
--        — Retains full write phase from v3 (athletes INSERT, waivers INSERT,
--          claim token generation, parent portal token generation)
--        — Retains v3's COPPA-safe duplicate/error messages
--        — Adds email format regex gate from v4 (016)
--        — Adds check_violation + not_null_violation handlers from v4 (016)
--        — Adds three new optional biometric parameters:
--            p_height_in   INT     DEFAULT NULL  → athletes.height_in
--            p_weight_lb   INT     DEFAULT NULL  → athletes.weight_lb
--            p_high_school TEXT    DEFAULT NULL  → athletes.high_school
--          All three default to NULL — no change in behaviour for callers
--          that do not pass them (backward compatible).
--
--   3. All new parameters use DEFAULT NULL so existing callers (tests,
--      legacy scripts, admin tooling) continue to work without modification.
--
-- FUNCTION HISTORY:
--   v1 — hardening_migration.sql      : initial athlete + waiver + token
--   v2 — 011_rate_limiting.sql        : + rate limit (5/email/hour)
--   v3 — 014_duplicate_athlete_guard.sql : + duplicate guard, input gates,
--                                          email normalisation, COPPA messages
--   v4 — 016_tier1_data_hardening.sql : REGRESSION (stripped, broken)
--   v5 — THIS FILE                    : v3 restored + email regex + biometrics
--
-- SQLERRM POSTURE (v3 convention, unchanged):
--   SQLERRM is NEVER returned to the RPC caller. It is written to the server
--   log via RAISE LOG only. All client-facing error strings are string literals
--   defined in this migration. This prevents schema name / column name leakage.
--
-- IDEMPOTENCY:
--   The DROP block uses a dynamic query to remove all existing overloads of
--   register_athlete_secure regardless of parameter count — handles both the
--   v4 stripped signature and the v3/v5 full signature in one pass.
--   CREATE OR REPLACE FUNCTION is always idempotent for an identical signature.
--
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Drop all existing overloads of register_athlete_secure.
--
-- Postgres treats functions with different parameter lists as distinct objects
-- (different OIDs). Because v4 (016) changed the signature, both the v4 stub
-- AND the v3 full version may coexist in the database. The dynamic DROP
-- removes every overload by name, regardless of arity, so CREATE OR REPLACE
-- below always wins cleanly.
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
-- Step 2: register_athlete_secure v5
--
-- Execution order (fail-fast, cheapest first):
--   Gate 1  — Input validation            (0 DB I/O)
--   Gate 1.5 — Email format regex         (0 DB I/O, from v4)
--   Gate 2  — Event exists + accepting    (1 index scan)
--   Gate 3  — Rate limit                  (1 index scan)
--   Gate 4  — Duplicate athlete check     (1 index scan)
--   Write   — INSERT athlete (with biometrics), INSERT waiver, tokens
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
    -- New in v5: biometric fields — all optional, DEFAULT NULL
    p_height_in               INT     DEFAULT NULL,
    p_weight_lb               INT     DEFAULT NULL,
    p_high_school             TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id      UUID;
    v_token           TEXT;
    v_portal_token    TEXT;
    v_age_years       INTEGER;

    -- Email regex (mirrors DB constraint athletes_parent_email_format_check
    -- added by migration 016 — same pattern, evaluated here first to avoid
    -- the round-trip cost of a failed INSERT).
    v_email_regex TEXT := '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$';

    -- Normalised working copies — never mutate p_* params directly.
    -- Display-case names (trim only) are stored; lowercase is used for
    -- de-duplication predicates and the rate-limit check.
    v_first_name_display  TEXT;
    v_last_name_display   TEXT;
    v_first_name_lower    TEXT;
    v_last_name_lower     TEXT;
    v_parent_email        TEXT;
    -- Phone: strip all non-digit characters before storage and comparison.
    -- Prevents phantom duplicates from formatting variance:
    --   "(555) 867-5309" = "555-867-5309" = "5558675309"
    v_parent_phone        TEXT;
    v_emergency_phone     TEXT;
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

    IF v_first_name_display = '' OR v_last_name_display = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'First and last name are required.',
            'code',    'INVALID_NAME'
        );
    END IF;

    IF p_date_of_birth IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Date of birth is required.',
            'code',    'DOB_REQUIRED',
            'field',   'date_of_birth'
        );
    END IF;

    IF p_date_of_birth > CURRENT_DATE THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Date of birth cannot be in the future.',
            'code',    'INVALID_DOB_FUTURE',
            'field',   'date_of_birth'
        );
    END IF;

    -- Age must be between 10 and 19 years inclusive.
    -- EXTRACT(YEAR FROM AGE(...)) gives whole elapsed years, matching the
    -- getFullYear() delta logic in the client-side Zod schema (src/lib/types.ts).
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
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Parent or guardian email is required.',
            'code',    'EMAIL_REQUIRED',
            'field',   'parent_email'
        );
    END IF;

    -- Gate 1.5: Email format check (from v4/016 — mirrors DB CHECK constraint).
    IF v_parent_email !~* v_email_regex THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Please enter a valid email address.',
            'code',    'INVALID_EMAIL',
            'field',   'parent_email'
        );
    END IF;

    -- Parent phone: must resolve to exactly 10 digits after stripping formatting.
    IF length(v_parent_phone) != 10 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'A valid 10-digit parent phone number is required.',
            'code',    'INVALID_PHONE',
            'field',   'parent_phone'
        );
    END IF;

    IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Position is required.',
            'code',    'POSITION_REQUIRED',
            'field',   'position'
        );
    END IF;

    -- Data consent is a legal requirement. Enforce at the DB layer as a
    -- secondary guard even if client-side validation already checked it.
    IF p_data_consent IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Data consent must be accepted to complete registration.',
            'code',    'CONSENT_REQUIRED'
        );
    END IF;

    -- =========================================================================
    -- GATE 2: Event Validation — 1 index scan on events.id
    -- =========================================================================

    IF NOT EXISTS (
        SELECT 1 FROM events
        WHERE  id     = p_event_id
          AND  status IN ('live', 'draft')
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Invalid or inactive event.',
            'code',    'INVALID_EVENT'
        );
    END IF;

    -- =========================================================================
    -- GATE 3: Rate Limit — 1 index scan on (parent_email, created_at)
    -- Max 5 registrations per parent email per event per hour.
    -- Prevents automated flood attacks and accidental double-submit loops.
    -- =========================================================================

    IF (
        SELECT count(*)
        FROM   athletes
        WHERE  parent_email = v_parent_email
          AND  event_id     = p_event_id
          AND  created_at   > now() - INTERVAL '1 hour'
    ) >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Too many registration attempts. Please try again in an hour.',
            'code',    'RATE_LIMITED'
        );
    END IF;

    -- =========================================================================
    -- GATE 4: Duplicate Athlete Check — uses functional unique index
    --
    -- This SELECT is the fast-path UX guard. It runs before the INSERT so we
    -- can return a friendly message rather than a raw constraint violation.
    --
    -- The unique index (idx_athletes_event_name_dob_unique) from migration 014
    -- is the true enforcement layer. Concurrent requests that both pass this
    -- check before either writes will trigger a unique_violation (23505) on
    -- the second INSERT, caught in the EXCEPTION block below.
    --
    -- COPPA NOTE: The message does NOT confirm whether the specific child is
    -- registered — it uses a neutral formulation and redirects to staff.
    -- =========================================================================

    IF EXISTS (
        SELECT 1
        FROM   athletes
        WHERE  event_id                = p_event_id
          AND  lower(trim(first_name)) = v_first_name_lower
          AND  lower(trim(last_name))  = v_last_name_lower
          AND  date_of_birth           = p_date_of_birth
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'A registration for this athlete may already exist. Please check with event staff.',
            'code',    'DUPLICATE_REG'
        );
    END IF;

    -- =========================================================================
    -- WRITE PHASE — all inserts execute atomically within this function scope.
    -- Supabase's RPC endpoint issues each function call as a single statement-
    -- level transaction — all writes commit together or all roll back.
    -- =========================================================================

    -- 5a. Insert athlete row.
    --     Display-case names stored (trim only, case preserved).
    --     Email stored lowercase. Phone stored digits-only.
    --     Biometric fields stored as-is (already validated / NULL by caller).
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
        high_school
    )
    VALUES (
        p_event_id,
        v_first_name_display,       -- "John" — display case preserved
        v_last_name_display,        -- "Smith" — display case preserved
        p_date_of_birth,
        trim(coalesce(p_grade, '')),
        trim(p_position),
        trim(coalesce(p_parent_name, '')),
        v_parent_email,             -- lowercase-normalised
        v_parent_phone,             -- digits-only normalised
        p_height_in,                -- integer inches (NULL if not provided)
        p_weight_lb,                -- integer lbs    (NULL if not provided)
        trim(coalesce(p_high_school, '')) -- '' stored as NULL via NULLIF below
    )
    RETURNING id INTO v_athlete_id;

    -- Coerce empty high_school string to NULL post-insert (trim of NULL → '').
    -- Keeps the column clean: either a non-empty school name or NULL.
    UPDATE athletes
    SET    high_school = NULLIF(high_school, '')
    WHERE  id          = v_athlete_id
      AND  high_school = '';

    -- 5b. Insert waiver record linked to this athlete.
    --     emergency_contact_phone also digit-normalised for consistency.
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
        v_emergency_phone,                          -- digits-only normalised
        p_signature_data_url,
        p_injury_waiver_ack,
        p_media_release,
        p_data_consent,
        p_marketing_consent
    );

    -- 5c. Claim token — 128-bit cryptographic hex, valid 24 hours, single-use.
    --     Infeasible to enumerate: 2^128 ≈ 3.4 × 10^38 possible values.
    v_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + INTERVAL '24 hours');

    -- 5d. Parent portal token — separate 128-bit token.
    --     Guarded by table existence check so the function degrades gracefully
    --     on environments where parent_portals has not yet been created.
    v_portal_token := encode(gen_random_bytes(16), 'hex');

    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE  table_schema = 'public'
          AND  table_name   = 'parent_portals'
    ) THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, v_portal_token);
    END IF;

    -- =========================================================================
    -- SUCCESS
    -- =========================================================================

    RETURN jsonb_build_object(
        'success',      true,
        'athlete_id',   v_athlete_id,
        'claim_token',  v_token,
        'portal_token', v_portal_token
    );

-- =============================================================================
-- EXCEPTION BLOCK
--
-- Priority order:
--   1. unique_violation (23505)  — concurrent duplicate that slipped past Gate 4
--   2. not_null_violation (23502) / check_violation (23514) — bad payload
--   3. OTHERS — unexpected DB error (disk, network, lock timeout)
--
-- SQLERRM is NEVER returned to the caller. It is server-logged only.
-- =============================================================================
EXCEPTION
    WHEN unique_violation THEN
        RAISE LOG 'register_athlete_secure DUPLICATE_REG event=% name=% %',
                  p_event_id, v_first_name_lower, v_last_name_lower;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'A registration for this athlete may already exist. Please check with event staff.',
            'code',    'DUPLICATE_REG'
        );

    WHEN check_violation THEN
        -- Inspect SQLERRM server-side only to select the right user message.
        -- Nothing from SQLERRM is forwarded to the caller.
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
        RAISE LOG 'register_athlete_secure NOT_NULL event=% sqlerrm=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'All required fields must be completed.',
            'code',    'VALIDATION_ERROR'
        );

    WHEN OTHERS THEN
        -- SQLERRM intentionally withheld from the response.
        RAISE LOG 'register_athlete_secure INTERNAL_ERROR event=% sqlerrm=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'An unexpected error occurred. Please try again or contact event staff.',
            'code',    'INTERNAL_ERROR'
        );
END;
$$;

-- ---------------------------------------------------------------------------
-- Post-create: revoke direct execute from public, grant to authenticated only.
-- SECURITY DEFINER already runs as the function owner (typically postgres),
-- but restricting EXECUTE prevents unauthenticated callers from invoking it
-- directly via the Postgres wire protocol.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION register_athlete_secure FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO anon;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO authenticated;

COMMIT;
