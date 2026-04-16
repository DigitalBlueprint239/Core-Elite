/**
 * invite-staff
 * Core Elite — Admin-Gated Staff / Admin Invitation
 *
 * Creates a new Supabase auth user via the admin API (inviteUserByEmail),
 * immediately sets the correct role on their profiles row, and sends them
 * an invitation email whose link lands on /auth/callback.
 *
 * The role pipeline:
 *   1. Admin calls this function with { email, role }
 *   2. inviteUserByEmail() creates auth.users row
 *   3. on_auth_user_created trigger fires → inserts profiles row with
 *      role = 'player' (safe default, ON CONFLICT DO NOTHING)
 *   4. THIS function then upserts the profiles row with the requested role
 *      (step 3's trigger insert was a no-op because we upsert first — the
 *      trigger fires synchronously inside inviteUserByEmail, so by the time
 *      we get user.id back the 'player' row already exists; we update it)
 *   5. The invited user receives an email. Clicking the link lands on
 *      /auth/callback?code=<pkce_code>
 *   6. AuthCallback detects initial_setup = true in user_metadata → routes
 *      to /update-password so they can set their password
 *
 * Security:
 *   - verify_jwt = false (gateway bypass, same pattern as other functions)
 *   - Manual JWT validation + admin role assertion inside the function
 *   - Service role key used for all admin API and DB operations
 *   - Role is validated against an allowlist before any DB write
 *
 * Request body (JSON):
 *   {
 *     email:       string  — required
 *     role:        'staff' | 'admin'  — required
 *     redirect_to?: string — optional override (defaults to SITE_URL/auth/callback)
 *   }
 *
 * Response (200):
 *   { success: true, userId: string, email: string, role: string }
 *
 * Error responses:
 *   400 — Missing/invalid fields
 *   401 — Missing or invalid JWT
 *   403 — Caller does not have admin role
 *   409 — User with this email already exists
 *   500 — Unexpected server error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// ─── Constants ────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ROLES = new Set(['staff', 'admin']);

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    // ── Step 1: Validate caller JWT + assert admin role ───────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return errorResponse(401, 'UNAUTHORIZED', 'Missing Authorization header.');
    }

    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return errorResponse(401, 'UNAUTHORIZED', 'Invalid or expired session token.');
    }

    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: callerProfile } = await svc
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!callerProfile || callerProfile.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Only admins can invite staff or other admins.');
    }

    // ── Step 2: Parse and validate request body ───────────────────────────
    let body: { email?: string; role?: string; redirect_to?: string };
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }

    const { email, role, redirect_to } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return errorResponse(400, 'INVALID_REQUEST', 'email must be a valid email address.');
    }
    if (!role || !ALLOWED_ROLES.has(role)) {
      return errorResponse(400, 'INVALID_REQUEST', 'role must be "staff" or "admin".');
    }

    // ── Step 3: Build redirect URL ────────────────────────────────────────
    // The invited user's link will land on /auth/callback where AuthCallback
    // handles the PKCE exchange and routes them to set their password.
    const siteUrl =
      redirect_to ??
      Deno.env.get('SITE_URL') ??
      'https://iabyfawsaovoakzqxrde.supabase.co'; // fallback only

    const inviteRedirectTo = siteUrl.endsWith('/auth/callback')
      ? siteUrl
      : `${siteUrl.replace(/\/$/, '')}/auth/callback`;

    // ── Step 4: Create the invited user ──────────────────────────────────
    // inviteUserByEmail creates the auth.users row immediately (in an
    // 'invited' pending state). The on_auth_user_created trigger fires
    // synchronously within this call, inserting a 'player' profile row.
    const { data: inviteData, error: inviteError } = await svc.auth.admin.inviteUserByEmail(
      email.toLowerCase().trim(),
      {
        redirectTo: inviteRedirectTo,
        data: {
          // Picked up by AuthCallback to route the user to /update-password
          // so they can set their initial password after accepting the invite.
          initial_setup: true,
          invited_role:  role,
        },
      },
    );

    if (inviteError) {
      // Supabase returns a specific message when the user already exists
      if (
        inviteError.message.toLowerCase().includes('already been registered') ||
        inviteError.message.toLowerCase().includes('already registered') ||
        inviteError.message.toLowerCase().includes('email already')
      ) {
        return errorResponse(
          409,
          'USER_EXISTS',
          `A user with email ${email} already exists. ` +
          'Use the Supabase Dashboard to update their role directly.',
        );
      }
      console.error('[invite-staff] inviteUserByEmail error:', inviteError.message);
      return errorResponse(500, 'INVITE_FAILED', inviteError.message);
    }

    const invitedUser = inviteData.user;
    if (!invitedUser?.id) {
      return errorResponse(500, 'INVITE_FAILED', 'Invite succeeded but user ID was not returned.');
    }

    // ── Step 5: Elevate the profile role ─────────────────────────────────
    // The on_auth_user_created trigger created a 'player' row. We upsert to
    // set the correct role. ON CONFLICT updates the row set by the trigger.
    const { error: profileError } = await svc
      .from('profiles')
      .upsert(
        { id: invitedUser.id, role },
        { onConflict: 'id' },
      );

    if (profileError) {
      // Log but don't fail the whole request — the invite was sent.
      // The admin can fix the role from Supabase Studio.
      console.error(
        `[invite-staff] Profile role update failed for ${invitedUser.id}:`,
        profileError.message,
      );
    }

    // ── Step 6: Return success ────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        success:      true,
        userId:       invitedUser.id,
        email:        invitedUser.email,
        role,
        redirect_to:  inviteRedirectTo,
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );

  } catch (err) {
    console.error('[invite-staff] Unhandled error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function errorResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ error: { code, detail } }),
    { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
}
