-- =============================================================================
-- MIGRATION 015: Composite Uniqueness Guard — Option B (UUID Idempotency)
-- Core Elite Combine 2026
-- =============================================================================
--
-- OPTION B RATIONALE (confirmed by system architect):
--   The time-windowed constraint (athlete_id, drill_type, date_trunc('minute'))
--   was rejected because it blocks legitimate rapid re-tests — e.g. a 40-yd
--   re-run within the same minute after a confirmed false start. That is a live-
--   event operational failure we cannot accept.
--
--   Option B uses client_result_id UUID uniqueness as the sole hard constraint.
--   A UUID v4 collision probability is ~2^-122 — effectively zero in any real
--   event context. The true deduplication problem is not UUID collisions; it is
--   staff accidentally submitting a second reading for the same athlete/drill
--   without incrementing the attempt counter (e.g. forgetting the first run,
--   re-scanning and submitting again). We call this a "suspicious duplicate."
--
-- TWO-LAYER DEFENCE:
--
--   Layer 1 — Hard constraint (DB):
--     client_result_id UUID UNIQUE NOT NULL  ← already exists (migration 002).
--     This migration gives it a stable, named constraint so application code
--     can catch error code '23505' with constraint name 'results_client_result_id_key'
--     for precise error routing. We also add a secondary named constraint here
--     for documentation and future index management.
--
--   Layer 2 — Advisory detection (RPC):
--     submit_result_secure now detects "suspicious duplicates" — same athlete,
--     same drill, within 120 seconds, with a value within 10% of a prior result
--     (but a different client_result_id, i.e. a genuine second submission).
--     It does NOT reject the record. It returns {status: 'suspicious_duplicate'}
--     with the conflicting record's details, allowing the client to present the
--     "Duplicate Record Challenge" modal and let the staff operator decide.
--     The record is held in the client outbox in 'pending_review' status until
--     the operator resolves it.
--
-- IDEMPOTENCY: Safe to run multiple times.
--   The UNIQUE constraint already exists — we name it here without recreating.
--   The CREATE INDEX uses IF NOT EXISTS.
--   The CREATE OR REPLACE FUNCTION is always idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Ensure the client_result_id unique constraint has a stable name.
--
-- Migration 002 created it inline as UUID UNIQUE — PostgreSQL auto-generates
-- a name like 'results_client_result_id_key'. We verify this and, if the
-- named constraint doesn't already exist under that name, add one explicitly.
--
-- Using DO $$ block so this doesn't error if the constraint already exists.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- Only create if no unique constraint on client_result_id exists yet.
    -- This is defensive: migration 002 already created it implicitly.
    IF NOT EXISTS (
        SELECT 1
        FROM   information_schema.table_constraints tc
        JOIN   information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
        WHERE  tc.table_name    = 'results'
          AND  tc.constraint_type = 'UNIQUE'
          AND  kcu.column_name  = 'client_result_id'
    ) THEN
        ALTER TABLE results
          ADD CONSTRAINT results_client_result_id_unique
          UNIQUE (client_result_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2: Supporting index for suspicious-duplicate detection.
--
-- The advisory detection query inside submit_result_secure does:
--   WHERE athlete_id  = p_athlete_id
--     AND drill_type  = p_drill_type
--     AND recorded_at > now() - interval '120 seconds'
--   ORDER BY recorded_at DESC
--   LIMIT 1
--
-- Without an index, this is a sequential scan. With 10,000+ results across a
-- busy combine day, this adds measurable latency to every result submission.
--
-- IMMUTABILITY CONSTRAINT:
--   PostgreSQL forbids volatile functions (now(), CURRENT_TIMESTAMP, random())
--   in CREATE INDEX predicates — managed Postgres providers (Supabase included)
--   reject such migrations at provisioning time with
--   `ERROR: functions in index predicate must be marked IMMUTABLE`.
--   The previous predicate `WHERE recorded_at > (now() - interval '24 hours')`
--   triggered exactly that failure on every fresh provision.
--
-- DESIGN:
--   Use a stable compound B-Tree on (athlete_id, drill_type, recorded_at DESC).
--   Postgres uses the leading two equality columns to seek and the trailing
--   recorded_at DESC to satisfy the ORDER BY ... LIMIT 1 directly from the
--   index — no sort, no heap scan beyond the single matching tuple. Bounding
--   `recorded_at > now() - interval '120 seconds'` becomes a cheap range scan
--   on the trailing index column, so the original hot-path latency goal is
--   preserved without any volatile predicate.
--
--   The optional `WHERE voided IS DISTINCT FROM true` predicate keeps the
--   index sparse: voided rows are explicitly excluded from suspicious-duplicate
--   detection (see the matching filter inside submit_result_secure below), so
--   they should not occupy index pages either. `IS DISTINCT FROM` correctly
--   handles NULL (Postgres treats `voided = false` and `voided IS NULL` as
--   "not voided"), and it is an immutable boolean expression — index-safe.
--
-- IF NOT EXISTS: idempotent.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_results_athlete_drill_time
    ON results (athlete_id, drill_type, recorded_at DESC)
    WHERE voided IS DISTINCT FROM true;

-- ---------------------------------------------------------------------------
-- Step 3: submit_result_secure v4 — adds suspicious-duplicate detection.
--
-- NEW RETURN CODES (in addition to existing):
--   status: 'duplicate'            — same client_result_id already exists (idempotency hit)
--   status: 'suspicious_duplicate' — different UUID, same athlete/drill/value window
--
-- SUSPICIOUS DUPLICATE CRITERIA (all must be true):
--   a. Different client_result_id (not an idempotency retry)
--   b. Same athlete_id and drill_type
--   c. Within 120 seconds of a prior result for this athlete/drill
--   d. Value is within 10% of the prior result
--      (a wildly different value suggests a legitimate re-test after error,
--       not an accidental double-submission)
--
-- When a suspicious duplicate is detected:
--   - The function returns success: false with status: 'suspicious_duplicate'
--     and the conflicting record's details
--   - The record is NOT inserted
--   - The client holds the record in outbox with status 'pending_review' and
--     presents the Duplicate Record Challenge modal
--   - Staff can then: keep both (re-submit with attempt_number incremented),
--     replace (void existing + re-submit), or discard new
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
    p_meta             JSONB   DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result_id          UUID;
    v_hlc                TEXT;
    v_validation_status  TEXT;
    v_suspicious         RECORD;   -- holds conflicting result if found
BEGIN
    -- ── Gate 0: Authentication ────────────────────────────────────────────────
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Unauthorized',
            'code',    'UNAUTHORIZED'
        );
    END IF;

    -- ── Gate 1: Idempotency (add-biased LWW) ─────────────────────────────────
    -- Same client_result_id = network retry of an already-committed write.
    -- Treat as success: the record is already in the DB, the client can
    -- remove it from the outbox.
    SELECT id INTO v_result_id
    FROM results
    WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success',   true,
            'result_id', v_result_id,
            'status',    'duplicate'
        );
    END IF;

    -- ── Gate 2: Suspicious duplicate detection ────────────────────────────────
    -- Detects accidental double-submission: a DIFFERENT client_result_id for
    -- the same athlete/drill within a suspicious time window with a similar value.
    --
    -- We only fire this gate if attempt_number = 1 (or the caller hasn't
    -- incremented it). If attempt_number > 1, the staff explicitly intends a
    -- second attempt — skip this check entirely.
    --
    -- The 10% value tolerance window catches: same run submitted twice (identical
    -- value), and minor timing variance from the same physical event recorded
    -- twice (e.g. two timers both stopped). It does NOT flag legitimate
    -- performance improvement between real attempts.

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
          -- Exclude voided records: a replaced result must not re-trigger the check
          AND (voided IS NULL OR voided = false)
          -- Value within 10% tolerance (symmetric)
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

    -- ── Write phase ───────────────────────────────────────────────────────────
    v_hlc := p_meta->>'hlc_timestamp';

    v_validation_status := CASE
        WHEN (p_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id,
        event_id,
        athlete_id,
        band_id,
        station_id,
        drill_type,
        value_num,
        attempt_number,
        meta,
        hlc_timestamp,
        validation_status,
        recorded_by
    )
    VALUES (
        p_client_result_id,
        p_event_id,
        p_athlete_id,
        p_band_id,
        p_station_id,
        p_drill_type,
        p_value_num,
        p_attempt_number,
        p_meta,
        v_hlc,
        v_validation_status,
        auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION
    -- Hard uniqueness violation (race condition between the Gate 1 SELECT and
    -- the INSERT). Treat as idempotency success — add-biased LWW guarantees
    -- we never discard a timing result in a race.
    WHEN unique_violation THEN
        SELECT id INTO v_result_id
        FROM results
        WHERE client_result_id = p_client_result_id;
        RETURN jsonb_build_object(
            'success',   true,
            'result_id', v_result_id,
            'status',    'duplicate'
        );
    WHEN OTHERS THEN
        RAISE LOG 'submit_result_secure error: athlete=% drill=% error=%',
                  p_athlete_id, p_drill_type, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error',   'An unexpected error occurred.',
            'code',    'INTERNAL_ERROR'
        );
END;
$$;

COMMIT;
