import React from 'react';
import { Link } from 'react-router-dom';
import { BRAND } from '../lib/brand';
import { Users, ShieldCheck, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-zinc-900 text-white flex flex-col items-center justify-center px-6 text-center">
      {/* Logo */}
      <img
        src={BRAND.logo}
        alt="Core Elite"
        className="w-14 h-14 mb-8 opacity-90"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />

      {/* Error number */}
      <div
        className="text-[120px] md:text-[180px] font-black italic leading-none tracking-tighter mb-2"
        style={{ color: BRAND.colors.accent }}
      >
        404
      </div>

      {/* Headline */}
      <h1 className="text-3xl md:text-4xl font-black uppercase italic tracking-tighter mb-3">
        Out of Bounds.
      </h1>

      {/* Body */}
      <p className="text-zinc-400 text-base max-w-sm mb-10 leading-relaxed">
        This page doesn't exist or was moved. Check the URL, or pick a destination below and get back in the game.
      </p>

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <Link
          to="/"
          className="flex-1 flex items-center justify-center gap-2 py-4 bg-white text-zinc-900 rounded-2xl font-bold hover:bg-zinc-100 transition-all"
        >
          <Home className="w-4 h-4" />
          Home
        </Link>
        <Link
          to="/register"
          className="flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl font-bold border-2 transition-all hover:bg-white/10"
          style={{ borderColor: BRAND.colors.accent, color: BRAND.colors.accent }}
        >
          <Users className="w-4 h-4" />
          Register
        </Link>
        <Link
          to="/staff/login"
          className="flex-1 flex items-center justify-center gap-2 py-4 border border-zinc-700 text-zinc-400 rounded-2xl font-bold hover:border-zinc-500 hover:text-white transition-all"
        >
          <ShieldCheck className="w-4 h-4" />
          Staff Login
        </Link>
      </div>

      {/* Footer stamp */}
      <p className="mt-12 text-zinc-600 text-xs font-bold uppercase tracking-widest">
        Core Elite Athletic Testing &copy; 2026
      </p>
    </div>
  );
}
