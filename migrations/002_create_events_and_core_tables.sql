-- Migration: 002_create_events_and_core_tables.sql
-- Description: Ensures core tables exist for Core Elite Combine 2026

-- 1. Events Table
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed')),
    required_drills JSONB NOT NULL DEFAULT '[]'::jsonb,
    age_groups JSONB NOT NULL DEFAULT '["8-10", "11-13", "14-17"]'::jsonb,
    wave_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Profiles Table
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    full_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Athletes Table
CREATE TABLE IF NOT EXISTS athletes (
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
    band_id TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Bands Table
CREATE TABLE IF NOT EXISTS bands (
    band_id TEXT PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id),
    display_number INT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'void')) DEFAULT 'available',
    athlete_id UUID REFERENCES athletes(id),
    assigned_at TIMESTAMPTZ,
    assigned_by UUID REFERENCES auth.users(id),
    UNIQUE(event_id, display_number)
);

-- 5. Waivers Table
CREATE TABLE IF NOT EXISTS waivers (
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

-- 6. Stations Table
CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id),
    name TEXT NOT NULL,
    drill_type TEXT NOT NULL,
    lane_count INT DEFAULT 1,
    enabled BOOLEAN DEFAULT true,
    requires_auth BOOLEAN DEFAULT true,
    notes TEXT
);

-- 7. Results Table
CREATE TABLE IF NOT EXISTS results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_result_id UUID UNIQUE NOT NULL,
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

-- 8. Token Claims Table
CREATE TABLE IF NOT EXISTS token_claims (
    token_hash TEXT PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES events(id),
    athlete_id UUID NOT NULL REFERENCES athletes(id),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

-- Enable RLS on all tables
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_claims ENABLE ROW LEVEL SECURITY;

-- RLS Policies for Events
DROP POLICY IF EXISTS "Public Read Events" ON events;
CREATE POLICY "Public Read Events" ON events FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins have full access to events" ON events;
CREATE POLICY "Admins have full access to events" ON events FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- RLS Policies for Profiles
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON profiles;
CREATE POLICY "Public profiles are viewable by everyone." ON profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile." ON profiles;
CREATE POLICY "Users can insert their own profile." ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile." ON profiles;
CREATE POLICY "Users can update own profile." ON profiles FOR UPDATE USING (auth.uid() = id);

-- Athletes Policies
DROP POLICY IF EXISTS "Public Insert Athletes" ON athletes;
CREATE POLICY "Public Insert Athletes" ON athletes FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Public Update Athlete via ID" ON athletes;
CREATE POLICY "Public Update Athlete via ID" ON athletes FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Staff Read Athletes" ON athletes;
CREATE POLICY "Staff Read Athletes" ON athletes FOR SELECT TO authenticated USING (true);

-- Waivers Policies
DROP POLICY IF EXISTS "Public Insert Waivers" ON waivers;
CREATE POLICY "Public Insert Waivers" ON waivers FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Staff Read Waivers" ON waivers;
CREATE POLICY "Staff Read Waivers" ON waivers FOR SELECT TO authenticated USING (true);

-- Stations Policies
DROP POLICY IF EXISTS "Staff Read Stations" ON stations;
CREATE POLICY "Staff Read Stations" ON stations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins have full access to stations" ON stations;
CREATE POLICY "Admins have full access to stations" ON stations FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Results Policies
DROP POLICY IF EXISTS "Staff Insert Results" ON results;
CREATE POLICY "Staff Insert Results" ON results FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Staff Read Results" ON results;
CREATE POLICY "Staff Read Results" ON results FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admin Update Results" ON results;
CREATE POLICY "Admin Update Results" ON results FOR UPDATE TO authenticated USING (true);

-- Token Claims Policies
DROP POLICY IF EXISTS "Public Token Claims" ON token_claims;
CREATE POLICY "Public Token Claims" ON token_claims FOR ALL USING (true);

-- Bands Policies
DROP POLICY IF EXISTS "Staff Full Access Bands" ON bands;
CREATE POLICY "Staff Full Access Bands" ON bands FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "Public Update Band Claim" ON bands;
CREATE POLICY "Public Update Band Claim" ON bands FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Public Read Band" ON bands;
CREATE POLICY "Public Read Band" ON bands FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admins have full access to bands" ON bands;
CREATE POLICY "Admins have full access to bands" ON bands FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);
