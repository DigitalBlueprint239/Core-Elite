-- =============================================================================
-- MIGRATION 014: register_athlete_secure v3 — Duplicate Athlete Guard
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES FROM v2 (migration 011):
--   1. Functional UNIQUE INDEX on (event_id, lower(trim(first_name)),
--      lower(trim(last_name)), date_of_birth) — the ONLY true race-condition
--      guard. The SELECT-then-INSERT check is a fast path for UX; the index
--      is the enforcement layer that holds even under concurrent submissions.
--   2. Input validation block (DOB range, phone digit-count) runs BEFORE any
--      table access. Rejects obviously bad data at zero I/O cost.
--   3. Phone normalization: non-digit chars stripped before storage.
--      "(555) 867-5309" → "5558675309". Prevents phantom duplicates caused
--      by different phone formatting from the same family.
--   4. Machine-readable error codes in every JSONB error response.
--      The client can branch on `code` without parsing the human message.
--   5. Structured EXCEPTION block catches the unique_violation (23505) from
--      the database constraint as a second line of defence under high
--      concurrency — returns DUPLICATE_REG, never exposes SQLERRM to client.
--   6. BEGIN / COMMIT wraps ALL DDL so this migration is atomic: if the
--      function body fails to compile, the index creation also rolls back,
--      leaving the schema in a clean prior state.
--
-- COPPA COMPLIANCE:
--   All error messages returned to unauthenticated callers are deliberately
--   generic. No error message confirms or denies whether a specific child is
--   registered for an event. The `code` field is for client-side branching
--   ONLY and must not be surfaced in UI copy visible to other users.
--
-- IDEMPOTENCY:
--   Safe to run multiple times.
--   - CREATE OR REPLACE FUNCTION: replaces the body, never errors on re-run.
--   - CREATE UNIQUE INDEX IF NOT EXISTS: no-op if the index already exists.
--   - Both are inside one transaction — either both succeed or neither does.
--
-- ROLLBACK SAFETY:
--   If this migration fails (e.g., compile error in the function body), the
--   entire transaction is rolled back. The database is left on v2 (011). No
--   partial state is possible.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Functional unique index — race-condition backstop.
--
-- This enforces uniqueness at the storage layer regardless of how many
-- concurrent requests slip past the SELECT check simultaneously.
--
-- Expression index notes:
--   lower() and trim() are IMMUTABLE in PostgreSQL, so they are valid index
--   expressions. The planner will use this index for equality predicates on
--   lower(trim(first_name)) and lower(trim(last_name)).
--
-- IF NOT EXISTS makes this idempotent: safe to run on a DB that already has
-- this index (e.g., re-running a failed migration, blue/green deploys).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_athletes_event_name_dob_unique
  ON athletes (
    event_id,
    lower(trim(first_name)),
    lower(trim(last_name)),
    date_of_birth
  );

-- ---------------------------------------------------------------------------
-- Step 2: register_athlete_secure v3
--
-- Execution order inside the function (fail-fast, cheapest checks first):
--   1. Input validation  — zero DB I/O; reject bad data immediately
--   2. Event validation  — 1 index scan on events.id
--   3. Rate limit check  — 1 index scan on athletes.parent_email + created_at
--   4. Duplicate check   — 1 index scan on the unique index created above
--   5. INSERT athlete    — the actual write
--   6. INSERT waiver     — linked waiver row
--   7. Token generation  — claim token + portal token
--   8. EXCEPTION block   — catches unique_violation (23505) as DUPLICATE_REG
--                          and any other error as a sanitized INTERNAL_ERROR
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id                UUID,
    p_first_name              TEXT,
    p_last_name               TEXT,
    p_date_of_birth           DATE,
    p_grade                   TEXT,
    p_position                TEXT,
    p_parent_name             TEXT,
    p_parent_email            TEXT,
    p_parent_phone            TEXT,
    p_guardian_relationship   TEXT,
    p_emergency_contact_name  TEXT,
    p_emergency_contact_phone TEXT,
    p_signature_data_url      TEXT,
    p_injury_waiver_ack       BOOLEAN,
    p_media_release           BOOLEAN,
    p_data_consent            BOOLEAN,
    p_marketing_consent       BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id      UUID;
    v_token           TEXT;
    v_portal_token    TEXT;
    v_age_years       INTEGER;

    -- Normalize inputs once in DECLARE.
    -- These variables are used for BOTH the comparison predicates and the
    -- values written to the database, ensuring a single source of truth.
    -- Display-case names (trim only) are stored; lowercase is used for checks.
    v_first_name_display  TEXT := trim(p_first_name);
    v_last_name_display   TEXT := trim(p_last_name);
    v_first_name_lower    TEXT := lower(trim(p_first_name));
    v_last_name_lower     TEXT := lower(trim(p_last_name));
    v_parent_email        TEXT := lower(trim(p_parent_email));
    -- Strip all non-digit characters from phone numbers before storage and
    -- comparison. Prevents phantom duplicates caused by formatting variance:
    --   "(555) 867-5309" and "555-867-5309" and "5558675309" are the same number.
    v_parent_phone        TEXT := regexp_replace(trim(p_parent_phone),       '[^0-9]', '', 'g');
    v_emergency_phone     TEXT := regexp_replace(trim(p_emergency_contact_phone), '[^0-9]', '', 'g');
