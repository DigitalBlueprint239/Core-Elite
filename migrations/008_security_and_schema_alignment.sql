-- Migration: 008_security_and_schema_alignment.sql
-- Description: Hardens RLS policies across core tables and fixes schema drift

-- ============================================================================
-- 1. SCHEMA DRIFT FIXES
-- ============================================================================

-- Fix 1.1: Add missing assigned_at column to bands table
-- This column is used by the claim_band_atomic RPC but was missing from migration 002
ALTER TABLE bands ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

-- Fix 1.2: Fix incidents.station_id foreign key type mismatch
-- stations.id is TEXT, but incidents.station_id was created as UUID in migration 005
-- We must drop the constraint, change the type, and re-add the constraint
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_station_id_fkey;
ALTER TABLE incidents ALTER COLUMN station_id TYPE TEXT USING station_id::TEXT;
ALTER TABLE incidents ADD CONSTRAINT incidents_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id);

-- Fix 1.3: Add missing columns to report_jobs table
-- These columns exist in supabase_schema.sql but were missing from migration 004
ALTER TABLE report_jobs ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES auth.users(id);
ALTER TABLE report_jobs ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'pdf';
ALTER TABLE report_jobs ADD COLUMN IF NOT EXISTS error_message TEXT;

-- ============================================================================
-- 2. RLS POLICY HARDENING
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: token_claims
-- Issue: "Public Token Claims" FOR ALL USING (true) allowed full public read/write
-- Fix: Restrict to SELECT only. Mutations are handled exclusively by the RPC.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Token Claims" ON token_claims;

CREATE POLICY "Public Read Own Token" ON token_claims
  FOR SELECT USING (true);

CREATE POLICY "Admin Full Access Tokens" ON token_claims
  FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------------------------------------------
-- Table: athletes
-- Issue: "Public Update Athlete via ID" FOR UPDATE USING (true) allowed public mutation
-- Fix: Remove public UPDATE. The claim_band_atomic RPC handles band_id update securely.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Update Athlete via ID" ON athletes;

-- ----------------------------------------------------------------------------
-- Table: bands
-- Issue: "Public Update Band Claim" FOR UPDATE USING (true) allowed public mutation
-- Fix: Remove public UPDATE. The claim_band_atomic RPC handles band assignment securely.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Update Band Claim" ON bands;

-- ----------------------------------------------------------------------------
-- Table: results
-- Issue: "Admin Update Results" FOR UPDATE TO authenticated USING (true) allowed any staff
-- Fix: Restrict UPDATE to admins only. Staff should only INSERT (append-only).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admin Update Results" ON results;

CREATE POLICY "Admin Update Results" ON results
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------------------------------------------
-- Table: profiles
-- Issue: "Public profiles are viewable by everyone." leaked staff names/roles
-- Fix: Restrict profile visibility to authenticated users only.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public profiles are viewable by everyone." ON profiles;

CREATE POLICY "Authenticated Read Profiles" ON profiles
  FOR SELECT TO authenticated USING (true);

-- ----------------------------------------------------------------------------
-- Table: device_status
-- Issue: "Public Device Status Update" FOR UPDATE USING (true) allowed public mutation
-- Fix: Restrict UPDATE to authenticated staff/admins. Stations can only INSERT (upsert).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public Device Status Update" ON device_status;

CREATE POLICY "Staff Update Device Status" ON device_status
  FOR UPDATE TO authenticated USING (true);
