-- Migration: 006_waiver_enhancements.sql
-- Description: Adds consent checkboxes and versioning to waivers table

ALTER TABLE waivers 
ADD COLUMN IF NOT EXISTS injury_waiver_ack BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS media_release BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS data_consent BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS waiver_version TEXT NOT NULL DEFAULT '2026.1';

-- Also ensure athletes DOB is required at DB level if possible, 
-- but we'll handle it in the UI first to avoid breaking existing data.
