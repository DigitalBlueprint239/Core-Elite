import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { LogIn, ShieldCheck, AlertCircle, ArrowLeft } from 'lucide-react';

export default function StaffLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      // Navigate to station selection so staff choose their own station.
      // The previous hardcoded redirect to /staff/station/SPEED-1 has been removed.
      navigate('/staff/select-station');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md mb-8">
        <Link
          to="/"
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="inline-block p-3 bg-zinc-900 rounded-2xl mb-4">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter">Staff Access</h1>
          <p className="text-zinc-500">Login to access testing stations</p>
        </div>

        <form onSubmit={handleLogin} className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-600 text-sm">
              <AlertCircle className="w-5 h-5" />
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              placeholder="your@email.com"
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
              placeholder="••••••••"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Access Station'}
            {!loading && <LogIn className="w-5 h-5" />}
          </button>
        </form>

        <p className="text-center text-zinc-400 text-xs">
          Authorized personnel only. All access is logged.
        </p>
      </div>
    </div>
  );
}
