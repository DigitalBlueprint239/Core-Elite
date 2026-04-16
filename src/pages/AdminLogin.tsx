import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { classifyAuthError } from '../lib/authErrors';
import { LayoutDashboard, Lock, AlertCircle, ArrowLeft } from 'lucide-react';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { data: { user }, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(classifyAuthError(signInError));
      setLoading(false);
      return;
    }

    if (user) {
      // ── Role resolution: JWT claims first, profiles table as fallback ──
      // app_metadata.role is set server-side (invite-staff Edge Function /
      // sync-metadata) and is always authoritative. Checking it first avoids
      // a DB round-trip AND eliminates the window where a profiles RLS/timing
      // issue could deny a legitimately authenticated admin.
      const jwtRole =
        (user.app_metadata?.role as string | undefined) ??
        (user.user_metadata?.role as string | undefined);

      if (jwtRole === 'admin') {
        navigate('/admin/dashboard');
        return;
      }

      // Fallback: profiles table (catches accounts without synced JWT claims)
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (profile?.role === 'admin') {
        navigate('/admin/dashboard');
      } else {
        setError("This account doesn't have admin access.");
        await supabase.auth.signOut();
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-zinc-900">
      <div className="w-full max-w-md mb-8">
        <Link 
          to="/" 
          className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="inline-block p-3 bg-white/10 rounded-2xl mb-4">
            <LayoutDashboard className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter text-white">Admin Portal</h1>
          <p className="text-zinc-400">Secure access to event analytics</p>
        </div>

        <form onSubmit={handleLogin} className="bg-white p-8 rounded-3xl shadow-2xl space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Admin Email</label>
            <input 
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              placeholder="Enter your email"
              autoComplete="username"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
            <div className="flex justify-end pt-1">
              <Link
                to="/forgot-password"
                className="text-xs font-medium text-zinc-500 hover:text-zinc-900 underline-offset-2 hover:underline transition-colors"
              >
                Forgot password?
              </Link>
            </div>
          </div>

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            {loading ? 'Authenticating...' : 'Enter Dashboard'}
            {!loading && <Lock className="w-5 h-5" />}
          </button>
        </form>
      </div>
    </div>
  );
}
