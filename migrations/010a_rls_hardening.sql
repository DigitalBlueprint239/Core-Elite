-- =============================================================================
-- MIGRATION 010a: RLS hardening — strict tenant isolation
-- Core Elite Combine 2026 · Mission "Live-Fire RLS Lockdown"
-- =============================================================================
--
-- FILENAME NOTE: spec asked for `migrations/010_rls_hardening.sql` but slot
-- `010_security_hardening.sql` was already taken by the prior security pass.
-- Using `010a` preserves lexical-order sequential application, matching the
-- convention used for 007a / 008a / 009a in earlier missions.
--
-- WHY this exists:
--   The system is entering a live-fire combine environment with multiple
--   organizations onboarded. The pre-existing org-scoped policy from mig
--   012 contained a backwards-compat carve-out:
--
--       organization_id IN (...) OR organization_id IS NULL
--
--   That `OR organization_id IS NULL` is a tenant-isolation backdoor —
--   any row with a NULL org_id is visible to every authenticated user
--   regardless of which tenant they belong to. This migration closes
--   that hole and explicitly denies cross-tenant reads / writes on the
--   four mission-critical tables.
--
-- WHAT this does:
--   1. Adds events.is_public BOOLEAN NOT NULL DEFAULT false. The single
--      authoritative gate for the public-leaderboard carve-out: rows
--      flagged is_public=true are readable by anon callers; everything
--      else requires authenticated tenant-matched access.
--   2. Installs two SECURITY DEFINER helper functions:
--        auth_user_organization_id()           — caller's org from JWT/profile
--        event_belongs_to_user_organization()  — cross-table join helper
--      Both run with elevated privilege so they bypass the RLS we are
--      installing — necessary, otherwise the policies would be self-
--      referential and unevaluable.
--   3. Force-enables RLS on results, athletes, events, organizations.
--   4. Drops the loose org-scoped policies installed by migs 011/012/016
--      and replaces them with strict tenant-isolation policies (no NULL-
--      org fallthrough, no auth.role()='authenticated'-only gates).
--   5. Adds narrowly-scoped anonymous SELECT policies for is_public events.
--
-- ANTI-PATTERN COMPLIANCE:
--   - ❌ Generic `auth.role() = 'authenticated'` policies → every authed
--        policy combines the role check with an organization_id match.
--   - ❌ Disabling RLS → every ALTER TABLE here ENABLEs (idempotent).
--   - ❌ Breaking submit_result_secure → preserved. The RPC is
--        SECURITY DEFINER, so its INSERT bypasses these RLS policies on
--        behalf of the authenticated caller. The RPC's own gate logic
--        (mig 015 composite uniqueness, mig 018 rate limiting, mig 024
--        RPC versioning DLQ, mig 007a source_type validation) provides
--        application-level tenant isolation — see the COMMENT block at
--        the bottom of this migration.
--
-- IDEMPOTENCY: every statement is `IF NOT EXISTS` / `IF EXISTS` /
-- `CREATE OR REPLACE` / DROP-then-CREATE. Re-running this migration after
-- a successful first apply is a clean no-op.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. events.is_public — the single authoritative gate for anon SELECT
-- ---------------------------------------------------------------------------
--
-- Defaults to false so that adding the column doesn't silently expose any
-- row. Operators must explicitly opt an event into the public leaderboard
-- (and that flip is itself audited via the events table's own audit log).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN events.is_public IS
  'When true, results / athletes for this event are readable by anonymous ' ||
  'callers via the public-leaderboard policy (mig 010a). Default false — ' ||
  'opt-in only.';

-- ---------------------------------------------------------------------------
-- 2. Helper functions — SECURITY DEFINER so the policies that consume them
--    can call them without recursing into the very RLS rules being defined.
-- ---------------------------------------------------------------------------

-- Returns the caller's organization_id from the profiles table.
-- STABLE: same answer for the duration of a single statement (PG can
-- inline / cache). NULL when the caller has no profile (e.g. anon).
CREATE OR REPLACE FUNCTION auth_user_organization_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM profiles WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION auth_user_organization_id() IS
  'Mission "Live-Fire RLS Lockdown": returns the caller''s organization_id ' ||
  'from profiles. SECURITY DEFINER so RLS policies can call it without ' ||
  'recursing. Returns NULL for anonymous callers — every consumer policy ' ||
  'must therefore combine this check with an explicit IS NOT NULL guard.';

-- Returns true iff the given event_id belongs to the caller's organization.
-- Used by athletes / results policies to derive tenant membership through
-- the natural FK chain.
CREATE OR REPLACE FUNCTION event_belongs_to_user_organization(p_event_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   events e
    WHERE  e.id              = p_event_id
      AND  e.organization_id IS NOT NULL
      AND  e.organization_id = auth_user_organization_id()
      AND  auth_user_organization_id() IS NOT NULL
  )
$$;

COMMENT ON FUNCTION event_belongs_to_user_organization(UUID) IS
  'Mission "Live-Fire RLS Lockdown": cross-table tenant gate. Returns true ' ||
  'iff the caller belongs to the same organization as the event referenced. ' ||
  'Both organization_id values must be NOT NULL — the legacy NULL-org ' ||
  'fallthrough from mig 012 is intentionally closed.';

-- ---------------------------------------------------------------------------
-- 3. Force-enable RLS on the four mission-critical tables
-- ---------------------------------------------------------------------------
--
-- Postgres treats ENABLE ROW LEVEL SECURITY as idempotent — calling it on
-- a table that already has RLS enabled is a safe no-op. We also FORCE row
-- security so even the table owner is subject to policies (defence in
-- depth — prevents accidental policy bypass by a misconfigured Supabase
-- service role).

ALTER TABLE results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE results       FORCE  ROW LEVEL SECURITY;

ALTER TABLE athletes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE athletes      FORCE  ROW LEVEL SECURITY;

ALTER TABLE events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE events        FORCE  ROW LEVEL SECURITY;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. organizations — admin-managed, tenant-scoped
-- ---------------------------------------------------------------------------
--
-- A user can SEE only their own organization row. Mutations are
-- restricted to platform admins (profiles.role = 'admin').

DROP POLICY IF EXISTS "Public Read Orgs"       ON organizations;
DROP POLICY IF EXISTS "Admin Manage Orgs"      ON organizations;
DROP POLICY IF EXISTS "org_self_select"        ON organizations;
DROP POLICY IF EXISTS "org_admin_manage"       ON organizations;

CREATE POLICY "org_self_select"
  ON organizations
  FOR SELECT
  TO authenticated
  USING (id = auth_user_organization_id() AND auth_user_organization_id() IS NOT NULL);

CREATE POLICY "org_admin_manage"
  ON organizations
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ---------------------------------------------------------------------------
-- 5. events — strict tenant scoping + public-flag carve-out
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Org-scoped event access"     ON events;
DROP POLICY IF EXISTS "events_public_read"          ON events;
DROP POLICY IF EXISTS "events_tenant_select"        ON events;
DROP POLICY IF EXISTS "events_tenant_modify"        ON events;
DROP POLICY IF EXISTS "events_anon_public_select"   ON events;

-- Authenticated tenant SELECT — strict org match, NO NULL fallthrough.
CREATE POLICY "events_tenant_select"
  ON events
  FOR SELECT
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND auth_user_organization_id() IS NOT NULL
    AND organization_id = auth_user_organization_id()
  );

