/**
 * UpdatePassword.tsx
 * Core Elite — Password Recovery / Initial Setup Handler
 *
 * Reached after AuthCallback routes here — either from a password reset link
 * or after an invited user accepts their invite. In both cases the session
 * has already been established by AuthCallback's exchangeCodeForSession().
 * This page's job is simply to confirm the session and render the password form.
 *
 * Also handles the direct-link case where the email points here with a
 * ?code= parameter (legacy PKCE URL configuration or direct resets).
 *
 * ─── React 18 Strict Mode — double-mount fix ───────────────────────────────
 *  exchangeCodeForSession() consumes a one-time token. Without a guard, Strict
 *  Mode's simulated remount fires the call twice:
 *    Mount 1  → exchange succeeds → phase = 'form'
 *    Cleanup  → mountedRef = false (appears safe)
 *    Mount 2  → exchange called AGAIN → "code already used" error → phase = 'invalid'
 *    Result   → user sees "Link Invalid" flash and gets bounced away
 *
 *  Fix: hasExchanged = useRef(false).
 *    The ref persists across Strict Mode's simulated unmount/remount.
 *    Mount 1 sets hasExchanged.current = true before calling exchange.
 *    Mount 2 sees true, skips the exchange, and checks for an existing
 *    session that mount 1's exchange may have already established.
 *
 *  Note on mountedRef reset: in the prior version mountedRef.current was set
 *  to true at the top of useEffect, which meant mount 2 reset it to true —
 *  accidentally allowing mount 1's stale async callbacks to fire. We now use
 *  a closure-scoped `let active` variable per effect run, which is immune to
 *  cross-mount resets. The exchange callback specifically does NOT check
 *  `active` because we WANT it to update state even after Strict Mode's
 *  simulated cleanup (the component is still alive; React only tore down
 *  and rebuilt the effect, not the component instance).
 * ───────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'loading' | 'form' | 'submitting' | 'success' | 'invalid';

// ─── Error classifier ─────────────────────────────────────────────────────────

function classifyUpdateError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed')) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (m.includes('too many') || m.includes('rate limit')) {
    return 'Too many requests. Wait a few minutes and try again.';
  }
  if (m.includes('auth session missing') || m.includes('session_not_found') || m.includes('no session')) {
    return 'Your recovery session has expired. Please request a new password reset link.';
  }
  if (m.includes('password should be') || m.includes('password must be') || m.includes('weak password')) {
    return 'Password is too weak. Use at least 8 characters.';
  }
  return message || 'Password update failed. Please try again.';
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function UpdatePassword() {
  const navigate       = useNavigate();
  const [phase,        setPhase]        = useState<Phase>('loading');
  const [newPassword,  setNewPassword]  = useState('');
  const [confirmPw,    setConfirmPw]    = useState('');
  const [showNew,      setShowNew]      = useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [fieldError,   setFieldError]   = useState<string | null>(null);
  const [serverError,  setServerError]  = useState<string | null>(null);
  const [countdown,    setCountdown]    = useState(3);

  /**
   * Strict Mode guard — persists across simulated unmount/remount.
   * Guarantees exchangeCodeForSession() is called at most once.
   */
  const hasExchanged = useRef(false);

  // ── Session bootstrap ──────────────────────────────────────────────────────
  useEffect(() => {
    // Per-run closure flag for the onAuthStateChange subscription only.
    // This prevents the subscription handler from a torn-down effect run
    // from updating state after its cleanup. The exchange callback
    // intentionally does NOT use this flag (see file header).
    let active = true;

    // ── Auth state listener ──────────────────────────────────────────────
    // Fires when the exchange (below) produces a PASSWORD_RECOVERY session.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (!active) return;
        if (event === 'PASSWORD_RECOVERY' && session) {
          setPhase('form');
        }
      },
    );

    // ── Code exchange (strictly once) ────────────────────────────────────
    if (!hasExchanged.current) {
      hasExchanged.current = true;

      const code = new URLSearchParams(window.location.search).get('code');

      if (code) {
        // Direct PKCE link to /update-password (legacy config or direct reset).
        // Do NOT gate this callback on `active` — see file header for rationale.
        supabase.auth.exchangeCodeForSession(code).then(({ data: { session }, error }) => {
          if (error || !session) {
            setPhase('invalid');
          } else {
            // Advance if onAuthStateChange hasn't done so already.
            setPhase(p => p === 'loading' ? 'form' : p);
          }
        });
      } else {
        // No code — either:
        //   a) AuthCallback already exchanged the code and routed here with an
        //      active session (the normal flow), or
        //   b) The user refreshed this page after a successful exchange.
        supabase.auth.getSession().then(({ data: { session } }) => {
          if (!active) return;
          if (session) {
            setPhase(p => p === 'loading' ? 'form' : p);
          } else {
            setPhase('invalid');
          }
        });
      }
    } else {
      // Strict Mode second mount: hasExchanged is already true.
      // The exchange is either in-flight or complete. Check for a session
      // so we don't hang in the 'loading' phase if it already completed.
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (!active) return;
        if (session) {
          setPhase(p => p === 'loading' ? 'form' : p);
        }
        // If no session yet, the exchange is still in-flight;
        // its callback will call setPhase('form') when it resolves.
      });
    }

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []); // Intentionally empty — see hasExchanged guard above.
          // eslint-disable-next-line react-hooks/exhaustive-deps

  // ── Success countdown redirect ────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'success') return;
    if (countdown <= 0) {
      navigate('/league-admin');
      return;
    }
    const t = window.setTimeout(() => setCountdown(c => c - 1), 1_000);
    return () => window.clearTimeout(t);
  }, [phase, countdown, navigate]);

  // ── Submit handler ────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    setServerError(null);

    if (newPassword.length < 8) {
      setFieldError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPw) {
      setFieldError('Passwords do not match.');
      return;
    }

    setPhase('submitting');
    const { error } = await supabase.auth.updateUser({ password: newPassword });

    if (error) {
      setServerError(classifyUpdateError(error.message));
      setPhase('form');
    } else {
      setPhase('success');
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-zinc-900">

      {phase !== 'success' && (
        <div className="w-full max-w-md mb-8">
          <Link
            to="/admin/login"
            className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-sm font-bold"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to sign in
          </Link>
        </div>
      )}

      <div className="w-full max-w-md space-y-8">

        {/* ── LOADING ── */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center gap-5 py-16">
            <Loader2 className="w-10 h-10 text-zinc-400 animate-spin" />
            <p className="text-zinc-400 text-sm font-bold uppercase tracking-widest">
              Verifying your reset link…
            </p>
          </div>
        )}

        {/* ── INVALID ── */}
        {phase === 'invalid' && (
          <>
            <div className="text-center">
              <div className="inline-block p-3 bg-red-500/20 rounded-2xl mb-4">
                <ShieldAlert className="w-8 h-8 text-red-400" />
              </div>
              <h1 className="text-3xl font-black uppercase italic tracking-tighter text-white">
                Link Invalid
              </h1>
              <p className="text-zinc-400 mt-2 text-sm leading-relaxed">
                This password reset link has expired or has already been used.
              </p>
            </div>
            <div className="bg-white p-8 rounded-3xl shadow-2xl space-y-5 text-center">
              <p className="text-zinc-600 text-sm leading-relaxed">
                Password reset links are single-use and expire after{' '}
                <span className="font-semibold">1 hour</span>. Request a new link to continue.
              </p>
              <Link
                to="/forgot-password"
                className="block w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold text-sm hover:bg-zinc-800 transition-all text-center"
              >
                Request New Reset Link
              </Link>
            </div>
          </>
        )}

        {/* ── FORM / SUBMITTING ── */}
        {(phase === 'form' || phase === 'submitting') && (
          <>
            <div className="text-center">
              <div className="inline-block p-3 bg-white/10 rounded-2xl mb-4">
                <KeyRound className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-black uppercase italic tracking-tighter text-white">
                New Password
              </h1>
              <p className="text-zinc-400 mt-2 text-sm">Choose a strong password for your account.</p>
            </div>

            <form onSubmit={handleSubmit} className="bg-white p-8 rounded-3xl shadow-2xl space-y-6">
              {serverError && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 text-red-600 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <span>{serverError}</span>
                </div>
              )}

              {/* New password */}
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={e => { setNewPassword(e.target.value); setFieldError(null); }}
                    className="w-full p-3 pr-10 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    disabled={phase === 'submitting'}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(v => !v)}
                    tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 transition-colors"
                    aria-label={showNew ? 'Hide password' : 'Show password'}
                  >
                    {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Confirm Password
                </label>
                <div className="relative">
                  <input
                    type={showConfirm ? 'text' : 'password'}
                    value={confirmPw}
                    onChange={e => { setConfirmPw(e.target.value); setFieldError(null); }}
                    className={`w-full p-3 pr-10 bg-zinc-50 border rounded-xl outline-none focus:ring-2 focus:ring-zinc-900 ${
                      fieldError?.includes('match') ? 'border-red-300 bg-red-50' : 'border-zinc-200'
                    }`}
                    placeholder="Repeat your password"
                    autoComplete="new-password"
                    disabled={phase === 'submitting'}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(v => !v)}
                    tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 transition-colors"
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  >
                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {fieldError && (
                  <p className="flex items-center gap-1.5 text-xs text-red-600 font-medium pt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {fieldError}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={phase === 'submitting'}
                className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all disabled:opacity-60 disabled:cursor-wait"
              >
                {phase === 'submitting' ? (
                  <><Loader2 className="w-5 h-5 animate-spin" />Updating Password…</>
                ) : (
                  <><KeyRound className="w-5 h-5" />Set New Password</>
                )}
              </button>
            </form>
          </>
        )}

        {/* ── SUCCESS ── */}
        {phase === 'success' && (
          <>
            <div className="text-center">
              <div className="inline-block p-3 bg-emerald-500/20 rounded-2xl mb-4">
                <CheckCircle className="w-8 h-8 text-emerald-400" />
              </div>
              <h1 className="text-3xl font-black uppercase italic tracking-tighter text-white">
                Password Updated
              </h1>
              <p className="text-zinc-400 mt-2 text-sm">Your password has been changed successfully.</p>
            </div>
            <div className="bg-white p-8 rounded-3xl shadow-2xl space-y-5 text-center">
              <p className="text-zinc-600 text-sm leading-relaxed">
                Redirecting you to the Command Center in{' '}
                <span className="font-black text-zinc-900 tabular-nums">{countdown}</span>
                {' '}second{countdown !== 1 ? 's' : ''}…
              </p>
              <button
                onClick={() => navigate('/league-admin')}
                className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all"
              >
                Go to Command Center Now
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}
