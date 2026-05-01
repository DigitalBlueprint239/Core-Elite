-- =============================================================================
-- MIGRATION 016a: Athlete Lookup RPC + Public-Read Eradication
-- Core Elite Combine 2026 · Mission "lookup_athlete_by_phone"
-- =============================================================================
--
-- FILENAME NOTE: the mission spec asked for `migrations/016_athlete_lookup_rpc.sql`
-- but slot `016_tier1_data_hardening.sql` is already taken by the Tier-1 data
-- hardening work (DOB constraints, parent-email format, dedup unique index).
-- Per the established 007a/008a/009a/010a/011a convention used everywhere
-- else in this repo, we use `016a` so the lexical sort still applies the
-- migrations in the correct order (016 → 016a → 017).
--
-- WHY this exists:
--   The /lookup page lets parents type a phone number and receive their
--   child's wristband number. Until this migration, the page hit the
--   `athletes` table directly via `supabase.from('athletes').select(...)`
--   which required a permissive RLS policy. The original `Public Read Own
--   Athlete` policy (mig 010, line 33–36) granted `USING (true)` SELECT to
--   the default/public role — meaning any anonymous client could enumerate
--   the entire athletes table, scrape parent_phone, parent_email, DOB, and
--   build a contact list. That is a single-policy data breach.
--
-- WHAT this does:
--   1. Drops the `Public Read Own Athlete` USING(true) policy so anon/public
--      can no longer issue arbitrary SELECTs against `athletes`.
--   2. Creates `athlete_lookup_attempts` — an append-only ledger that backs
--      the rate-limit gate inside the RPC (max 10 attempts per phone per
--      5-minute window). RLS is enabled with no public/anon policies; only
--      the SECURITY DEFINER RPC writes here.
--   3. Creates `lookup_athlete_by_phone(p_phone TEXT, p_event_id UUID)` —
--      the only sanctioned public path to athlete data on this page.
--      • SECURITY DEFINER with explicit `SET search_path = public, pg_temp`
--        to neutralize search-path injection.
--      • Validates phone format (10 digits, normalized server-side).
--      • Enforces the rate limit before any read.
--      • Returns ONLY {id, first_name, last_name, event_id, band_display} —
--        deliberately omits parent_phone, parent_email, DOB, position,
--        height/weight, etc. so a successful call exposes the minimum
--        needed to identify a wristband.
--      • Scoped to a single event via `p_event_id` so a parent must already
--        know which event their child is registered for; cross-event
--        scraping is blocked.
--   4. REVOKEs PUBLIC, GRANTs EXECUTE only to anon + authenticated.
--
-- WHAT this does NOT touch:
--   • `athletes_anon_public_select` (from 010a_rls_hardening.sql line 248):
--     this is narrowly scoped to is_public events via an EXISTS subquery —
--     it does NOT use `USING (true)` and falls outside the explicit
--     anti-pattern. The scout pages (Leaderboard, AthleteDetail) depend on
--     it and live outside Mission scope.
--   • `Staff Read Athletes` (TO authenticated USING (true)) and the
--     tenant-scoped policies installed by 010a — staff still need broad
--     read access via the admin app; the Mission anti-pattern explicitly
--     excludes authenticated roles.
--
-- IDEMPOTENCY: Re-runnable.
--   DROP POLICY IF EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT
--   EXISTS, CREATE OR REPLACE FUNCTION, REVOKE/GRANT are all idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop the USING(true) public SELECT policy on athletes.
--    This is the exact target the Mission anti-pattern names. Mig 010
--    installed it as a temporary bridge ("Public SELECT remains open —
--    parent portal and lookup pages need it"). The new RPC supersedes that
--    bridge.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Read Own Athlete" ON athletes;

-- Defensive: also drop any historical names that mig 002 / 001 may have
-- installed under different casings. None of these should still exist on a
-- fully-migrated database; the IF EXISTS guard makes the line a no-op when
-- they don't.
DROP POLICY IF EXISTS "Public Read Athletes"     ON athletes;
DROP POLICY IF EXISTS "Public Insert Athletes"   ON athletes;

-- ---------------------------------------------------------------------------
-- 2. Rate-limit ledger.
--    Append-only. The RPC inserts one row per attempt and counts rows in
--    the trailing 5-minute window. Service role + the SECURITY DEFINER RPC
--    are the only writers; no anon/public/authenticated policies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS athlete_lookup_attempts (
    id            BIGSERIAL PRIMARY KEY,
    phone_digits  TEXT        NOT NULL,
    event_id      UUID,
    attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    matched_count INT
);

-- Hot path: WHERE phone_digits = $1 AND attempted_at > now() - interval '...'
-- The trailing recorded_at DESC lets the LIMIT 1 / count(*) seek directly.
CREATE INDEX IF NOT EXISTS idx_athlete_lookup_attempts_phone_time
    ON athlete_lookup_attempts (phone_digits, attempted_at DESC);

ALTER TABLE athlete_lookup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE athlete_lookup_attempts FORCE  ROW LEVEL SECURITY;
-- (Intentionally NO policies. SECURITY DEFINER RPC + service role only.)

-- ---------------------------------------------------------------------------
-- 3. lookup_athlete_by_phone — the only sanctioned public read path.
--
--    Return shape is fixed to the Mission spec:
--        id, first_name, last_name, event_id, band_display
--    Anything beyond that (parent_phone, parent_email, DOB, position,
--    height/weight) is excluded by design.
--
--    `SET search_path = public, pg_temp` is mandatory for SECURITY DEFINER
--    functions that reference unqualified relation names — without it a
--    malicious caller with CREATE on a temp/parallel schema could shadow
--    `athletes` / `bands` and harvest writes. `pg_temp` is appended last
--    per the standard CVE-2018-1058 mitigation pattern.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lookup_athlete_by_phone(
    p_phone    TEXT,
    p_event_id UUID
)
RETURNS TABLE (
    id           UUID,
    first_name   TEXT,
    last_name    TEXT,
    event_id     UUID,
    band_display TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_digits          TEXT;
    v_recent_attempts INT;
BEGIN
    -- ── Input validation ─────────────────────────────────────────────────────
    IF p_phone IS NULL OR p_event_id IS NULL THEN
        RAISE EXCEPTION 'phone and event_id are required'
              USING ERRCODE = '22023'; -- invalid_parameter_value
    END IF;

    -- Normalize: strip every non-digit. Defense in depth — the client also
    -- normalizes, but never trust client-side stripping.
    v_digits := regexp_replace(p_phone, '\D', '', 'g');

    IF length(v_digits) <> 10 THEN
        RAISE EXCEPTION 'phone must contain exactly 10 digits'
              USING ERRCODE = '22023';
    END IF;

    -- ── Rate limit ───────────────────────────────────────────────────────────
    -- 10 attempts per phone per 5 minutes. Sized to absorb a parent
    -- mistyping a few times while shutting down a scraper that's iterating
    -- through area codes.
    SELECT count(*)
      INTO v_recent_attempts
      FROM athlete_lookup_attempts
     WHERE phone_digits = v_digits
       AND attempted_at > now() - interval '5 minutes';

    IF v_recent_attempts >= 10 THEN
        RAISE EXCEPTION 'rate limit exceeded — please try again in a few minutes'
              USING ERRCODE = '53400'; -- configuration_limit_exceeded
    END IF;

    -- Record the attempt BEFORE the SELECT so a successful flood still
    -- accrues against the limit (vs. only failed attempts).
    INSERT INTO athlete_lookup_attempts (phone_digits, event_id)
    VALUES (v_digits, p_event_id);

    -- ── Narrow read ──────────────────────────────────────────────────────────
    RETURN QUERY
    SELECT a.id,
           a.first_name,
           a.last_name,
           a.event_id,
           b.display_number::TEXT AS band_display
      FROM athletes a
      LEFT JOIN bands b
        ON b.band_id = a.band_id
     WHERE a.parent_phone = v_digits
       AND a.event_id     = p_event_id
     ORDER BY a.created_at DESC
     LIMIT 5;
END;
$$;

-- Lock down execution: no PUBLIC, only the two real roles that hit PostgREST.
REVOKE ALL    ON FUNCTION lookup_athlete_by_phone(TEXT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION lookup_athlete_by_phone(TEXT, UUID) TO anon, authenticated;

COMMENT ON FUNCTION lookup_athlete_by_phone(TEXT, UUID) IS
  'Public parent-portal lookup. Returns at most 5 athlete identity rows ' ||
  '(id, first_name, last_name, event_id, band_display) for a phone+event ' ||
  'pair. Rate-limited at 10/5min/phone via athlete_lookup_attempts. ' ||
  'SECURITY DEFINER + SET search_path defends against CVE-2018-1058.';

COMMIT;