-- Authenticated tenant INSERT/UPDATE/DELETE — same gate, with WITH CHECK
-- so a write cannot mutate organization_id to a foreign tenant.
CREATE POLICY "events_tenant_modify"
  ON events
  FOR ALL
  TO authenticated
  USING (
    organization_id IS NOT NULL
    AND auth_user_organization_id() IS NOT NULL
    AND organization_id = auth_user_organization_id()
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND auth_user_organization_id() IS NOT NULL
    AND organization_id = auth_user_organization_id()
  );

-- Anonymous SELECT — only events explicitly flagged is_public.
CREATE POLICY "events_anon_public_select"
  ON events
  FOR SELECT
  TO anon
  USING (is_public = true);

-- ---------------------------------------------------------------------------
-- 6. athletes — derive tenant membership through events.organization_id
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Public can view athletes"        ON athletes;
DROP POLICY IF EXISTS "Authenticated can view athletes" ON athletes;
DROP POLICY IF EXISTS "athletes_tenant_select"          ON athletes;
DROP POLICY IF EXISTS "athletes_tenant_modify"          ON athletes;
DROP POLICY IF EXISTS "athletes_anon_public_select"     ON athletes;

CREATE POLICY "athletes_tenant_select"
  ON athletes
  FOR SELECT
  TO authenticated
  USING (event_belongs_to_user_organization(event_id));

