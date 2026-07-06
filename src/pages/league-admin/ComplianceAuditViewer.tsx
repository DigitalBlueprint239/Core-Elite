import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Search, Download, RefreshCw, ChevronLeft, ChevronRight,
  Filter, ShieldCheck, Eye,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id:           string;
  actor_id:     string;
  actor_role:   string;
  action:       string;
  event_id:     string | null;
  target_type:  string;
  target_id:    string | null;
  target_data:  any;
  device_id:    string | null;
  created_at:   string;
  hlc_timestamp?: string;
  // Joined fields (from profiles)
  actor_email?: string;
  event_name?:  string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<string, string> = {
  result_submitted:  'Result Submitted',
  result_voided:     'Result Voided',
  athlete_registered:'Athlete Registered',
  athlete_viewed:    'Athlete Viewed',
  athlete_exported:  'Athlete Exported',
  band_claimed:      'Band Claimed',
  band_voided:       'Band Voided',
  waiver_signed:     'Waiver Signed',
  override_applied:  'Override Applied',
  data_export:       'Data Export',
};

const ACTION_COLORS: Record<string, string> = {
  result_submitted:  'text-emerald-400 bg-emerald-400/10',
  result_voided:     'text-red-400 bg-red-400/10',
  athlete_registered:'text-sky-400 bg-sky-400/10',
  athlete_viewed:    'text-purple-400 bg-purple-400/10',
  athlete_exported:  'text-amber-400 bg-amber-400/10',
  band_claimed:      'text-teal-400 bg-teal-400/10',
  band_voided:       'text-orange-400 bg-orange-400/10',
  waiver_signed:     'text-blue-400 bg-blue-400/10',
  override_applied:  'text-red-300 bg-red-300/10',
  data_export:       'text-amber-300 bg-amber-300/10',
};

