-- Hardening Migration for Core Elite Combine 2026

-- Module 4: Schema Consistency & Migration Alignment
-- 1. Fix incidents.station_id type
-- First check if incidents table exists (it wasn't in the original schema but mentioned in Module 4)
DO $$ 
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'incidents') THEN
        ALTER TABLE incidents ALTER COLUMN station_id TYPE TEXT;
    ELSE
        CREATE TABLE incidents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id UUID NOT NULL REFERENCES events(id),
            station_id TEXT NOT NULL REFERENCES stations(id),
            athlete_id UUID REFERENCES athletes(id),
            type TEXT NOT NULL,
            description TEXT,
            severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
            recorded_by UUID REFERENCES auth.users(id),
            created_at TIMESTAMPTZ DEFAULT now()
        );
    END IF;
END $$;

-- 2. Normalize drill identifiers into a canonical drills table
CREATE TABLE IF NOT EXISTS drills (
    id TEXT PRIMARY KEY, -- e.g., '40YARD'
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit TEXT NOT NULL,
    attempts_allowed INT DEFAULT 2,
    scoring_type TEXT NOT NULL CHECK (scoring_type IN ('lower_is_better', 'higher_is_better')),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed drills if empty
INSERT INTO drills (id, name, category, unit, attempts_allowed, scoring_type)
VALUES 
    ('40YARD', '40 Yard Dash', 'Speed', 'sec', 2, 'lower_is_better'),
    ('VERTICAL', 'Vertical Jump', 'Power', 'in', 3, 'higher_is_better'),
    ('BENCH', 'Bench Press', 'Strength', 'reps', 1, 'higher_is_better'),
    ('PRO_AGILITY', 'Pro Agility (5-10-5)', 'Agility', 'sec', 2, 'lower_is_better'),
    ('BROAD_JUMP', 'Broad Jump', 'Power', 'ft-in', 3, 'higher_is_better')
ON CONFLICT (id) DO NOTHING;

-- 3. Align report_jobs schema
ALTER TABLE report_jobs DROP CONSTRAINT IF EXISTS report_jobs_status_check;
ALTER TABLE report_jobs ADD CONSTRAINT report_jobs_status_check CHECK (status IN ('pending', 'processing', 'ready', 'failed'));

-- 4. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_results_athlete_id ON results(athlete_id);
CREATE INDEX IF NOT EXISTS idx_results_event_station ON results(event_id, station_id);
CREATE INDEX IF NOT EXISTS idx_bands_event_status ON bands(event_id, status);
CREATE INDEX IF NOT EXISTS idx_athletes_event_id ON athletes(event_id);
CREATE INDEX IF NOT EXISTS idx_token_claims_token_hash ON token_claims(token_hash);

-- Module 1 & 2: Security Hardening & RPCs

-- Tighten RLS
-- Remove permissive policies
DROP POLICY IF EXISTS "Public Insert Athletes" ON athletes;
DROP POLICY IF EXISTS "Public Update Athlete via ID" ON athletes;
DROP POLICY IF EXISTS "Public Update Band Claim" ON bands;
DROP POLICY IF EXISTS "Public Token Claims" ON token_claims;

-- New RLS Policies
-- Athletes: Public can only insert via RPC (we'll keep RLS enabled but no public direct insert)
-- Actually, for RPC to work with SECURITY DEFINER, RLS is bypassed for the function's internal queries.
-- So we can just not have public policies for direct mutations.

-- RPC: register_athlete_secure
CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id UUID,
    p_first_name TEXT,
    p_last_name TEXT,
    p_date_of_birth DATE,
    p_grade TEXT,
    p_position TEXT,
    p_parent_name TEXT,
    p_parent_email TEXT,
    p_parent_phone TEXT,
    p_guardian_relationship TEXT,
    p_emergency_contact_name TEXT,
    p_emergency_contact_phone TEXT,
    p_signature_data_url TEXT,
    p_injury_waiver_ack BOOLEAN,
    p_media_release BOOLEAN,
    p_data_consent BOOLEAN,
    p_marketing_consent BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id UUID;
    v_token TEXT;
    v_portal_token TEXT;
BEGIN
    -- Validate event exists
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid event ID');
    END IF;

    -- Insert athlete
    INSERT INTO athletes (
        event_id, first_name, last_name, date_of_birth, grade, position, 
        parent_name, parent_email, parent_phone
    )
    VALUES (
        p_event_id, p_first_name, p_last_name, p_date_of_birth, p_grade, p_position, 
        p_parent_name, p_parent_email, p_parent_phone
    )
    RETURNING id INTO v_athlete_id;

    -- Insert waiver
    INSERT INTO waivers (
        athlete_id, event_id, guardian_name, guardian_relationship, 
        emergency_contact_name, emergency_contact_phone, signature_data_url,
        agreed
    )
    VALUES (
        v_athlete_id, p_event_id, p_parent_name, p_guardian_relationship, 
        p_emergency_contact_name, p_emergency_contact_phone, p_signature_data_url,
        p_injury_waiver_ack
    );

    -- Generate claim token
    v_token := encode(gen_random_bytes(16), 'hex');
    
    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + interval '24 hours');

    -- Generate parent portal token
    v_portal_token := encode(gen_random_bytes(16), 'hex');
    
    -- Check if parent_portals table exists
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'parent_portals') THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, v_portal_token);
    END IF;

    RETURN jsonb_build_object(
        'success', true, 
        'athlete_id', v_athlete_id, 
        'claim_token', v_token,
        'portal_token', v_portal_token
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- RPC: claim_band_atomic
CREATE OR REPLACE FUNCTION claim_band_atomic(
    p_token TEXT,
    p_band_id TEXT,
    p_device_label TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_claim_row RECORD;
    v_band_row RECORD;
    v_athlete_id UUID;
BEGIN
    -- 1. SELECT token_claims row FOR UPDATE
    SELECT * INTO v_claim_row 
    FROM token_claims 
    WHERE token_hash = p_token 
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid token');
    END IF;

    IF v_claim_row.used_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Token already used');
    END IF;

    IF v_claim_row.expires_at < now() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Token expired');
    END IF;

    -- 2. SELECT band row FOR UPDATE
    SELECT * INTO v_band_row 
    FROM bands 
    WHERE band_id = p_band_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Band not found');
    END IF;

    IF v_band_row.status != 'available' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Band not available');
    END IF;

    -- 3. UPDATE band
    UPDATE bands 
    SET status = 'assigned', 
        athlete_id = v_claim_row.athlete_id, 
        assigned_at = now()
    WHERE band_id = p_band_id;

    -- 4. UPDATE athletes
    UPDATE athletes 
    SET band_id = p_band_id 
    WHERE id = v_claim_row.athlete_id;

    -- 5. UPDATE token_claims
    UPDATE token_claims 
    SET used_at = now() 
    WHERE token_hash = p_token;

    -- 6. INSERT audit log (if table exists, otherwise skip or create)
    -- Assuming a simple audit log or just returning success
    
    RETURN jsonb_build_object(
        'success', true, 
        'athlete_id', v_claim_row.athlete_id,
        'display_number', v_band_row.display_number
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- RPC: submit_result_secure
CREATE OR REPLACE FUNCTION submit_result_secure(
    p_client_result_id UUID,
    p_event_id UUID,
    p_athlete_id UUID,
    p_band_id TEXT,
    p_station_id TEXT,
    p_drill_type TEXT,
    p_value_num NUMERIC,
    p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result_id UUID;
BEGIN
    -- Validate role (must be authenticated)
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Idempotency check
    SELECT id INTO v_result_id FROM results WHERE client_result_id = p_client_result_id;
    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    END IF;

    -- Insert result
    INSERT INTO results (
        client_result_id, event_id, athlete_id, band_id, station_id, drill_type, value_num, meta, recorded_by
    )
    VALUES (
        p_client_result_id, p_event_id, p_athlete_id, p_band_id, p_station_id, p_drill_type, p_value_num, p_meta, auth.uid()
    )
    RETURNING id INTO v_result_id;

    -- Trigger report job if all drills done
    -- (This logic can also stay in a trigger or be part of this RPC)
    
    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);
END;
$$;

-- Module 6: Admin Performance Optimization
-- RPC: get_admin_summary
CREATE OR REPLACE FUNCTION get_admin_summary(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_count INT;
    v_band_count INT;
    v_result_count INT;
    v_completed_count INT;
BEGIN
    SELECT count(*) INTO v_athlete_count FROM athletes WHERE event_id = p_event_id;
    SELECT count(*) INTO v_band_count FROM bands WHERE event_id = p_event_id AND status = 'assigned';
    SELECT count(*) INTO v_result_count FROM results WHERE event_id = p_event_id;
    
    -- Assuming completion is based on required_drills count
    -- This is a simplified version
    SELECT count(*) INTO v_completed_count 
    FROM (
        SELECT athlete_id 
        FROM results 
        WHERE event_id = p_event_id 
        GROUP BY athlete_id 
        HAVING count(DISTINCT drill_type) >= (SELECT jsonb_array_length(required_drills) FROM events WHERE id = p_event_id)
    ) as completed;

    RETURN jsonb_build_object(
        'athletes', v_athlete_count,
        'bands', v_band_count,
        'results', v_result_count,
        'completed', v_completed_count
    );
END;
$$;

-- RPC: admin_export_event_results
CREATE OR REPLACE FUNCTION admin_export_event_results(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job_id UUID;
BEGIN
    -- Validate event
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid event ID');
    END IF;

    -- Create a report job
    INSERT INTO report_jobs (event_id, status, type)
    VALUES (p_event_id, 'pending', 'csv_export')
    RETURNING id INTO v_job_id;

    -- In a real system, a background worker would pick this up.
    -- For this demo, we'll return the job ID.
    
    RETURN jsonb_build_object(
        'success', true, 
        'job_id', v_job_id,
        'message', 'Export job queued. Check status in report_jobs table.'
    );
END;
$$;
