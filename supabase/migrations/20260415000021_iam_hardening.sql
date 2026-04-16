-- =============================================================================
-- MIGRATION 021: IAM Hardening — Zero-Trust User Creation Pipeline
-- Core Elite Combine 2026
-- =============================================================================
--
-- PROBLEM STATEMENT:
--   The profiles table had role DEFAULT 'staff', meaning ANY auth.users row
--   (created by accident, malicious sign-up, or edge-case) would silently gain
--   staff-level access. No trigger existed to enforce the default.
--
-- CHANGES:
--
--   1. Expand profiles.role check constraint to include 'player'.
--      'player' is the safe zero-permission default for any auth user who is
--      not explicitly invited as staff or admin.
--
--   2. Change profiles.role DEFAULT from 'staff' → 'player'.
--      Any auto-created profile row gets minimal permissions.
--
--   3. handle_new_auth_user() — SECURITY DEFINER trigger function.
--      Fires AFTER INSERT ON auth.users. Inserts a profiles row with
--      role = 'player' using ON CONFLICT DO NOTHING, so the invite-staff
--      Edge Function can safely upsert the correct role before the user
--      accepts the invite (the upsert wins; the trigger insert is a no-op).
--
--   4. on_auth_user_created trigger on auth.users.
--
--   5. RLS hardening for the profiles table:
--      - Users can read their own profile (needed by RouteGuard).
--      - Users can NOT read or write other profiles.
--      - Admin can read all profiles (needed by invite-staff admin check).
--      - No direct role escalation from the client is possible.
--
-- SECURITY GUARANTEE:
--   After this migration, the only way to hold role = 'staff' or 'admin' is:
--     a) The invite-staff Edge Function explicitly sets it (admin-gated).
--     b) A direct Supabase Studio SQL UPDATE (human, logged, privileged).
--   Self-signup via any public client path always resolves to role = 'player'.
--
-- IDEMPOTENCY: Safe to run multiple times.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Expand check constraint to include 'player'
-- ---------------------------------------------------------------------------

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'staff', 'player'));

-- ---------------------------------------------------------------------------
-- 2. Change DEFAULT from 'staff' to 'player'
-- ---------------------------------------------------------------------------

ALTER TABLE profiles ALTER COLUMN role SET DEFAULT 'player';

-- ---------------------------------------------------------------------------
-- 3. Trigger function: handle_new_auth_user
--
-- Uses ON CONFLICT (id) DO NOTHING so that:
--   a) For invited users: invite-staff upserts the profile with the correct
--      role AFTER Supabase creates auth.users. The trigger fires but the
--      conflict guard keeps the invite-set role intact.
--   b) For any other auth user creation: 'player' is inserted as the safe
--      default.
--
-- SECURITY DEFINER + SET search_path = public is required because this
-- function runs in the auth schema context (triggered by auth.users) and
-- must write to the public schema.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, role)
  VALUES (NEW.id, 'player')
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Trigger on auth.users
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 5. RLS policies for the profiles table
--
-- Prior state: unknown / potentially no RLS (no explicit policy in any
-- prior migration). This closes that gap explicitly.
-- ---------------------------------------------------------------------------

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users may read their own profile (RouteGuard needs this)
DROP POLICY IF EXISTS "Users read own profile"  ON profiles;
CREATE POLICY "Users read own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- Admins may read all profiles (admin dashboards, invite-staff role check)
DROP POLICY IF EXISTS "Admin read all profiles" ON profiles;
CREATE POLICY "Admin read all profiles"
  ON profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles self
      WHERE self.id = auth.uid() AND self.role = 'admin'
    )
  );

-- No client-side INSERT or UPDATE: all profile mutations go through
-- SECURITY DEFINER RPCs or the service-role Edge Function.
-- The trigger INSERT runs as SECURITY DEFINER, bypassing RLS.
-- The invite-staff Edge Function uses the service role key, bypassing RLS.

COMMIT;
