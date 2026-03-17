-- Migration for Module 1: Event Ops Control Panel

-- 1. Update events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'closed'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS age_groups JSONB DEFAULT '["8-10", "11-13", "14-17"]'::jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS wave_schedule JSONB DEFAULT '[]'::jsonb;

-- 2. Update stations table
ALTER TABLE stations ADD COLUMN IF NOT EXISTS lane_count INT DEFAULT 1;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3. Create profiles table for roles
CREATE TABLE IF NOT EXISTS profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    full_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Update RLS for profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON profiles;
CREATE POLICY "Public profiles are viewable by everyone." ON profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can insert their own profile." ON profiles;
CREATE POLICY "Users can insert their own profile." ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "Users can update own profile." ON profiles;
CREATE POLICY "Users can update own profile." ON profiles FOR UPDATE USING (auth.uid() = id);

-- 5. Update RLS for events/stations/bands to be Admin-only for mutations
DROP POLICY IF EXISTS "Admins have full access to events" ON events;
CREATE POLICY "Admins have full access to events" ON events FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

DROP POLICY IF EXISTS "Admins have full access to stations" ON stations;
CREATE POLICY "Admins have full access to stations" ON stations FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

DROP POLICY IF EXISTS "Admins have full access to bands" ON bands;
CREATE POLICY "Admins have full access to bands" ON bands FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);

-- Ensure public can still read events
DROP POLICY IF EXISTS "Public Read Events" ON events;
CREATE POLICY "Public Read Events" ON events FOR SELECT USING (true);

-- Staff read stations
DROP POLICY IF EXISTS "Staff Read Stations" ON stations;
CREATE POLICY "Staff Read Stations" ON stations FOR SELECT TO authenticated USING (true);
