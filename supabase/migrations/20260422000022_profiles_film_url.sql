-- =============================================================================
-- MIGRATION 022: Film Fusion — Optional Highlight Film URL on profiles
-- Core Elite Combine 2026
-- =============================================================================
--
-- PROBLEM STATEMENT:
--   Athletes vary wildly in whether they have a Hudl / highlight reel at the
--   time of onboarding. Requiring a film URL at sign-up would turn a 30-second
--   band-claim into a scavenger hunt, destroying conversion. Founder directive
--   is explicit: film_url must be OPTIONAL.
--
-- CHANGES:
--
--   1. profiles.film_url — nullable text column.
--      Intentionally no NOT NULL, no DEFAULT, no CHECK. The Scout View renders
--      a deliberate "NO FILM LINKED" empty state when the column is null, so
--      the application layer handles absence as a first-class case.
--
--   2. No RLS change. profiles RLS (migration 021) already scopes reads to
--      the owning user and admins — film_url inherits those guarantees.
--
-- NOTES:
--   - We do not validate URL format in SQL. The front-end Zod schema and the
--     hudl parser utility (src/lib/hudl.ts) handle normalization and embed
--     conversion. Storing the raw user-supplied URL keeps the DB dumb and
--     lets the UI layer evolve its parsing without migrations.
--   - If we later need format validation (e.g. reject non-http schemes), add
--     a CHECK constraint here rather than a trigger — it's cheaper.
--
-- IDEMPOTENCY: Safe to run multiple times.
-- =============================================================================

BEGIN;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS film_url text;

COMMENT ON COLUMN profiles.film_url IS
  'Optional highlight-reel URL (typically hudl.com/video/...). Nullable by design; the Scout View empty-states on NULL.';

COMMIT;
