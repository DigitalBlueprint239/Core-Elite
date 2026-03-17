-- Migration: 005_incident_logging.sql
-- Description: Table for logging incidents at stations

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id),
    station_id UUID REFERENCES stations(id),
    athlete_id UUID REFERENCES athletes(id),
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    type TEXT NOT NULL, -- e.g., 'injury', 'equipment', 'behavior', 'other'
    description TEXT NOT NULL,
    recorded_by UUID REFERENCES profiles(id),
    recorded_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT
);

-- Enable RLS
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Staff Can Insert Incidents" ON incidents;
CREATE POLICY "Staff Can Insert Incidents" ON incidents FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Admin Full Access Incidents" ON incidents;
CREATE POLICY "Admin Full Access Incidents" ON incidents FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_incidents_event ON incidents(event_id);
CREATE INDEX IF NOT EXISTS idx_incidents_athlete ON incidents(athlete_id);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
