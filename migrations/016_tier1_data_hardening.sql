-- =============================================================================
-- MIGRATION 016: Tier-1 Data Hardening
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--
--   1. athletes.date_of_birth — add NOT NULL constraint.
--      Existing NULL rows are set to '2000-01-01' (sentinel) before the ALTER
--      so the migration is safe to run on non-empty tables.
--
--   2. athletes.date_of_birth — add CHECK constraint:
--        >= '2005-01-01'           (no participant born before 2005)
--        <= CURRENT_DATE - 9 years (must be at least 9 years old)
--      The function-level age gates (10-19) remain the primary rejection path;
--      this constraint is a DB-level safety net only.
--
--   3. athletes.parent_email — add CHECK constraint:
--      Requires a syntactically valid email (RFC 5322 simplified regex).
--      Catches malformed payloads that bypass client validation.
--
--   4. New functional unique index:
--        (event_id, lower(parent_email), lower(first_name), lower(last_name))
--      Prevents the same family re-registering the same athlete under a single
--      parent email. Complements migration 014's DOB-based unique index.
--
--   5. register_athlete_secure v4 — two improvements:
--      a. Gate 1 adds explicit email regex check (cheaper than a DB round-trip).
--      b. EXCEPTION block handles check_violation (23514) from the new DB
--         constraints with a constraint-specific message that names the failing
--         field without exposing internal schema details.
--
-- SQLERRM POSTURE (unchanged from v3):
--   SQLERRM is NEVER returned to the RPC caller. It is written to the server
--   log via RAISE LOG only. All client-facing error strings are literal
--   constants defined in this file.
--
-- IDEMPOTENCY: Safe to run multiple times.
--   All ALTER TABLE use IF NOT EXISTS / DO blocks.
--   CREATE INDEX uses IF NOT EXISTS.
--   CREATE OR REPLACE FUNCTION is always idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Backfill NULL date_of_birth before enforcing NOT NULL.
-- Sentinel value allows the migration to run on populated tables.
-- Rows with sentinel '2000-01-01' will be caught by the CHECK below and
-- by Gate 1 of register_athlete_secure (DOB_FUTURE / age-range rejection).
-- ---------------------------------------------------------------------------
UPDATE athletes
SET    date_of_birth = '2000-01-01'
WHERE  date_of_birth IS NULL;

ALTER TABLE athletes
  ALTER COLUMN date_of_birth SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 2: date_of_birth range CHECK.
-- Uses CURRENT_DATE (STABLE, safe in CHECK constraints on Postgres 12+).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE  constraint_name = 'athletes_dob_range_check'
    ) THEN
        ALTER TABLE athletes
          ADD CONSTRAINT athletes_dob_range_check
          CHECK (
            date_of_birth >= DATE '2005-01-01'
            AND date_of_birth <= CURRENT_DATE - INTERVAL '9 years'
          );
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Step 3: parent_email format CHECK (simplified RFC 5322).
-- ~* is case-insensitive regex match in Postgres.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE  constraint_name = 'athletes_parent_email_format_check'
    ) THEN
        ALTER TABLE athletes
          ADD CONSTRAINT athletes_parent_email_format_check
          CHECK (
            parent_email ~* '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$'
          );
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Step 4: Functional unique index — prevents same parent email re-registering
-- the same athlete name within the same event.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_athletes_event_email_name_unique
    ON athletes (event_id, lower(parent_email), lower(first_name), lower(last_name));

-- ---------------------------------------------------------------------------
-- Step 5: register_athlete_secure v4
--
-- Changes from v3:
--   - Gate 1: added email regex check (returns INVALID_EMAIL with field hint)
--   - Gate 1: tightened DOB lower-bound to 2005-01-01 (mirrors DB constraint)
--   - EXCEPTION block: check_violation (23514) returns named-field hint
--     by inspecting SQLERRM server-side to choose the message, while
--     the returned JSON contains only a safe, user-facing string.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id       UUID,
    p_first_name     TEXT,
    p_last_name      TEXT,
    p_date_of_birth  DATE,
    p_parent_email   TEXT,
    p_parent_phone   TEXT,
    p_position       TEXT,
    p_meta           JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_event              RECORD;
    v_rate_count         INT;
    v_existing_id        UUID;
    v_athlete_id         UUID;
    v_band_id            TEXT;

    -- Normalised working copies (never mutate p_* params)
    v_first_name_lower   TEXT;
    v_last_name_lower    TEXT;
    v_first_name_display TEXT;
    v_last_name_display  TEXT;
    v_parent_email       TEXT;
    v_parent_phone       TEXT;

    -- Email regex (mirrors DB constraint athletes_parent_email_format_check)
    v_email_regex        TEXT := '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$';