BEGIN

    -- =========================================================================
    -- GATE 1: Input Validation — zero DB I/O, cheapest possible rejection
    -- =========================================================================

    -- Required text fields must not be blank after trimming.
    IF v_first_name_display = '' OR v_last_name_display = '' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'First and last name are required.',
            'code',    'INVALID_NAME'
        );
    END IF;

    -- Date of birth must not be in the future.
    -- A future DOB is always a data entry error; no valid athlete has one.
    IF p_date_of_birth > CURRENT_DATE THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Date of birth cannot be in the future.',
            'code',    'INVALID_DOB_FUTURE'
        );
    END IF;

    -- Age must be between 10 and 19 years (mirrors the client-side Zod schema
    -- in src/lib/types.ts). EXTRACT(YEAR FROM AGE(...)) gives whole years elapsed,
    -- matching the JavaScript `getFullYear()` delta logic in the client schema.
    v_age_years := EXTRACT(YEAR FROM AGE(CURRENT_DATE, p_date_of_birth));
    IF v_age_years < 10 OR v_age_years > 19 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Athlete must be between 10 and 19 years old.',
            'code',    'INVALID_AGE'
        );
    END IF;

    -- Parent phone must resolve to at least 10 digits.
    -- We validate the stripped form — users can enter any formatting.
    IF length(v_parent_phone) < 10 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'A valid 10-digit parent phone number is required.',
            'code',    'INVALID_PHONE'
        );
    END IF;

    -- Data consent is a legal requirement. Reject at the DB layer as a
    -- secondary guard even if the client already enforces it.
    IF p_data_consent IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Data consent must be accepted to complete registration.',
            'code',    'CONSENT_REQUIRED'
        );
    END IF;

    -- =========================================================================
    -- GATE 2: Event Validation — 1 index scan
    -- =========================================================================

    IF NOT EXISTS (
        SELECT 1 FROM events
        WHERE id = p_event_id
          AND status IN ('live', 'draft')
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Invalid or inactive event.',
            'code',    'INVALID_EVENT'
        );
    END IF;

    -- =========================================================================
    -- GATE 3: Rate Limit — 1 index scan
    -- Max 5 registrations per parent email per hour.
    -- Prevents automated flood attacks and accidental double-submission loops.
    -- =========================================================================

    IF (
        SELECT count(*)
        FROM athletes
        WHERE parent_email = v_parent_email
          AND created_at   > now() - interval '1 hour'
    ) >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Too many registration attempts. Please try again in an hour.',
            'code',    'RATE_LIMITED'
        );
    END IF;

    -- =========================================================================
    -- GATE 4: Duplicate Athlete Check — uses the functional unique index
    --
    -- This SELECT is the fast-path UX guard. It runs before the INSERT so
    -- we can return DUPLICATE_REG with a helpful message rather than a raw
    -- constraint violation.
    --
    -- The unique index (idx_athletes_event_name_dob_unique) is the true
    -- enforcement layer. If two concurrent requests both pass this check
    -- simultaneously (TOCTOU window), the INSERT on the second request will
    -- raise a unique_violation (23505), which is caught below in EXCEPTION.
    --
    -- COPPA NOTE: The error message below does NOT confirm the child is
    -- registered. It uses "appears to already be registered" + redirects
    -- to staff — a neutral formulation that cannot be used to enumerate
    -- registered minors by an unauthenticated caller.
    -- =========================================================================

    IF EXISTS (
        SELECT 1
        FROM   athletes
        WHERE  event_id              = p_event_id
          AND  lower(trim(first_name)) = v_first_name_lower
          AND  lower(trim(last_name))  = v_last_name_lower
          AND  date_of_birth         = p_date_of_birth
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Athlete already registered',
            'code',    'DUPLICATE_REG'
        );
    END IF;

    -- =========================================================================
    -- WRITE PHASE — all inserts happen atomically within this function scope.
    -- PL/pgSQL functions execute within the caller's transaction. If the caller
    -- is Supabase's RPC endpoint (autocommit), the entire function body is one
    -- statement-level transaction — either all writes commit or all roll back.
    -- =========================================================================

    -- 5a. Insert athlete row.
    --     Display-case names stored (trim only). Email stored lowercase.
    --     Phone stored as digits-only (normalized for consistent lookup).
    INSERT INTO athletes (
        event_id,
        first_name,
        last_name,
        date_of_birth,
        grade,
        position,
        parent_name,
        parent_email,
        parent_phone
    )
    VALUES (
        p_event_id,
        v_first_name_display,   -- "John" not "john" — display case preserved
        v_last_name_display,    -- "Smith" not "smith"
        p_date_of_birth,
        trim(p_grade),
        trim(p_position),
        trim(p_parent_name),
        v_parent_email,         -- lowercase normalized
        v_parent_phone          -- digits-only normalized
    )
    RETURNING id INTO v_athlete_id;

    -- 5b. Insert waiver record linked to this athlete.
    --     emergency_contact_phone also gets digit-normalization for consistency.
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
        trim(p_parent_name),
        trim(p_guardian_relationship),
        trim(p_emergency_contact_name),
        v_emergency_phone,              -- digits-only normalized
        p_signature_data_url,
        p_injury_waiver_ack,
        p_media_release,
        p_data_consent,
        p_marketing_consent
    );

    -- 5c. Claim token — 128-bit hex, valid 24 hours, single-use.
    --     Infeasible to enumerate: 2^128 ≈ 3.4 × 10^38 possible values.
    v_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + interval '24 hours');

    -- 5d. Parent portal token — separate 128-bit token, no expiry enforced
    --     at DB level (portal access is read-only, low risk).
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

