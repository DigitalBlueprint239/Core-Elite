import React from 'react';
import { useNavigate } from 'react-router-dom';
import { WifiOff, Shield, Activity, ArrowRight, ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Feature {
  icon: React.ReactNode;
  title: string;
  description: string;
}

interface Stat {
  value: string;
  label: string;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const FEATURES: Feature[] = [
  {
    icon: <WifiOff className="w-5 h-5" />,
    title: 'Offline-First Architecture',
    description: 'Zero data loss when the venue drops offline. Every score, scan, and override is written to a local queue and cryptographically synced the moment connectivity returns.',
  },
  {
    icon: <Shield className="w-5 h-5" />,
    title: 'Hierarchical Governance',
    description: 'Granular permissions from League Admin to Line Staff. Commissioners control which stations can submit, which roles can override, and who sees what across every event.',
  },
  {
    icon: <Activity className="w-5 h-5" />,
    title: 'Automated Integrity',
    description: 'Real-time biometric bounds checking prevents impossible scores. Four validation gates block sensor errors, flag world-record outliers, and route extraordinary results to scout review automatically.',
  },
];

const STATS: Stat[] = [
  { value: '50+',    label: 'Simultaneous events supported' },
  { value: '10,000+', label: 'Athletes processed securely' },
  { value: '4-gate', label: 'Validation pipeline per drill' },
  { value: '100%',   label: 'Data owned by your league' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommissionerOverview() {
  const navigate = useNavigate();

  return (
    <div className="bg-white">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="max-w-7xl mx-auto px-6 lg:px-10 pt-24 pb-20">
        <div className="max-w-3xl">

          {/* Eyebrow */}
          <div className="flex items-center gap-2 mb-8">
            <span className="h-px w-8 bg-zinc-300" />
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-400">
              For League Commissioners & Athletic Directors
            </span>
          </div>

          {/* Headline */}
          <h1 className="text-5xl lg:text-6xl font-black tracking-tight text-zinc-900 leading-[1.05] mb-6">
            Standardize Your League's<br className="hidden lg:block" />
            Performance Data.
          </h1>

          {/* Subhead */}
          <p className="text-xl text-zinc-500 leading-relaxed mb-10 max-w-2xl">
            The offline-first, mathematically verified combine platform built
            for multi-event operators.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap gap-4">
            <button
              onClick={() => navigate('/enterprise/trust-center')}
              className="flex items-center gap-2 px-6 py-3.5 bg-zinc-900 text-white font-bold rounded-xl hover:bg-zinc-800 active:scale-95 transition-all text-sm"
            >
              Request a Demo
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => navigate('/enterprise/trust-center')}
              className="flex items-center gap-2 px-6 py-3.5 border-2 border-zinc-200 text-zinc-700 font-bold rounded-xl hover:border-zinc-400 hover:text-zinc-900 active:scale-95 transition-all text-sm"
            >
              View Trust Center
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* ── Divider ───────────────────────────────────────────────────────── */}
      <div className="border-t border-zinc-100" />

      {/* ── Feature Grid ──────────────────────────────────────────────────── */}
      <section className="max-w-7xl mx-auto px-6 lg:px-10 py-24">
        <div className="mb-16">
          <h2 className="text-3xl font-black tracking-tight text-zinc-900 mb-3">
            Built for the demands of live events.
          </h2>
          <p className="text-zinc-500 text-lg max-w-xl">
            Every architectural decision was made under the assumption that
            connectivity will fail, staff will make errors, and every
            millisecond of athlete data matters.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="group p-8 border border-zinc-200 rounded-2xl hover:border-zinc-400 hover:shadow-sm transition-all"
            >
              {/* Icon */}
              <div className="w-10 h-10 bg-zinc-900 text-white rounded-xl flex items-center justify-center mb-6">
                {feature.icon}
              </div>

              {/* Title */}
              <h3 className="text-base font-black tracking-tight text-zinc-900 mb-3">
                {feature.title}
              </h3>

              {/* Description */}
              <p className="text-sm text-zinc-500 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Social Proof Banner ───────────────────────────────────────────── */}
      <section className="bg-zinc-900 py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-10">
          <div className="grid md:grid-cols-4 gap-12 md:gap-8">
            {STATS.map((stat) => (
              <div key={stat.label} className="text-center md:text-left">
                <div className="text-3xl font-black tracking-tight text-white mb-1">
                  {stat.value}
                </div>
                <div className="text-sm text-zinc-400 font-medium">
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-12 pt-10 border-t border-zinc-800">
            <p className="text-center text-zinc-300 text-lg font-medium tracking-tight">
              Scalable to 50+ simultaneous events. 10,000+ athletes processed securely.
            </p>
          </div>
        </div>
      </section>

      {/* ── Scale Section ─────────────────────────────────────────────────── */}
      <section id="scale" className="max-w-7xl mx-auto px-6 lg:px-10 py-24">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="flex items-center gap-2 mb-6">
              <span className="h-px w-8 bg-zinc-300" />
              <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-400">
                Enterprise Scale
              </span>
            </div>
            <h2 className="text-4xl font-black tracking-tight text-zinc-900 mb-6 leading-tight">
              One platform.<br />Every event.<br />One source of truth.
            </h2>
            <p className="text-zinc-500 text-lg leading-relaxed mb-8">
              Deploy Core Elite across your entire league network. Each event
              gets isolated data scopes, dedicated staff roles, and its own
              override PIN — all governed from a single Commissioner dashboard.
            </p>
            <button
              onClick={() => navigate('/enterprise/trust-center')}
              className="flex items-center gap-2 text-sm font-bold text-zinc-900 hover:gap-3 transition-all group"
            >
              Read our compliance documentation
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>

          {/* Spec cards — right column */}
          <div className="space-y-4">
            {[
              {
                label: 'Multi-Tenant Data Isolation',
                detail: 'Row-level security ensures one league\'s data is never readable by another, enforced at the database layer.',
              },
              {
                label: 'Offline Outbox Sync',
                detail: 'Results written to a local IndexedDB queue with Hybrid Logical Clock timestamps for deterministic conflict resolution.',
              },
              {
                label: 'Immutable Audit Log',
                detail: 'Every score entry, staff override, and login event is appended to a write-once audit trail with staff ID and device fingerprint.',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="p-6 border border-zinc-200 rounded-xl"
              >
                <div className="text-sm font-black text-zinc-900 mb-1.5">
                  {item.label}
                </div>
                <div className="text-sm text-zinc-500 leading-relaxed">
                  {item.detail}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────────────────── */}
      <section className="border-t border-zinc-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24 text-center">
          <h2 className="text-4xl font-black tracking-tight text-zinc-900 mb-4">
            Ready to standardize your combine operations?
          </h2>
          <p className="text-zinc-500 text-lg mb-10 max-w-xl mx-auto">
            Schedule a 30-minute technical walkthrough with a Core Elite Network
            implementation engineer.
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <button
              onClick={() => navigate('/enterprise/trust-center')}
              className="px-8 py-4 bg-zinc-900 text-white font-bold rounded-xl hover:bg-zinc-800 active:scale-95 transition-all"
            >
              Request Demo
            </button>
            <button
              onClick={() => navigate('/enterprise/trust-center')}
              className="px-8 py-4 border-2 border-zinc-200 text-zinc-700 font-bold rounded-xl hover:border-zinc-400 active:scale-95 transition-all"
            >
              View Trust Center
            </button>
          </div>
        </div>
      </section>

    </div>
  );
}
