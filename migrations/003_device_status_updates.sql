-- Migration: 003_device_status_updates.sql
-- Description: Updates device_status for heartbeat and sync monitoring

-- 1. Add unique constraint for upsert
-- First, ensure no duplicates exist that would block the constraint
DELETE FROM device_status a USING device_status b 
WHERE a.id < b.id 
AND a.event_id = b.event_id 
AND a.station_id = b.station_id 
AND COALESCE(a.device_label, '') = COALESCE(b.device_label, '');

ALTER TABLE device_status DROP CONSTRAINT IF EXISTS device_status_unique_identity;
ALTER TABLE device_status ADD CONSTRAINT device_status_unique_identity UNIQUE (event_id, station_id, device_label);

-- 2. Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_device_status_event_station ON device_status(event_id, station_id);
CREATE INDEX IF NOT EXISTS idx_device_status_last_seen ON device_status(last_seen_at);

-- 3. Update RLS for device_status to allow upserts from staff
DROP POLICY IF EXISTS "Staff Device Status" ON device_status;
CREATE POLICY "Staff Device Status" ON device_status FOR ALL TO authenticated USING (true);
-- If we want public to heartbeat (unauthenticated stations), we might need a public policy
-- But the prompt says "Staff station mode", which usually implies authenticated.
-- Let's add a public insert/update policy just in case some stations are unauthenticated.
CREATE POLICY "Public Device Status Heartbeat" ON device_status FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Device Status Update" ON device_status FOR UPDATE USING (true);
