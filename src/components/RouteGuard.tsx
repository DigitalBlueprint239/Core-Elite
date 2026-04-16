/**
 * RouteGuard.tsx
 * Core Elite — Route-level authentication and role enforcement
 *
 * Role resolution order (first match wins):
 *   1. session.user.app_metadata.role  — JWT claim, zero DB round-trip,
 *                                        set by invite-staff / sync-metadata
 *   2. session.user.user_metadata.role — fallback JWT claim
 *   3. profiles.role                   — database row (trigger-created)
 *
 * Using JWT claims as the primary source eliminates the window where a
 * profiles query could fail (RLS timing, network) and prematurely deny
 * access to a legitimately authenticated admin.
 *
 * The profiles query is still executed so downstream pages that read
 * `profile` for display data continue to work — it just is no longer
 * the sole gatekeeper.
 */

import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { AlertCircle, Lock } from 'lucide-react';

interface RouteGuardProps {
  children:      React.ReactNode;
  requireAdmin?: boolean;
}

/** Derive the user's role from the available sources, in priority order. */
function resolveRole(
  session: ReturnType<typeof useState<any>>[0],
  profile: ReturnType<typeof useState<any>>[0],
): string | null {
  if (!session?.user) return null;

  // 1. JWT app_metadata (set server-side via invite-staff / admin API)
  const appRole = session.user.app_metadata?.role;
  if (appRole) return appRole;

  // 2. JWT user_metadata (secondary JWT claim)
  const metaRole = session.user.user_metadata?.role;
  if (metaRole) return metaRole;

  // 3. Profiles table row (trigger-created, may lag on first sign-in)
  if (profile?.role) return profile.role;

  return null;
}

export function RouteGuard({ children, requireAdmin = false }: RouteGuardProps) {
  const [loading,  setLoading]  = useState(true);
  const [session,  setSession]  = useState<any>(null);
  const [profile,  setProfile]  = useState<any>(null);
  const location = useLocation();

  useEffect(() => {
    async function checkAuth() {
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);

      if (session) {
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();

        if (error && error.code !== 'PGRST116') {
          // PGRST116 = "no rows returned" — not a real error for new users.
          // Log anything else so it's visible during debugging.
          console.warn('[RouteGuard] profiles query error:', error.message);
        }
        setProfile(data ?? null);
      }

      setLoading(false);
    }

    checkAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);

        if (!session) {
          setProfile(null);
          setLoading(false);
          return;
        }

        // Re-fetch profile when session changes (e.g., token refresh, sign-in)
        const { data } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();
        setProfile(data ?? null);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-pulse text-zinc-400 font-medium">Verifying access...</div>
      </div>
    );
  }

  // ── Unauthenticated ──────────────────────────────────────────────────────
  if (!session) {
    const loginPath = location.pathname.startsWith('/admin') || location.pathname.startsWith('/league-admin')
      ? '/admin/login'
      : '/staff/login';
    return <Navigate to={loginPath} state={{ from: location }} replace />;
  }

  // ── Admin check — JWT claims take precedence over profiles table ─────────
  if (requireAdmin) {
    const role = resolveRole(session, profile);

    if (role !== 'admin') {
      return (
        <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-6">
          <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-6">
            <div className="w-16 h-16 bg-amber-50 text-amber-600 rounded-full flex items-center justify-center mx-auto">
              <Lock className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-zinc-900 mb-2">Access Denied</h2>
              <p className="text-zinc-500 text-sm">
                This area is restricted to administrators only.
                Please contact the event director if you believe this is an error.
              </p>
            </div>
            {/* Surface resolved role in dev so mismatches are visible */}
            {import.meta.env.DEV && (
              <p className="text-xs text-zinc-400 font-mono bg-zinc-50 rounded p-2">
                resolved role: {role ?? 'null'} · uid: {session.user.id?.slice(0, 8)}…
              </p>
            )}
            <button
              onClick={() => window.history.back()}
              className="w-full py-3 bg-zinc-900 text-white rounded-xl font-bold hover:bg-zinc-800 transition-all"
            >
              Go Back
            </button>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
