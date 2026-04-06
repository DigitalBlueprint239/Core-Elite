-- =============================================================================
-- MIGRATION 012: Multi-Tenant Organization Layer
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--   organizations table — multi-tenant org with white-label color/logo columns
--   events.organization_id — nullable FK for backwards compatibility
--   profiles.organization_id — staff belong to orgs
--   Default "Core Elite" org seeded for existing data
--   RLS: public read orgs, admin manage orgs, org-scoped event access
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Organizations table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  slug             TEXT UNIQUE NOT NULL,
  logo_url         TEXT,
  primary_color    TEXT DEFAULT '#18181b',
  secondary_color  TEXT DEFAULT '#c8a200',
  contact_email    TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. Add organization_id to events (nullable — existing rows unaffected)
-- -----------------------------------------------------------------------------
ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- -----------------------------------------------------------------------------
-- 3. Add organization_id to profiles (staff belong to an org)
-- -----------------------------------------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- -----------------------------------------------------------------------------
-- 4. Seed default Core Elite org for existing data
-- -----------------------------------------------------------------------------
INSERT INTO organizations (id, name, slug)
VALUES (gen_random_uuid(), 'Core Elite', 'core-elite')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. RLS on organizations
-- -----------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public Read Orgs"
  ON organizations FOR SELECT
  USING (true);

CREATE POLICY "Admin Manage Orgs"
  ON organizations FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- -----------------------------------------------------------------------------
-- 6. Org-scoped event access policy (SELECT only — mutations via RPCs)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Org-scoped event access" ON events;
CREATE POLICY "Org-scoped event access"
  ON events FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM profiles WHERE id = auth.uid()
    )
    OR organization_id IS NULL  -- backwards compatibility: unscoped events visible to all
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
