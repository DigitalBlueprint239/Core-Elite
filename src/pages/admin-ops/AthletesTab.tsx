import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import {
  Search, Pencil, CheckCircle2, X, AlertTriangle,
  RefreshCw, ChevronLeft, ChevronRight,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Athlete {
  id:           string;
  first_name:   string;
  last_name:    string;
  date_of_birth: string;
  position:     string;
  parent_email: string;
  parent_phone?: string;
  band_number?:  number;
  result_count?: number;
}

interface EditState {
  first_name:   string;
  last_name:    string;
  date_of_birth: string;
  parent_email: string;
  position:     string;
}

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P', 'ATH'];
const PAGE_SIZE = 30;

// ─── Position badge ───────────────────────────────────────────────────────────

function PosBadge({ pos }: { pos: string }) {
  return (
    <span className="px-2 py-0.5 bg-zinc-100 rounded text-[10px] font-black uppercase tracking-widest text-zinc-600">
      {pos || '—'}
    </span>
  );
}

// ─── Inline edit row ──────────────────────────────────────────────────────────

function EditRow({
  draft, onChange, onSave, onCancel, saving, error,
}: {
  draft:    EditState;
  onChange: (field: keyof EditState, value: string) => void;
  onSave:   () => void;
  onCancel: () => void;
  saving:   boolean;
  error:    string | null;
}) {
  const inputCls = 'w-full px-2 py-1.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900 font-mono';

  return (
    <tr className="bg-amber-50 border-y-2 border-amber-200">
      <td className="px-4 py-3" colSpan={2}>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">First Name</label>
            <input
              className={inputCls}
              value={draft.first_name}
              onChange={e => onChange('first_name', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Last Name</label>
            <input
              className={inputCls}
              value={draft.last_name}
              onChange={e => onChange('last_name', e.target.value)}
            />
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1">
          <label className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Date of Birth</label>
          <input
            type="date"
            className={inputCls}
            value={draft.date_of_birth}
            onChange={e => onChange('date_of_birth', e.target.value)}
          />
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1">
          <label className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Email</label>
          <input
            type="email"
            className={inputCls}
            value={draft.parent_email}
            onChange={e => onChange('parent_email', e.target.value)}
          />
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1">
          <label className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Position</label>
          <select
            className={inputCls}
            value={draft.position}
            onChange={e => onChange('position', e.target.value)}
          >
            <option value="">—</option>
            {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-2">
          {error && (
            <span className="text-[10px] text-red-600 font-medium flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {error}
            </span>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold transition-colors disabled:opacity-50"
            >
              {saving
                ? <RefreshCw className="w-3 h-3 animate-spin" />
                : <CheckCircle2 className="w-3 h-3" />
              }
              Save
            </button>
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-200 hover:bg-zinc-300 text-zinc-700 rounded-lg text-[11px] font-bold transition-colors"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function AthletesTab({ event }: { event: any }) {
  const [athletes, setAthletes]     = useState<Athlete[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [page, setPage]             = useState(0);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [draft, setDraft]           = useState<EditState | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const fetchAthletes = useCallback(async () => {
    if (!event) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('athletes')
        .select(`
          id, first_name, last_name, date_of_birth,
          position, parent_email, parent_phone,
          bands(display_number),
          results(id)
        `)
        .eq('event_id', event.id)
        .order('last_name', { ascending: true });

      setAthletes(
        (data ?? []).map((a: any) => ({
          id:            a.id,
          first_name:    a.first_name,
          last_name:     a.last_name,
          date_of_birth: a.date_of_birth,
          position:      a.position ?? '',
          parent_email:  a.parent_email,
          parent_phone:  a.parent_phone,
          band_number:   a.bands?.display_number,
          result_count:  a.results?.length ?? 0,
        }))
      );
    } finally {
      setLoading(false);
    }
  }, [event]);

  useEffect(() => { fetchAthletes(); }, [fetchAthletes]);
  useEffect(() => { setPage(0); }, [search]);

  function startEdit(a: Athlete) {
    setEditingId(a.id);
    setSaveError(null);
    setDraft({
      first_name:    a.first_name,
      last_name:     a.last_name,
      date_of_birth: a.date_of_birth ?? '',
      parent_email:  a.parent_email,
      position:      a.position,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setSaveError(null);
  }

  async function saveEdit(athleteId: string) {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);

    // Client-side guard
    if (!draft.first_name.trim() || !draft.last_name.trim()) {
      setSaveError('Name is required.');
      setSaving(false);
      return;
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.parent_email);
    if (!emailOk) {
      setSaveError('Please enter a valid email address.');
      setSaving(false);
      return;
    }

    const { error } = await supabase
      .from('athletes')
      .update({
        first_name:    draft.first_name.trim(),
        last_name:     draft.last_name.trim(),
        date_of_birth: draft.date_of_birth || null,
        parent_email:  draft.parent_email.toLowerCase().trim(),
        position:      draft.position,
      })
      .eq('id', athleteId);

    if (error) {
      setSaveError(error.message.includes('check') || error.message.includes('constraint')
        ? 'Invalid data — please check all fields.'
        : error.message
      );
      setSaving(false);
      return;
    }

    // Optimistic update
    setAthletes(prev => prev.map(a =>
      a.id === athleteId
        ? { ...a, ...draft, first_name: draft.first_name.trim(), last_name: draft.last_name.trim() }
        : a
    ));

    setSaving(false);
    setEditingId(null);
    setDraft(null);
    setSavedFlash(athleteId);
    setTimeout(() => setSavedFlash(null), 2000);
  }

  const filtered = athletes.filter(a => {
    const q = search.toLowerCase();
    return (
      `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
      a.parent_email.toLowerCase().includes(q) ||
      (a.band_number?.toString() ?? '').includes(q) ||
      a.position.toLowerCase().includes(q)
    );
  });

  const paginated  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  if (!event) return (
    <div className="p-8 text-center text-zinc-400">Select an event to manage athletes.</div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Athletes</h2>
          <p className="text-sm text-zinc-500 mt-0.5">
            {filtered.length} of {athletes.length} athletes
            {search && ` matching "${search}"`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAthletes}
            disabled={loading}
            className="p-2 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-zinc-500 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name, email, band #, position..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-72"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-zinc-400 text-sm animate-pulse">Loading athletes...</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-100">
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500"># / Band</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Name</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Date of Birth</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Parent Email</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Position</th>
                <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {paginated.map(a => (
                editingId === a.id && draft ? (
                  <EditRow
                    key={a.id}
                    draft={draft}
                    onChange={(field, val) => setDraft(prev => prev ? { ...prev, [field]: val } : null)}
                    onSave={() => saveEdit(a.id)}
                    onCancel={cancelEdit}
                    saving={saving}
                    error={saveError}
                  />
                ) : (
                  <tr key={a.id} className="hover:bg-zinc-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-black text-lg text-zinc-300 font-mono">
                        {a.band_number ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-bold text-sm">{a.first_name} {a.last_name}</p>
                          <p className="text-[10px] text-zinc-400 font-mono">{a.result_count} result{a.result_count !== 1 ? 's' : ''}</p>
                        </div>
                        {savedFlash === a.id && (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-zinc-600">{a.date_of_birth ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-zinc-500 truncate max-w-[180px] block">{a.parent_email}</span>
                    </td>
                    <td className="px-4 py-3">
                      <PosBadge pos={a.position} />
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => startEdit(a)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-700 rounded-lg text-xs font-bold transition-colors"
                      >
                        <Pencil className="w-3 h-3" />
                        Edit
                      </button>
                    </td>
                  </tr>
                )
              ))}

              {paginated.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-400 text-sm">
                    {search ? `No athletes matching "${search}"` : 'No athletes registered for this event.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <p className="text-xs text-zinc-500">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-2 bg-white border border-zinc-200 rounded-lg disabled:opacity-30 hover:bg-zinc-50 transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-bold text-zinc-600">Page {page + 1} of {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-2 bg-white border border-zinc-200 rounded-lg disabled:opacity-30 hover:bg-zinc-50 transition-all"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
