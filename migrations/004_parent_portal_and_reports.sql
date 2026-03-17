-- Migration: 004_parent_portal_and_reports.sql
-- Description: Tables for parent portal and report generation

-- 1. Parent Portals Table
CREATE TABLE IF NOT EXISTS parent_portals (
    athlete_id UUID PRIMARY KEY REFERENCES athletes(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES events(id),
    portal_token TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Report Jobs Table
CREATE TABLE IF NOT EXISTS report_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES events(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    report_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE parent_portals ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_jobs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for Parent Portals
-- Token-based access: anyone with the correct token can read
DROP POLICY IF EXISTS "Public Token Access Parent Portal" ON parent_portals;
CREATE POLICY "Public Token Access Parent Portal" ON parent_portals FOR SELECT USING (true);

-- RLS Policies for Report Jobs
-- Only admins can see all jobs; parents can see their own via athlete_id if we join
DROP POLICY IF EXISTS "Admin Full Access Report Jobs" ON report_jobs;
CREATE POLICY "Admin Full Access Report Jobs" ON report_jobs FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

DROP POLICY IF EXISTS "Public Read Report Job via Token" ON report_jobs;
CREATE POLICY "Public Read Report Job via Token" ON report_jobs FOR SELECT USING (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_parent_portals_token ON parent_portals(portal_token);
CREATE INDEX IF NOT EXISTS idx_report_jobs_athlete ON report_jobs(athlete_id);