function ActionBadge({ action }: { action: string }) {
  const label = ACTION_LABELS[action] ?? action;
  const color = ACTION_COLORS[action] ?? 'text-zinc-400 bg-zinc-400/10';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${color}`}>
      {label}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    admin:            'text-sky-400',
    event_admin:      'text-sky-400',
    station_operator: 'text-emerald-400',
    coach:            'text-purple-400',
    scout:            'text-amber-400',
    staff:            'text-zinc-400',
    system:           'text-zinc-400',
  };
  return (
    <span className={`text-[9px] font-mono font-bold uppercase tracking-widest ${map[role] ?? 'text-zinc-500'}`}>
      {role}
    </span>
  );
}

// ─── CSV export helper ────────────────────────────────────────────────────────

function exportAuditCSV(entries: AuditEntry[], dateFrom: string, dateTo: string) {
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const headers = ['Timestamp','Actor Email','Actor Role','Action','Target Type','Target ID','Event Name','Device ID','HLC'];
  const rows = entries.map(e => [
    e.created_at,
    e.actor_email ?? e.actor_id,
    e.actor_role,
    e.action,
    e.target_type,
    e.target_id ?? '',
    e.event_name ?? '',
    e.device_id ?? '',
    e.hlc_timestamp ?? '',
  ].map(escape).join(','));

  const csv = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `core-elite-audit_${dateFrom}_${dateTo}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ComplianceAuditViewer() {
  const today     = new Date().toISOString().split('T')[0];
  const weekAgo   = new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0];

  const [entries, setEntries]     = useState<AuditEntry[]>([]);
  const [total, setTotal]          = useState(0);
  const [page, setPage]            = useState(0);
  const [loading, setLoading]      = useState(true);
  const [dateFrom, setDateFrom]    = useState(weekAgo);
  const [dateTo, setDateTo]        = useState(today);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [search, setSearch]        = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      // Base query
      let q = supabase
        .from('audit_log')
        .select(`
          id, actor_id, actor_role, action,
          event_id, target_type, target_id, target_data,
          device_id, created_at, hlc_timestamp
        `, { count: 'exact' })
        .gte('created_at', `${dateFrom}T00:00:00Z`)
        .lte('created_at', `${dateTo}T23:59:59Z`)
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (actionFilter) q = q.eq('action', actionFilter);

      const { data, count, error } = await q;
      if (error) throw error;

      // Enrich with actor email from profiles (best-effort join)
      const actorIds = [...new Set((data ?? []).map((e: any) => e.actor_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, display_name')
        .in('user_id', actorIds.slice(0, 100));

      const profileMap: Record<string, string> = {};
      (profiles ?? []).forEach((p: any) => { profileMap[p.user_id] = p.display_name; });

      // Enrich with event name
      const eventIds = [...new Set((data ?? []).map((e: any) => e.event_id).filter(Boolean))];
      const { data: eventsData } = await supabase
        .from('events')
        .select('id, name')
        .in('id', eventIds.slice(0, 100));

      const eventMap: Record<string, string> = {};
      (eventsData ?? []).forEach((e: any) => { eventMap[e.id] = e.name; });

      const enriched: AuditEntry[] = (data ?? []).map((e: any) => ({
        ...e,
        actor_email: profileMap[e.actor_id],
        event_name:  e.event_id ? eventMap[e.event_id] : undefined,
      }));

      setEntries(enriched);
      setTotal(count ?? 0);
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, actionFilter, page]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [dateFrom, dateTo, actionFilter, search]);

  const filtered = search
    ? entries.filter(e =>
        (e.actor_email ?? '').toLowerCase().includes(search.toLowerCase()) ||
        e.action.includes(search.toLowerCase()) ||
        (e.event_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (e.target_id ?? '').includes(search)
      )
    : entries;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-black uppercase tracking-[0.15em] text-white flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Compliance & Audit Log
          </h1>
          <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
            FERPA-compliant append-only record · {total.toLocaleString()} total entries in range
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchEntries}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => exportAuditCSV(entries, dateFrom, dateTo)}
            disabled={entries.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-300 transition-colors disabled:opacity-40"
          >
            <Download className="w-3 h-3" />
            Export Audit CSV
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-md px-4 py-3 flex flex-wrap items-center gap-3">
        <Filter className="w-3.5 h-3.5 text-zinc-400 shrink-0" />

        {/* Date range */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-400">From</span>
          <input
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] font-mono text-zinc-200 focus:outline-none focus:border-zinc-500 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-400">To</span>
          <input
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] font-mono text-zinc-200 focus:outline-none focus:border-zinc-500 transition-colors"
          />
        </div>

        {/* Action filter */}
        <div className="relative flex items-center">
          <select
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="appearance-none bg-zinc-800 border border-zinc-700 rounded pl-2 pr-6 py-1 text-[10px] font-mono text-zinc-200 focus:outline-none focus:border-zinc-500 transition-colors cursor-pointer"
          >
            <option value="">All Actions</option>
            {Object.entries(ACTION_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <ChevronRight className="pointer-events-none absolute right-1.5 w-3 h-3 text-zinc-400 rotate-90" />
        </div>

        {/* Search */}
        <div className="relative flex items-center ml-auto">
          <Search className="absolute left-2 w-3 h-3 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter by actor, event, record ID..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded pl-6 pr-3 py-1 text-[10px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors w-64"
          />
        </div>
      </div>

      {/* Audit table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-auto">
        {/* Table header */}
        <div className="grid grid-cols-[1.2fr_1fr_1.4fr_1fr_1fr_0.8fr_0.3fr] border-b border-zinc-800 min-w-[900px]">
          {['Timestamp', 'Actor', 'Action', 'Target', 'Event', 'Device', ''].map(h => (
            <div key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-400">{h}</div>
          ))}
        </div>

        {loading && (
          <div className="px-3 py-10 text-center text-[10px] font-mono text-zinc-400 uppercase tracking-widest animate-pulse">
            Querying audit log...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="px-3 py-10 text-center text-[10px] font-mono text-zinc-400 uppercase tracking-widest">
            No audit entries found in this range
          </div>
        )}

        <div className="min-w-[900px]">
          {!loading && filtered.map((entry, idx) => {
            const isExpanded = expandedId === entry.id;
            const ts = new Date(entry.created_at);

            return (
              <React.Fragment key={entry.id}>
                <div
                  className={`grid grid-cols-[1.2fr_1fr_1.4fr_1fr_1fr_0.8fr_0.3fr] border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors cursor-pointer ${
                    idx % 2 === 1 ? 'bg-zinc-900/40' : ''
                  } ${isExpanded ? 'bg-zinc-800/40' : ''}`}
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  {/* Timestamp */}
                  <div className="px-3 py-2.5 flex flex-col justify-center">
                    <span className="text-[10px] font-mono tabular-nums text-zinc-300">
                      {ts.toLocaleDateString()}
                    </span>
                    <span className="text-[9px] font-mono tabular-nums text-zinc-400">
                      {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>

                  {/* Actor */}
                  <div className="px-3 py-2.5 flex flex-col justify-center min-w-0">
                    <span className="text-[10px] font-mono text-zinc-200 truncate leading-tight">
                      {entry.actor_email ?? entry.actor_id.slice(0, 12) + '…'}
                    </span>
                    <RoleBadge role={entry.actor_role} />
                  </div>

                  {/* Action */}
                  <div className="px-3 py-2.5 flex items-center">
                    <ActionBadge action={entry.action} />
                  </div>

                  {/* Target */}
                  <div className="px-3 py-2.5 flex flex-col justify-center min-w-0">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500 leading-tight">{entry.target_type}</span>
                    <span className="text-[9px] font-mono text-zinc-400 truncate leading-tight">
                      {entry.target_id ? entry.target_id.slice(0, 14) + '…' : '—'}
                    </span>
                  </div>

                  {/* Event */}
                  <div className="px-3 py-2.5 flex items-center min-w-0">
                    <span className="text-[10px] font-mono text-zinc-400 truncate">
                      {entry.event_name ?? '—'}
                    </span>
                  </div>

                  {/* Device */}
                  <div className="px-3 py-2.5 flex items-center min-w-0">
                    <span className="text-[9px] font-mono text-zinc-400 truncate">
                      {entry.device_id ?? '—'}
                    </span>
                  </div>

                  {/* Expand toggle */}
                  <div className="px-3 py-2.5 flex items-center justify-center">
                    <Eye className={`w-3 h-3 transition-colors ${isExpanded ? 'text-zinc-300' : 'text-zinc-700'}`} />
                  </div>
                </div>

                {/* Expanded detail row */}
                {isExpanded && (
                  <div className="border-b border-zinc-800/60 bg-zinc-800/20 px-4 py-3">
                    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 text-[10px] font-mono">
                      <div>
                        <span className="text-zinc-400 uppercase tracking-widest">Actor ID</span>
                        <p className="text-zinc-300 break-all mt-0.5">{entry.actor_id}</p>
                      </div>
                      <div>
                        <span className="text-zinc-400 uppercase tracking-widest">Target ID</span>
                        <p className="text-zinc-300 break-all mt-0.5">{entry.target_id ?? '—'}</p>
                      </div>
                      <div>
                        <span className="text-zinc-400 uppercase tracking-widest">HLC Timestamp</span>
                        <p className="text-zinc-300 break-all mt-0.5">{entry.hlc_timestamp ?? '—'}</p>
                      </div>
                      {entry.target_data && (
                        <div className="col-span-2 lg:col-span-3">
                          <span className="text-zinc-400 uppercase tracking-widest">Target Data</span>
                          <pre className="text-zinc-400 mt-0.5 whitespace-pre-wrap break-all text-[9px] leading-relaxed bg-zinc-900 rounded p-2 border border-zinc-800">
                            {JSON.stringify(entry.target_data, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
          <span className="text-[10px] font-mono text-zinc-400 tabular-nums">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()} entries
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span className="px-3 text-[10px] font-mono text-zinc-400 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
