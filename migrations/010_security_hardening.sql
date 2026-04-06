-- =============================================================================
-- MIGRATION 010: Security Hardening — RLS Lockdown
-- Core Elite Combine 2026
-- =============================================================================
--
-- SECURITY MODEL:
--   All public-facing mutations go through SECURITY DEFINER RPCs.
--   Direct table mutations from unauthenticated clients are blocked by RLS.
--   Authenticated staff/admin mutations use role-based policies.
--   Read access is open for athletes/bands (needed for public-facing pages)
--   but restricted for results/waivers.
--
-- RPC surface (all SECURITY DEFINER — bypass RLS internally):
--   register_athlete_secure  — athlete + waiver + token_claim creation
--   claim_band_atomic        — band claim with FOR UPDATE locking
--   submit_result_secure     — result insertion with idempotency check
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. DROP dangerously permissive base policies
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Insert Athletes"       ON athletes;
DROP POLICY IF EXISTS "Public Update Athlete via ID" ON athletes;
DROP POLICY IF EXISTS "Public Update Band Claim"     ON bands;
DROP POLICY IF EXISTS "Public Token Claims"          ON token_claims;
DROP POLICY IF EXISTS "Public Insert Waivers"        ON waivers;

-- -----------------------------------------------------------------------------
-- 2. ATHLETES
--    Public SELECT remains open — parent portal and lookup pages need it.
--    All INSERT/UPDATE go through register_athlete_secure / claim_band_atomic.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Read Own Athlete" ON athletes;
CREATE POLICY "Public Read Own Athlete"
  ON athletes FOR SELECT
  USING (true);

-- -----------------------------------------------------------------------------
-- 3. TOKEN CLAIMS
--    No public policy at all. RPCs (SECURITY DEFINER) handle all operations.
--    Unauthenticated clients cannot read, write, or enumerate tokens.
-- -----------------------------------------------------------------------------
-- (intentionally no new public policy)

-- -----------------------------------------------------------------------------
-- 4. BANDS
--    Public can read band metadata (display_number, status) for the lookup flow.
--    All UPDATE operations handled exclusively by claim_band_atomic RPC.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Read Band" ON bands;
CREATE POLICY "Public Read Band"
  ON bands FOR SELECT
  USING (true);

-- -----------------------------------------------------------------------------
-- 5. WAIVERS
--    No public direct insert. Handled atomically by register_athlete_secure.
-- -----------------------------------------------------------------------------
-- (intentionally no new public policy)

-- -----------------------------------------------------------------------------
-- 6. RESULTS
--    Existing "Staff Insert Results" and "Staff Read Results" policies are
--    correct. Public has zero access — result data is PII for minors.
-- -----------------------------------------------------------------------------
-- (existing policies from migrations/002 are correct — no change)

-- -----------------------------------------------------------------------------
-- 7. PARENT PORTALS
--    Token-based public read remains. Policy from migrations/004 is correct.
-- -----------------------------------------------------------------------------
-- (existing policy is correct — no change)

-- -----------------------------------------------------------------------------
-- 8. Verify RLS is enabled on all sensitive tables (idempotent)
-- -----------------------------------------------------------------------------
ALTER TABLE athletes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bands         ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_claims  ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_portals ENABLE ROW LEVEL SECURITY;
