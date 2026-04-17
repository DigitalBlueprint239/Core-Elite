-- Migration: 022_add_high_school_column.sql
-- Adds the high_school column to the athletes table.
--
-- WHY: AdminDashboard, B2BExports (league-admin), and the ARMS CSV export
-- pipeline all reference athletes.high_school. The column was referenced in
-- code but never formally added to the schema. This migration adds it.
--
-- IDEMPOTENCY: IF NOT EXISTS — safe to run multiple times.

ALTER TABLE public.athletes
  ADD COLUMN IF NOT EXISTS high_school TEXT;

COMMENT ON COLUMN public.athletes.high_school IS
  'Name of the athlete''s high school. Used in B2B recruiting exports '
  '(ARMS, JumpForward, XOS). Collected at registration or populated via '
  'legacy CSV import.';
