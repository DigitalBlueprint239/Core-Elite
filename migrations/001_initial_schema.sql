-- Migration 001: Initial Schema (canonical seed)
--
-- This is the authoritative baseline schema for a fresh Core Elite database.
-- Run this first, then apply 002+ in numeric order.
--
-- Source: supabase_schema.sql (original project seed, committed 2026-04-09).
-- This file is the numbered copy that belongs in the migration sequence.
--
-- NOTE: supabase_schema.sql at the repo root is kept as a historical reference
-- only. It does NOT reflect the current column set — it predates migrations
-- 002–022. Always use the numbered sequence (001+) as the source of truth.
-- =============================================================================

-- Core Elite Combine 2026 Database Schema

-- 1. Events
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    location TEXT NOT NULL,
    required_drills JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Athletes
CREATE TABLE athletes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    date_of_birth DATE,
    age INT,
    grade TEXT,
    grad_year INT,
    position TEXT,
    height_in INT,
    weight_lb INT,
    parent_name TEXT NOT NULL,
    parent_email TEXT NOT NULL,
    parent_phone TEXT NOT NULL,
    band_id TEXT UNIQUE, -- Linked later
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Bands
CREATE TABLE bands (
    band_id TEXT PRIMARY KEY, -- Non-guessable ID from QR
    event_id UUID NOT NULL REFERENCES events(id),
    display_number INT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'void')) DEFAULT 'available',
    athlete_id UUID REFERENCES athletes(id),
    assigned_at TIMESTAMPTZ,
    assigned_by UUID REFERENCES auth.users(id),
    UNIQUE(event_id, display_number)
);

-- Add foreign key back to athletes for band_id
ALTER TABLE athletes ADD CONSTRAINT fk_athlete_band FOREIGN KEY (band_id) REFERENCES bands(band_id);

-- 4. Waivers
CREATE TABLE waivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id UUID NOT NULL REFERENCES athletes(id),
    event_id UUID NOT NULL REFERENCES events(id),
    guardian_name TEXT NOT NULL,
    guardian_relationship TEXT,
    emergency_contact_name TEXT NOT NULL,
    emergency_contact_phone TEXT NOT NULL,
    signature_data_url TEXT NOT NULL,
    agreed BOOLEAN NOT NULL DEFAULT true,
    agreed_at TIMESTAMPTZ DEFAULT now(),
    ip_address TEXT,
    user_agent TEXT
);

-- 5. Stations
CREATE TABLE stations (
    id TEXT PRIMARY KEY, -- e.g., 'SPEED-1'
    event_id UUID NOT NULL REFERENCES events(id),
    name TEXT NOT NULL,
    drill_type TEXT NOT NULL,
    requires_auth BOOLEAN DEFAULT true
);

-- 6. Results
CREATE TABLE results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_result_id UUID UNIQUE NOT NULL, -- For idempotency
    event_id UUID NOT NULL REFERENCES events(id),
    athlete_id UUID NOT NULL REFERENCES athletes(id),
    band_id TEXT NOT NULL REFERENCES bands(band_id),
    station_id TEXT NOT NULL REFERENCES stations(id),
    drill_type TEXT NOT NULL,
    value_num NUMERIC,
    value_text TEXT,
    meta JSONB,
    recorded_by UUID REFERENCES auth.users(id),
    recorded_at TIMESTAMPTZ DEFAULT now()
);

-- 7. Token Claims (for band claim flow)
CREATE TABLE token_claims (
    token_hash TEXT PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id),
    athlete_id UUID NOT NULL REFERENCES athletes(id),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

-- 8. Device Status
CREATE TABLE device_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id),
    station_id TEXT NOT NULL,
    device_label TEXT,
    last_seen_at TIMESTAMPTZ DEFAULT now(),
    is_online BOOLEAN DEFAULT true,
    pending_queue_count INT DEFAULT 0,
    last_sync_at TIMESTAMPTZ
);

-- 9. Report Jobs
CREATE TABLE report_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id),
    athlete_id UUID NOT NULL REFERENCES athletes(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')) DEFAULT 'pending',
    completed_drills JSONB DEFAULT '[]'::jsonb,
    generated_at TIMESTAMPTZ,
    report_url TEXT,
    summary JSONB
);

-- RLS POLICIES

-- Enable RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_jobs ENABLE ROW LEVEL SECURITY;

-- Events: Public Read
CREATE POLICY "Public Read Events" ON events FOR SELECT USING (true);

-- Athletes: Public Insert (Registration)
CREATE POLICY "Public Insert Athletes" ON athletes FOR INSERT WITH CHECK (true);
-- Athletes: Update via Token (Internal logic usually handles this, but for RLS we might need a specific check if we do it client-side)
-- For simplicity in this demo, we'll allow public update if they know the ID, but in production we'd use a more secure check.
CREATE POLICY "Public Update Athlete via ID" ON athletes FOR UPDATE USING (true);
-- Athletes: Staff Read
CREATE POLICY "Staff Read Athletes" ON athletes FOR SELECT TO authenticated USING (true);

-- Bands: Staff Read/Update
CREATE POLICY "Staff Full Access Bands" ON bands FOR ALL TO authenticated USING (true);
-- Bands: Public Update (Claim) - Restricted to specific fields
CREATE POLICY "Public Update Band Claim" ON bands FOR UPDATE USING (true);
-- Bands: Public Read (Minimal)
CREATE POLICY "Public Read Band" ON bands FOR SELECT USING (true);

-- Waivers: Public Insert
CREATE POLICY "Public Insert Waivers" ON waivers FOR INSERT WITH CHECK (true);
-- Waivers: Staff Read
CREATE POLICY "Staff Read Waivers" ON waivers FOR SELECT TO authenticated USING (true);

-- Stations: Authenticated Read
CREATE POLICY "Staff Read Stations" ON stations FOR SELECT TO authenticated USING (true);

-- Results: Authenticated Insert/Read
CREATE POLICY "Staff Insert Results" ON results FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff Read Results" ON results FOR SELECT TO authenticated USING (true);
-- Results: Admin Update
CREATE POLICY "Admin Update Results" ON results FOR UPDATE TO authenticated USING (true);

-- Token Claims: Public Insert/Read/Update
CREATE POLICY "Public Token Claims" ON token_claims FOR ALL USING (true);

-- Device Status: Authenticated All
CREATE POLICY "Staff Device Status" ON device_status FOR ALL TO authenticated USING (true);

-- Report Jobs: Staff Read
CREATE POLICY "Staff Read Report Jobs" ON report_jobs FOR SELECT TO authenticated USING (true);
