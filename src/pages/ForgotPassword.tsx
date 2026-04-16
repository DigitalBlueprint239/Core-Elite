import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { classifyResetError } from '../lib/authErrors';
import { Mail, ArrowLeft, AlertCircle, CheckCircle } from 'lucide-react';

const RESEND_COOLDOWN_S = 60;

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const submitReset = async (addr: string) => {
    setLoading(true);
    setError(null);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(addr, {
      // Route through the central PKCE callback handler, which exchanges the
      // code and forwards to /update-password. Using window.location.origin
      // makes this environment-aware: localhost in dev, production in prod.
      redirectTo: `${window.location.origin}/auth/callback`,
    });

    setLoading(false);

    if (resetError) {
      const msg = classifyResetError(resetError);
      if (msg) {
        // Only a network/server fault — stay on the form so they can retry.
        setError(msg);
        return;
      }
      // "Email not found" or any other error → fall through to confirmation
      // so we never reveal whether the address is registered.
    }

    setSent(true);
    setCooldown(RESEND_COOLDOWN_S);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitReset(email);
  };

  const handleResend = () => {
    if (cooldown > 0) return;
    submitReset(email);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md mb-8">
        <Link
          to={sent ? '/' : -1 as unknown as string}
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sign in
        </Link>
      </div>

      <div className="w-full max-w-md space-y-8">
        {!sent ? (
          <>
            <div className="text-center">
              <div className="inline-block p-3 bg-zinc-900 rounded-2xl mb-4">
                <Mail className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-black uppercase italic tracking-tighter">
                Reset Password
              </h1>
              <p className="text-zinc-500 mt-1">
                Enter your email and we'll send a reset link if an account exists.
              </p>
            </div>

            <form
              onSubmit={handleSubmit}
              className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-6"
            >
              {error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  {error}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                  placeholder="Enter your email"
                  autoComplete="email"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all disabled:opacity-50"
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
                {!loading && <Mail className="w-5 h-5" />}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="text-center">
              <div className="inline-block p-3 bg-green-600 rounded-2xl mb-4">
                <CheckCircle className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-black uppercase italic tracking-tighter">
                Check Your Inbox
              </h1>
            </div>

            <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-5 text-center">
              <p className="text-zinc-700 text-sm leading-relaxed">
                If <span className="font-semibold">{email}</span> is registered,
                you'll receive a reset link within a few minutes.
              </p>
              <p className="text-zinc-500 text-xs">
                Don't see it? Check your spam or junk folder.
              </p>

              {error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm text-left">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  {error}
                </div>
              )}

              <button
                onClick={handleResend}
                disabled={cooldown > 0 || loading}
                className="w-full py-3 border-2 border-zinc-200 text-zinc-700 rounded-2xl font-bold text-sm hover:border-zinc-400 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading
                  ? 'Sending...'
                  : cooldown > 0
                  ? `Resend link (${cooldown}s)`
                  : 'Resend link'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
