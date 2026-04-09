import React, { useState } from 'react';
import { ShieldCheck, Download, FileText, Lock, ArrowUpRight, CheckCircle2, ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ComplianceItem {
  label: string;
  status: 'compliant' | 'in-progress';
}

interface TrustSection {
  id: string;
  icon: React.ReactNode;
  label: string;
  headline: string;
  summary: string;
  body: string;
  items: ComplianceItem[];
  badge: string;
}

// ─── Section Data ─────────────────────────────────────────────────────────────

const SECTIONS: TrustSection[] = [
  {
    id: 'coppa',
    icon: <ShieldCheck className="w-5 h-5" />,
    label: 'COPPA Compliance',
    headline: 'Youth Data Protection',
    summary: 'Strict adherence to youth data protection. Minors\' data is isolated and consent-gated.',
    body: `Core Elite was designed from the ground up to operate in environments where athletes under 13 are participants. All minor athlete records are stored in isolated data partitions that are inaccessible without explicit, documented parental consent. Consent is captured at registration, cryptographically bound to the athlete record, and cannot be bypassed by any staff role below League Commissioner.

Registration flows enforce date-of-birth validation and automatically route athletes under 13 into the COPPA-gated data path. No minor athlete data is exposed to third-party analytics, advertising networks, or data brokers. Data retention policies default to minimum-necessary and support programmatic deletion requests at the League Admin level.`,
    items: [
      { label: 'Parental consent capture at registration', status: 'compliant' },
      { label: 'Minor data partition isolation (RLS enforced)', status: 'compliant' },
      { label: 'DOB validation with age-gating logic', status: 'compliant' },
      { label: 'No third-party data sharing for minors', status: 'compliant' },
      { label: 'Programmatic data deletion API', status: 'in-progress' },
    ],
    badge: 'COPPA',
  },
  {
    id: 'portability',
    icon: <Download className="w-5 h-5" />,
    label: 'Data Portability',
    headline: 'Your League Owns Your Data',
    summary: 'Your league owns your data. Export comprehensive CSVs or connect via API.',
    body: `Core Elite enforces a strict data-ownership model. Every athlete record, combine result, audit log entry, and media asset generated during your events is owned exclusively by your league. Core Elite holds no license to use, redistribute, or monetize your data.

League Commissioners can export full event datasets as structured CSVs from the Admin Operations dashboard at any time, including partial-event snapshots during live operations. For organizations requiring automated data pipelines, a read-only export API is available on Enterprise plans. Data is encrypted in transit (TLS 1.3) and at rest (AES-256). Upon contract termination, all league data is purged within 30 days with a signed Certificate of Destruction available on request.`,
    items: [
      { label: 'CSV export from Admin Operations dashboard', status: 'compliant' },
      { label: 'TLS 1.3 encryption in transit', status: 'compliant' },
      { label: 'AES-256 encryption at rest (Supabase)', status: 'compliant' },
      { label: 'No data monetization or third-party licensing', status: 'compliant' },
      { label: 'Read-only export API (Enterprise)', status: 'in-progress' },
      { label: 'Certificate of Destruction on termination', status: 'in-progress' },
    ],
    badge: 'GDPR / CCPA',
  },
  {
    id: 'audit',
    icon: <FileText className="w-5 h-5" />,
    label: 'Audit Trails',
    headline: 'Cryptographically Verified Event Logs',
    summary: 'Every override, login, and score correction is cryptographically logged by staff ID and timestamp.',
    body: `Core Elite maintains an append-only audit log for every consequential event in the platform. Score entries, admin overrides, login events, waiver completions, and device heartbeats are all written with a staff identity token, device fingerprint, and a Hybrid Logical Clock (HLC) timestamp that ensures deterministic ordering even across concurrent offline periods.

Override events — where a staff member uses a PIN to force-submit a value blocked by the biometric validation gates — are logged with the gate that was triggered, the reason provided by the staff member, and the identity of the approving administrator. The audit log is write-once at the database layer; no role, including League Commissioner, can delete or modify entries. League Admins can query and export the full audit trail from the Admin Operations dashboard.`,
    items: [
      { label: 'Append-only audit_log table (RLS write-once)', status: 'compliant' },
      { label: 'HLC timestamps for offline conflict resolution', status: 'compliant' },
      { label: 'Staff ID + device fingerprint on every entry', status: 'compliant' },
      { label: 'Admin override events logged with gate + reason', status: 'compliant' },
      { label: 'Audit log export from Admin Operations', status: 'compliant' },
      { label: 'SIEM integration (Enterprise)', status: 'in-progress' },
    ],
    badge: 'SOC 2 Aligned',
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ComplianceBadgeProps {
  status: 'compliant' | 'in-progress';
}

function ComplianceBadge({ status }: ComplianceBadgeProps) {
  if (status === 'compliant') {
    return (
      <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full whitespace-nowrap">
        <CheckCircle2 className="w-3 h-3" />
        Compliant
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full whitespace-nowrap">
      In Progress
    </span>
  );
}

interface SectionContentProps {
  section: TrustSection;
}

function SectionContent({ section }: SectionContentProps) {
  return (
    <div className="space-y-10">

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-zinc-900 text-white rounded-xl flex items-center justify-center shrink-0">
            {section.icon}
          </div>
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-400 bg-zinc-100 px-2.5 py-1 rounded-full">
            {section.badge}
          </span>
        </div>
        <h1 className="text-3xl font-black tracking-tight text-zinc-900 mb-3">
          {section.headline}
        </h1>
        <p className="text-lg text-zinc-500 leading-relaxed font-medium">
          {section.summary}
        </p>
      </div>

      {/* Divider */}
      <div className="border-t border-zinc-100" />

      {/* Body copy */}
      <div className="space-y-4">
        {section.body.split('\n\n').map((paragraph, i) => (
          <p key={i} className="text-zinc-600 leading-relaxed text-[15px]">
            {paragraph}
          </p>
        ))}
      </div>

      {/* Compliance checklist */}
      <div className="border border-zinc-200 rounded-2xl overflow-hidden">
        <div className="px-6 py-4 bg-zinc-50 border-b border-zinc-200">
          <h3 className="text-sm font-black uppercase tracking-widest text-zinc-500">
            Implementation Status
          </h3>
        </div>
        <ul className="divide-y divide-zinc-100">
          {section.items.map((item) => (
            <li
              key={item.label}
              className="flex items-center justify-between px-6 py-4 gap-4"
            >
              <span className="text-sm text-zinc-700 font-medium">{item.label}</span>
              <ComplianceBadge status={item.status} />
            </li>
          ))}
        </ul>
      </div>

      {/* External link placeholder */}
      <div className="flex items-center gap-2">
        <Lock className="w-4 h-4 text-zinc-300" />
        <span className="text-xs text-zinc-400 font-medium">
          Full technical specification available to verified enterprise customers.
        </span>
        <button className="flex items-center gap-1 text-xs font-bold text-zinc-500 hover:text-zinc-900 transition-colors ml-auto">
          Request Documentation <ArrowUpRight className="w-3 h-3" />
        </button>
      </div>

    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TrustCenter() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const activeSection = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];

  return (
    <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16">

      {/* Page header */}
      <div className="mb-16">
        <div className="flex items-center gap-2 mb-6">
          <span className="h-px w-8 bg-zinc-300" />
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-zinc-400">
            Legal & Compliance
          </span>
        </div>
        <h1 className="text-5xl font-black tracking-tight text-zinc-900 mb-4">
          Trust Center
        </h1>
        <p className="text-xl text-zinc-500 max-w-2xl leading-relaxed">
          Core Elite's security posture, compliance frameworks, and data
          governance policies — documented for League Commissioners,
          Athletic Directors, and their legal teams.
        </p>
      </div>

      {/* Body — sidebar + content */}
      <div className="flex flex-col lg:flex-row gap-8 lg:gap-16">

        {/* ── Sidebar ─────────────────────────────────────────────────────── */}
        <aside className="lg:w-64 shrink-0">
          <nav className="lg:sticky lg:top-24 space-y-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-400 px-3 mb-3">
              Compliance Areas
            </p>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveId(section.id)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-3 rounded-xl text-left transition-all group ${
                  activeId === section.id
                    ? 'bg-zinc-900 text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`shrink-0 ${activeId === section.id ? 'text-white' : 'text-zinc-400 group-hover:text-zinc-700'}`}>
                    {section.icon}
                  </span>
                  <span className="text-sm font-bold">{section.label}</span>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                  activeId === section.id ? 'text-white opacity-60' : 'text-zinc-300 group-hover:text-zinc-500'
                }`} />
              </button>
            ))}

            {/* CTA in sidebar */}
            <div className="mt-8 p-4 border border-zinc-200 rounded-xl bg-zinc-50">
              <p className="text-xs font-bold text-zinc-700 mb-1">
                Need a security review?
              </p>
              <p className="text-xs text-zinc-500 leading-snug mb-3">
                We'll walk your legal team through every control in 30 minutes.
              </p>
              <button className="w-full py-2 bg-zinc-900 text-white text-xs font-bold rounded-lg hover:bg-zinc-800 transition-colors">
                Request Demo
              </button>
            </div>
          </nav>
        </aside>

        {/* ── Content ─────────────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          <SectionContent section={activeSection} />
        </div>

      </div>
    </div>
  );
}