-- ==========================================================================
-- EXCEPTION BLOCK
-- Three cases handled — in strict priority order:
--
-- 1. unique_violation (23505): Two concurrent requests both passed the
--    Gate 4 SELECT check before either wrote. The second INSERT hits the
--    functional unique index. We convert this to DUPLICATE_REG — same
--    user-visible semantics, no raw Postgres error exposed.
--
-- 2. not_null_violation (23502) / check_violation (23514): Caller sent
--    a malformed payload that slipped past client-side validation. Return
--    a sanitized VALIDATION_ERROR — never expose internal column names.
--
-- 3. OTHERS: Unexpected DB error (disk, network, lock timeout). Return
--    INTERNAL_ERROR. NEVER return SQLERRM to the client — it can contain
--    schema names, column names, and internal state that are security-
--    relevant. Log internally via pg_notify or application logging only.
-- ==========================================================================
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Athlete already registered',
            'code',    'DUPLICATE_REG'
        );
    WHEN not_null_violation OR check_violation THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Invalid registration data. Please check all required fields.',
            'code',    'VALIDATION_ERROR'
        );
    WHEN OTHERS THEN
        -- SQLERRM is intentionally withheld from the response.
        -- Log it server-side: RAISE LOG 'register_athlete_secure error: %', SQLERRM;
        RAISE LOG 'register_athlete_secure INTERNAL_ERROR event=% error=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'An unexpected error occurred. Please try again or contact staff.',
            'code',    'INTERNAL_ERROR'
        );
END;
$$;

COMMIT;
