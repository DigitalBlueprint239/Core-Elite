import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import { ClipboardList, Filter, RefreshCw, AlertCircle } from 'lucide-react';

interface AuditEntry {
  id: string;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  new_value: Record<string, unknown> | null;
  old_value: Record<string, unknown> | null;
  user_id: string | null;
  profiles: { email: string } | null;
}

const ACTION_COLORS: Record<string, string> = {
  result_submitted: 'bg-emerald-100 text-emerald-700',
  result_voided:    'bg-red-100 text-red-700',
  band_claimed:     'bg-blue-100 text-blue-700',
  band_voided:      'bg-orange-100 text-orange-700',
  athlete_registered: 'bg-amber-100 text-amber-700',
};

const ACTION_LABELS: Record<string, string> = {
  result_submitted:   'Result Submitted',
  result_voided:      'Result Voided',
  band_claimed:       'Band Claimed',
  band_voided:        'Band Voided',
  athlete_registered: 'Athlete Registered',
};

export function AuditTab({ eventId }: { eventId?: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('');

  useEffect(() => {
    fetchAuditLog();
  }, [eventId, actionFilter, dateFilter]);

  async function fetchAuditLog() {
    setLoading(true);
    setError(null);

    let query = supabase
      .from('audit_log')
      .select('*, profiles(email)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (eventId) {
      query = query.eq('event_id', eventId);
    }

    if (actionFilter !== 'all') {
      query = query.eq('action', actionFilter);
    }

    if (dateFilter) {
      query = query.gte('created_at', `${dateFilter}T00:00:00`)
                   .lte('created_at', `${dateFilter}T23:59:59`);
    }

    const { data, error: fetchError } = await query;

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setEntries((data as AuditEntry[]) || []);
    }
    setLoading(false);
  }

  function formatTime(ts: string) {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function formatDetails(entry: AuditEntry): string {
    const val = entry.new_value || entry.old_value;
    if (!val) return '—';
    return Object.entries(val)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
  }

  return (
    <motion.div
      key="audit"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-zinc-900 text-white p-2 rounded-xl">
            <ClipboardList className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-black uppercase tracking-tighter">Audit Log</h2>
            <p className="text-xs text-zinc-400 font-medium">Last 100 entries — immutable record</p>
          </div>
        </div>
        <button
          onClick={fetchAuditLog}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Filter className="w-4 h-4 text-zinc-400" />
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900"
        >
          <option value="all">All Actions</option>
          <option value="result_submitted">Result Submitted</option>
          <option value="result_voided">Result Voided</option>
          <option value="band_claimed">Band Claimed</option>
          <option value="band_voided">Band Voided</option>
          <option value="athlete_registered">Athlete Registered</option>
        </select>
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900"
        />
        {(actionFilter !== 'all' || dateFilter) && (
          <button
            onClick={() => { setActionFilter('all'); setDateFilter(''); }}
            className="text-xs font-bold text-zinc-500 hover:text-zinc-900 underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm font-medium">
          <AlertCircle className="w-5 h-5 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-12 bg-zinc-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-16 text-zinc-400">
          <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-bold">No audit entries found</p>
          <p className="text-sm mt-1">Entries are created automatically as events occur.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="text-left p-4 text-xs font-black uppercase tracking-widest text-zinc-400">Time</th>
                <th className="text-left p-4 text-xs font-black uppercase tracking-widest text-zinc-400">User</th>
                <th className="text-left p-4 text-xs font-black uppercase tracking-widest text-zinc-400">Action</th>
                <th className="text-left p-4 text-xs font-black uppercase tracking-widest text-zinc-400">Entity</th>
                <th className="text-left p-4 text-xs font-black uppercase tracking-widest text-zinc-400">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={entry.id}
                  className={`border-b border-zinc-50 hover:bg-zinc-50 transition-colors ${i % 2 === 0 ? '' : 'bg-zinc-50/50'}`}
                >
                  <td className="p-4 text-xs font-mono text-zinc-500 whitespace-nowrap">
                    {formatTime(entry.created_at)}
                  </td>
                  <td className="p-4 text-xs text-zinc-600 max-w-[140px] truncate">
                    {entry.profiles?.email ?? <span className="text-zinc-300 italic">system</span>}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide ${ACTION_COLORS[entry.action] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </span>
                  </td>
                  <td className="p-4 text-xs text-zinc-500">
                    <span className="font-bold text-zinc-700">{entry.entity_type}</span>
                    <span className="font-mono text-zinc-400 ml-1 text-[10px]">
                      {entry.entity_id.slice(0, 8)}…
                    </span>
                  </td>
                  <td className="p-4 text-xs text-zinc-500 font-mono max-w-[260px] truncate">
                    {formatDetails(entry)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
