/**
 * AuthCallback.tsx
 * Core Elite — Central PKCE Callback Handler
 *
 * Single landing page for ALL Supabase email links:
 *   • Password resets   (event: PASSWORD_RECOVERY)
 *   • Staff/admin invites (event: SIGNED_IN + user_metadata.initial_setup)
 *   • Magic link sign-ins (event: SIGNED_IN, future)
 *
 * Mounted at:  /auth/callback
 * Whitelist in Supabase Dashboard → Authentication → URL Configuration.
 *
 * ─── Routing table ─────────────────────────────────────────────────────────
 *  Auth event        │ Condition                  │ Destination
 *  ──────────────────┼────────────────────────────┼────────────────────────
 *  PASSWORD_RECOVERY │ —                          │ /update-password
 *  SIGNED_IN         │ initial_setup = true       │ /update-password
 *  SIGNED_IN         │ role = admin               │ /league-admin
 *  SIGNED_IN         │ role = staff               │ /staff/select-station
 *  SIGNED_IN         │ role = player / unknown    │ /
 *  No code in URL    │ active session exists      │ role-based (graceful)
 *  Any error         │ —                          │ /admin/login (4 s delay)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * ─── React 18 Strict Mode — double-mount fix ───────────────────────────────
 *  In development, React intentionally mounts → unmounts → remounts every
 *  component to surface side-effect bugs. exchangeCodeForSession() consumes
 *  a single-use PKCE token; calling it a second time always returns an error,
 *  causing a false "link expired" bounce.
 *
 *  Fix: hasExchanged = useRef(false).
 *    • useRef values persist across Strict Mode's simulated unmount/remount.
 *    • The first useEffect run sets hasExchanged.current = true and calls the
 *      exchange. The second run sees true and skips the exchange entirely,
 *      instead checking whether the first exchange has already produced a
 *      session (handling the edge case where the network call completes
 *      between the two effect runs).
 *    • The onAuthStateChange subscription is set up in a SEPARATE effect so
 *      that a live subscription is always present when the exchange resolves,
 *      even after Strict Mode re-runs the effects.
 *
 *  This two-effect architecture (subscribe / exchange in separate effects)
 *  is the key to avoiding the race condition between the subscription being
 *  torn down and rebuilt, and the async exchange completing.
 * ───────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'exchanging' | 'routing' | 'error';

interface UserProfile {
  role: 'admin' | 'staff' | 'player';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AuthCallback() {
  const navigate        = useNavigate();
  const [phase,         setPhase]    = useState<Phase>('exchanging');
  const [errorMsg,      setErrorMsg] = useState('');

  /**
   * Strict Mode guard — persists across simulated unmount/remount.
   * Set to true before the first exchange attempt; prevents any subsequent
   * attempt (including the Strict Mode second mount) from firing.
   */
  const hasExchanged = useRef(false);

  // ── Effect 1: auth state subscription ──────────────────────────────────────
  //
  // Kept in its own effect so it is always re-established on Strict Mode's
  // second mount. By the time the exchange (Effect 2) resolves, this
  // subscription is guaranteed to be active and listening.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!session) return;

        setPhase('routing');

        if (event === 'PASSWORD_RECOVERY') {
          navigate('/update-password', { replace: true });
          return;
        }

        if (event === 'SIGNED_IN') {
          const meta = session.user.user_metadata ?? {};
          if (meta.initial_setup === true) {
            // Invited user — route to password setup
            navigate('/update-password', { replace: true });
            return;
          }
          // Normal sign-in (magic link) — route by DB role
          await routeByRole(session.user.id, navigate);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [navigate]);

  // ── Effect 2: one-time PKCE exchange ───────────────────────────────────────
  //
  // Runs conceptually once per component lifetime. The hasExchanged ref
  // is the single mechanism that enforces this guarantee under Strict Mode.
  useEffect(() => {
    // ── Strict Mode second-mount path ────────────────────────────────────
    if (hasExchanged.current) {
      // The exchange is either in-flight or has already completed.
      // If it completed before this effect re-ran, a session now exists —
      // route from it so we don't hang in the 'exchanging' phase.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!session) return; // Exchange still in-flight; Effect 1 will handle it.
        setPhase(p => {
          if (p !== 'exchanging') return p; // Already routed.
          const meta = session.user.user_metadata ?? {};
          if (meta.initial_setup === true || session.user.recovery_sent_at) {
            navigate('/update-password', { replace: true });
          } else {
            routeByRole(session.user.id, navigate);
          }
          return 'routing';
        });
      });
      return;
    }

    // ── First-mount path: mark and proceed ───────────────────────────────
    hasExchanged.current = true;

    const code = new URLSearchParams(window.location.search).get('code');

    // ── No code: graceful fallback ────────────────────────────────────────
    if (!code) {
      // User navigated here directly, browser went back, or the link was
      // malformed. Check for an already-active session and route gracefully.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) {
          const meta = session.user.user_metadata ?? {};
          if (meta.initial_setup === true || session.user.recovery_sent_at) {
            navigate('/update-password', { replace: true });
          } else {
            routeByRole(session.user.id, navigate);
          }
        } else {
          setErrorMsg('No authentication code found. The link may be invalid or expired.');
          setPhase('error');
          window.setTimeout(
            () => navigate('/admin/login', { replace: true }),
            4_000,
          );
        }
      });
      return;
    }

    // ── Exchange the PKCE code ────────────────────────────────────────────
    //
    // Do NOT guard the .then() callback with a mounted/ref check.
    // In Strict Mode, state setters and navigate() are safe to call even
    // after the simulated unmount — React preserves the component instance.
    // Guarding with a ref here would cause the page to hang in 'exchanging'.
    supabase.auth.exchangeCodeForSession(code)
      .then(({ data: { session }, error }) => {

        if (error || !session) {
          const detail = error?.message ?? 'The link has expired or has already been used.';
          setErrorMsg(detail);
          setPhase('error');
          window.setTimeout(
            () => navigate(
              `/admin/login?error=${encodeURIComponent('Authentication link invalid — please sign in.')}`,
              { replace: true },
            ),
            4_000,
          );
          return;
        }

        // Belt-and-suspenders: if the onAuthStateChange subscription (Effect 1)
        // already fired and advanced the phase, this is a no-op.
        // If it didn't fire (some Supabase client edge cases), route from here.
        setPhase(p => {
          if (p !== 'exchanging') return p; // Already handled by subscription.

          const meta = session.user.user_metadata ?? {};
          if (meta.initial_setup === true || session.user.recovery_sent_at) {
            navigate('/update-password', { replace: true });
          } else {
            routeByRole(session.user.id, navigate);
          }
          return 'routing';
        });
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : 'Unexpected authentication error.';
        setErrorMsg(msg);
        setPhase('error');
        window.setTimeout(
          () => navigate('/admin/login', { replace: true }),
          4_000,
        );
      });

    // No cleanup needed: the subscription is managed by Effect 1.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty — this effect runs once per component lifetime.
          // The hasExchanged ref enforces idempotency under Strict Mode.

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-zinc-900 px-4">
        <div className="inline-block p-4 bg-red-500/20 rounded-2xl">
          <ShieldAlert className="w-10 h-10 text-red-400" />
        </div>
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-black uppercase italic tracking-tighter text-white">
            Link Invalid
          </h1>
          <p className="text-zinc-400 text-sm max-w-sm leading-relaxed">{errorMsg}</p>
          <p className="text-zinc-600 text-xs">Redirecting to sign-in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-zinc-900">
      <Loader2 className="w-10 h-10 text-zinc-400 animate-spin" />
      <p className="text-zinc-400 text-sm font-bold uppercase tracking-widest">
        {phase === 'exchanging' ? 'Verifying link…' : 'Signing you in…'}
      </p>
    </div>
  );
}

// ─── Role-based routing helper ────────────────────────────────────────────────

async function routeByRole(
  userId: string,
  navigate: ReturnType<typeof useNavigate>,
): Promise<void> {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', userId)
      .single<UserProfile>();

    const role = profile?.role ?? 'player';

    if (role === 'admin') {
      navigate('/league-admin', { replace: true });
    } else if (role === 'staff') {
      navigate('/staff/select-station', { replace: true });
    } else {
      navigate('/', { replace: true });
    }
  } catch {
    navigate('/', { replace: true });
  }
}