CREATE POLICY "athletes_tenant_modify"
  ON athletes
  FOR ALL
  TO authenticated
  USING      (event_belongs_to_user_organization(event_id))
  WITH CHECK (event_belongs_to_user_organization(event_id));

-- Anonymous SELECT — narrow read for is_public events only. Anonymous
-- callers see athletes for public events (e.g. parent leaderboard view)
-- but cannot read across the rest of the tenant.
CREATE POLICY "athletes_anon_public_select"
  ON athletes
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE  e.id = athletes.event_id
        AND  e.is_public = true
    )
  );

-- ---------------------------------------------------------------------------
-- 7. results — same pattern as athletes
-- ---------------------------------------------------------------------------
--
-- Note: submit_result_secure (SECURITY DEFINER) bypasses these policies
-- when inserting on behalf of authenticated staff. The RPC's own gate
-- chain (auth.role() check + composite uniqueness + suspicious-duplicate
-- detection + source_type CHECK) enforces tenant isolation at the
-- application layer. See the comment block at the bottom of this file.

DROP POLICY IF EXISTS "Public can view results"        ON results;
DROP POLICY IF EXISTS "Authenticated can view results" ON results;
DROP POLICY IF EXISTS "Authenticated can insert results" ON results;
DROP POLICY IF EXISTS "results_tenant_select"          ON results;
DROP POLICY IF EXISTS "results_tenant_modify"          ON results;
DROP POLICY IF EXISTS "results_anon_public_select"     ON results;

CREATE POLICY "results_tenant_select"
  ON results
  FOR SELECT
  TO authenticated
  USING (event_belongs_to_user_organization(event_id));

CREATE POLICY "results_tenant_modify"
  ON results
  FOR ALL
  TO authenticated
  USING      (event_belongs_to_user_organization(event_id))
  WITH CHECK (event_belongs_to_user_organization(event_id));

CREATE POLICY "results_anon_public_select"
  ON results
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM events e
      WHERE  e.id = results.event_id
        AND  e.is_public = true
    )
  );

-- ---------------------------------------------------------------------------
-- 8. submit_result_secure — non-modification audit trail
-- ---------------------------------------------------------------------------
--
-- The RPC is SECURITY DEFINER (since hardening_migration.sql), updated by
-- migs 007 / 008 / 009 / 015 / 018 / 019 / 007a (source_type) /
-- 008a (HLC) / 024 / 025 (versioning matrix). Its INSERT runs with the
-- function owner's privileges, bypassing RLS on `results`. That is the
-- correct architecture for an offline-sync RPC: the RPC enforces tenant
-- isolation in PL/pgSQL (auth.role(), event/athlete/band relational
-- consistency, source_type CHECK domain) and the RLS policies above
-- guard the direct-table SELECT/UPDATE paths that browser clients use
-- for live reads.
--
-- This migration does NOT redefine submit_result_secure — touching the
-- function would risk regressing the RPC versioning matrix. The
-- function's behaviour is verified intact by the test suite under
-- src/lib/__tests__/sync-determinism.test.ts.

-- Attach the SECURITY DEFINER preservation note to every existing
-- submit_result_secure overload (named-param adapter + JSONB router from
-- mig 024). DO block is defensive: the function signatures evolve across
-- migs 007/008/015/018/019/024/025/007a/008a, and we don't want this
-- migration to fail just because one historical signature happens not to
-- be installed in the target database.
DO $$
DECLARE
    v_signature TEXT;
    v_comment   TEXT := 'Mission "Live-Fire RLS Lockdown": SECURITY DEFINER preserved. ' ||
                        'The RPC bypasses RLS on its INSERT — application-level tenant ' ||
                        'isolation comes from the auth.role() gate, the event/athlete/band ' ||
                        'relational chain, and the source_type CHECK constraint. Browser ' ||
                        'clients reading results directly are gated by results_tenant_select ' ||
                        '/ results_anon_public_select.';
BEGIN
    FOR v_signature IN
        SELECT p.oid::regprocedure::text
        FROM   pg_proc      p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'public'
          AND  p.proname = 'submit_result_secure'
    LOOP
        EXECUTE format('COMMENT ON FUNCTION %s IS %L', v_signature, v_comment);
    END LOOP;
END $$;

COMMIT;