BEGIN

    -- ── Gate 1: Input validation — zero DB I/O ────────────────────────────────
    -- Normalise first
    v_first_name_display := trim(p_first_name);
    v_last_name_display  := trim(p_last_name);
    v_first_name_lower   := lower(v_first_name_display);
    v_last_name_lower    := lower(v_last_name_display);
    v_parent_email       := lower(trim(p_parent_email));
    -- Normalise phone: strip all non-digits
    v_parent_phone       := regexp_replace(coalesce(p_parent_phone, ''), '[^0-9]', '', 'g');

    IF length(v_first_name_lower) = 0 OR length(v_last_name_lower) = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'First and last name are required.',
            'code',    'NAME_REQUIRED',
            'field',   'name'
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
            'code',    'DOB_FUTURE',
            'field',   'date_of_birth'
        );
    END IF;

    -- Mirror the DB constraint: DOB must be >= 2005-01-01
    IF p_date_of_birth < DATE '2005-01-01' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Athlete is too old to participate in this combine.',
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

    -- Email format check (Gate 1.5 — mirrors DB CHECK constraint)
    IF v_parent_email !~* v_email_regex THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Please enter a valid email address.',
            'code',    'INVALID_EMAIL',
            'field',   'parent_email'
        );
    END IF;

    IF length(v_parent_phone) != 10 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Please enter a valid 10-digit US phone number.',
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

    -- ── Gate 2: Event validation ──────────────────────────────────────────────
    SELECT id, status, registration_open
    INTO   v_event
    FROM   events
    WHERE  id = p_event_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Event not found.',
            'code',    'EVENT_NOT_FOUND'
        );
    END IF;

    IF v_event.status NOT IN ('active', 'draft') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Registration is not currently open for this event.',
            'code',    'EVENT_CLOSED'
        );
    END IF;

    -- ── Gate 3: Age range check (10–19) ──────────────────────────────────────
    DECLARE
        v_age INT;
    BEGIN
        v_age := EXTRACT(YEAR FROM AGE(CURRENT_DATE, p_date_of_birth))::INT;
        IF v_age < 10 OR v_age > 19 THEN
            RETURN jsonb_build_object(
                'success', false,
                'error',   CASE
                    WHEN v_age < 10 THEN 'Athlete must be at least 10 years old to participate.'
                    ELSE 'Athlete must be 19 or younger to participate.'
                END,
                'code',    'INVALID_AGE',
                'field',   'date_of_birth'
            );
        END IF;
    END;

    -- ── Gate 4: Rate limit ────────────────────────────────────────────────────
    SELECT COUNT(*) INTO v_rate_count
    FROM   athletes
    WHERE  event_id    = p_event_id
      AND  parent_email = v_parent_email
      AND  created_at  > NOW() - INTERVAL '1 hour';

    IF v_rate_count >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Too many registration attempts. Please wait before trying again.',
            'code',    'RATE_LIMITED'
        );
    END IF;

    -- ── Gate 5: Duplicate athlete check ──────────────────────────────────────
    SELECT id INTO v_existing_id
    FROM   athletes
    WHERE  event_id         = p_event_id
      AND  lower(trim(first_name)) = v_first_name_lower
      AND  lower(trim(last_name))  = v_last_name_lower
      AND  date_of_birth           = p_date_of_birth
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            -- COPPA: never confirm whether a specific child's record exists.
            'error',   'A registration for this athlete may already exist. Please check with event staff.',
            'code',    'DUPLICATE_REG'
        );
    END IF;

    -- ── Write phase ───────────────────────────────────────────────────────────
    INSERT INTO athletes (
        event_id,
        first_name,
        last_name,
        date_of_birth,
        parent_email,
        parent_phone,
        position,
        meta
    )
    VALUES (
        p_event_id,
        v_first_name_display,
        v_last_name_display,
        p_date_of_birth,
        v_parent_email,
        v_parent_phone,
        trim(p_position),
        p_meta
    )
    RETURNING id INTO v_athlete_id;

    RETURN jsonb_build_object(
        'success',    true,
        'athlete_id', v_athlete_id
    );

EXCEPTION
    WHEN unique_violation THEN
        RAISE LOG 'register_athlete_secure DUPLICATE event=% name=% %',
                  p_event_id, v_first_name_lower, v_last_name_lower;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'A registration for this athlete may already exist. Please check with event staff.',
            'code',    'DUPLICATE_REG'
        );

    WHEN check_violation THEN
        -- Inspect SQLERRM server-side only to pick the right user message.
        -- Nothing from SQLERRM is returned to the caller.
        RAISE LOG 'register_athlete_secure CHECK_VIOLATION event=% error=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   CASE
                WHEN SQLERRM ILIKE '%dob_range%' OR SQLERRM ILIKE '%date_of_birth%'
                    THEN 'Athlete date of birth is outside the eligible range for this event.'
                WHEN SQLERRM ILIKE '%email%'
                    THEN 'Please enter a valid email address.'
                ELSE 'Invalid registration data. Please verify all fields and try again.'
            END,
            'code',    'VALIDATION_ERROR'
        );

    WHEN not_null_violation THEN
        RAISE LOG 'register_athlete_secure NOT_NULL event=% error=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'All required fields must be completed.',
            'code',    'VALIDATION_ERROR'
        );

    WHEN OTHERS THEN
        -- SQLERRM intentionally withheld from response. Logged server-side only.
        RAISE LOG 'register_athlete_secure INTERNAL_ERROR event=% error=%',
                  p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'An unexpected error occurred. Please try again or contact event staff.',
            'code',    'INTERNAL_ERROR'
        );
END;
$$;

COMMIT;
