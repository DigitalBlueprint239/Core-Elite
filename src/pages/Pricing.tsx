import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Zap, Star, Shield } from 'lucide-react';
import { BRAND } from '../lib/brand';
import { PLANS, redirectToCheckout } from '../lib/stripe';

const TIER_1_FEATURES = [
  'Guaranteed combine spot',
  'NFC wristband assignment',
  'Real-time drill result tracking',
  'Parent portal access (same-day)',
  'Digital performance report',
];

const TIER_2_FEATURES = [
  'Everything in Combine Registration',
  'Scout-facing recruiting profile (live year-round)',
  'Core Elite Verified badge',
  'McKay Percentile rankings — all drills',
  'Shareable recruiting link',
  'Profile discovery by D1 scouts',
];

const TIER_3_FEATURES = [
  'Full athlete database access',
  'D1 Scout API — REST + webhooks',
  'Bulk export (CSV / JSON / PDF)',
  'Custom position + percentile filters',
  'McKay analytics dashboard',
  'Compliance audit log',
  'Dedicated implementation engineer',
  'SLA + uptime guarantee',
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">

      {/* Nav */}
      <div className="max-w-6xl mx-auto px-6 pt-8">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-zinc-500 hover:text-white transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      {/* Hero */}
      <header className="max-w-6xl mx-auto px-6 pt-12 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#c8a200]/10 border border-[#c8a200]/30 rounded-full text-[#c8a200] text-[11px] font-black uppercase tracking-widest mb-6">
          <Zap className="w-3 h-3" />
          The Flywheel
        </div>
        <h1 className="text-5xl md:text-6xl font-black uppercase italic tracking-tighter mb-4">
          One Platform.<br />
          <span style={{ color: '#c8a200' }}>Three Tiers.</span>
        </h1>
        <p className="text-zinc-400 text-lg max-w-xl mx-auto">
          From first rep to first offer. The Core Elite Network flywheel turns combine performance into recruiting opportunity.
        </p>
      </header>

      {/* Pricing Cards */}
      <main className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">

          {/* ── Tier 1: Combine Registration ─────────────────── */}
          <div className="bg-zinc-900 rounded-3xl border border-zinc-800 p-8 flex flex-col">
            <div className="mb-6">
              <div className="w-10 h-10 bg-zinc-800 rounded-xl flex items-center justify-center mb-4">
                <Zap className="w-5 h-5 text-zinc-400" />
              </div>
              <p className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-1">Tier 1 — Acquisition</p>
              <h2 className="text-xl font-black">Combine Registration</h2>
              <div className="mt-4 flex items-end gap-2">
                <span className="text-5xl font-black tabular-nums">${PLANS.combine_registration.price}</span>
                <span className="text-zinc-500 font-bold pb-1">one-time</span>
              </div>
              <p className="text-zinc-500 text-sm mt-2">
                Get on the field. Your verified performance data starts here.
              </p>
            </div>

            <ul className="space-y-3 flex-1 mb-8">
              {TIER_1_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-zinc-300">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              onClick={() => redirectToCheckout('combine_registration')}
              className="w-full py-4 bg-white text-zinc-900 rounded-2xl font-black text-sm uppercase tracking-wider hover:bg-zinc-100 active:scale-[0.98] transition-all"
            >
              Register Now — $49
            </button>
          </div>

          {/* ── Tier 2: Athlete Pro ───────────────────────────── */}
          <div className="bg-zinc-900 rounded-3xl border-2 border-[#c8a200] p-8 flex flex-col relative md:-mt-4 md:mb-4 shadow-2xl shadow-[#c8a200]/10">
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
              <span className="px-4 py-1 bg-[#c8a200] text-zinc-900 text-[10px] font-black uppercase tracking-widest rounded-full whitespace-nowrap">
                Most Popular
              </span>
            </div>
            <div className="mb-6">
              <div className="w-10 h-10 bg-[#c8a200]/10 rounded-xl flex items-center justify-center mb-4">
                <Star className="w-5 h-5 text-[#c8a200]" />
              </div>
              <p className="text-xs font-black uppercase tracking-widest text-[#c8a200] mb-1">Tier 2 — Athlete SaaS</p>
              <h2 className="text-xl font-black">Athlete Pro</h2>
              <div className="mt-4 flex items-end gap-2">
                <span className="text-5xl font-black tabular-nums">${PLANS.athlete_pro.price}</span>
                <span className="text-zinc-500 font-bold pb-1">/mo</span>
              </div>
              <p className="text-zinc-500 text-sm mt-2">
                Get recruited. Turn your combine numbers into a verified recruiting profile scouts can find.
              </p>
            </div>

            <ul className="space-y-3 flex-1 mb-8">
              {TIER_2_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-zinc-300">
                  <Check className="w-4 h-4 text-[#c8a200] shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              onClick={() => redirectToCheckout('athlete_pro')}
              className="w-full py-4 rounded-2xl font-black text-sm uppercase tracking-wider active:scale-[0.98] transition-all"
              style={{ background: '#c8a200', color: '#18181b' }}
            >
              Unlock Your Profile — $14.99/mo
            </button>
          </div>

          {/* ── Tier 3: Enterprise ───────────────────────────── */}
          <div className="bg-zinc-900 rounded-3xl border border-zinc-800 p-8 flex flex-col">
            <div className="mb-6">
              <div className="w-10 h-10 bg-zinc-800 rounded-xl flex items-center justify-center mb-4">
                <Shield className="w-5 h-5 text-zinc-400" />
              </div>
              <p className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-1">Tier 3 — Enterprise B2B</p>
              <h2 className="text-xl font-black">Enterprise</h2>
              <div className="mt-4 flex items-end gap-2">
                <span className="text-5xl font-black tabular-nums">$3K</span>
                <span className="text-zinc-500 font-bold pb-1">/mo</span>
              </div>
              <p className="text-[11px] text-zinc-400 font-bold mt-0.5">
                Billed annually at ${PLANS.enterprise.price.toLocaleString()}/yr
              </p>
              <p className="text-zinc-500 text-sm mt-2">
                Own the data. Full database access and D1 Scout API for programs that need the edge.
              </p>
            </div>

            <ul className="space-y-3 flex-1 mb-8">
              {TIER_3_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-3 text-sm text-zinc-300">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  {f}
                </li>
              ))}
            </ul>

            <button
              onClick={() => {
                const link = PLANS.enterprise.paymentLink;
                if (link) {
                  window.location.href = link;
                } else {
                  window.location.href = '/enterprise/trust-center';
                }
              }}
              className="w-full py-4 bg-zinc-800 text-white rounded-2xl font-black text-sm uppercase tracking-wider hover:bg-zinc-700 active:scale-[0.98] transition-all"
            >
              Contact Sales
            </button>
          </div>

        </div>

        {/* Flywheel caption */}
        <p className="text-center text-zinc-400 text-xs mt-10 max-w-lg mx-auto leading-relaxed">
          The flywheel: $49 gets an athlete through the gate → verified data builds their profile → $14.99/mo keeps it live →
          scouts find it through the $36K/yr Enterprise API → demand drives more registrations.
        </p>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 py-8 text-center">
        <div className="inline-flex items-center gap-2 text-zinc-400 text-xs">
          <img src={BRAND.logo} alt="" className="w-4 h-4 opacity-30" />
          © 2026 Core Elite Network. All rights reserved.
        </div>
      </footer>

    </div>
  );
}
