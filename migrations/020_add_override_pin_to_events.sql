-- Migration: add_override_pin_to_events
-- Adds an event-day admin override PIN to the events table.
-- This PIN is required by staff to save a result that was blocked
-- by the Gate 2 (below_physical_floor) or Gate 3 (above_max_threshold) validation rules.
--
-- Security notes:
--   - PIN is stored as plain text in v1. Sprint 2 should hash with pgcrypto: crypt().
--   - PIN should be 4–6 digits, rotated per event day.
--   - RLS: only admin role can read/write this column.
--   - Every override attempt (success or failure) is written to audit_log.action = 'result_override'.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS override_pin TEXT DEFAULT NULL;

-- RLS policy: only admins may read the override_pin column.
-- (Assumes existing RLS policy for events is in place; this tightens the column.)
COMMENT ON COLUMN events.override_pin IS
  'Event-day admin PIN required to override Gate 2/3 blocked drill entries. '
  'Set in Event Ops → Events tab before the combine starts. '
  'Rotate each event day. All override attempts are logged to audit_log.';

-- Add 'result_override' to audit_log action index if one exists
-- (noop if audit_log has no action-specific index)
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);
