/**
 * AthletesTab.tsx
 * Core Elite — Mission T: Virtualization Engine
 *
 * Virtualized, dark-mode admin roster. DOM-level rendering is bounded to the
 * rows currently inside the viewport (plus an overscan buffer), so scroll-
 * through-2000-athletes stays flat at 60fps on an iPad.
 *
 * Layout strategy:
 *   - No <table>. Native table layout fights virtualization because the
 *     browser wants to lay out all <tr> elements to compute column widths.
 *   - Column widths are fixed by a single CSS grid-template-columns string
 *     shared between the header row and every virtualized data row, so
 *     columns stay aligned without any table magic.
 *   - Hover + edit state changes only toggle background/border — never
 *     affect row height — so the virtualizer's cached size map stays stable
 *     and there are no layout-shift jolts during scroll.
 *
 * Data strategy:
 *   - Single Supabase fetch with .range(0, 9999) (10k cap — more than any
 *     real event). Results live in memory and in-memory search filters the
 *     list. This is the "aggressive local caching" path from the directive,
 *     chosen over cursor pagination because client-side search over a live
 *     roster is a core admin workflow.
 *   - For events >10k athletes we log a single dev-mode warning. Switch to
 *     cursor-based infinite scroll at that point, not before.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import {
  Search, Pencil, CheckCircle2, X, AlertTriangle,
  RefreshCw, Users,
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

// Row height in px. Fixed height is the virtualizer's fastest path — no
// measurement pass, no size cache invalidation during scroll.
const ROW_HEIGHT        = 64;
const EDIT_ROW_HEIGHT   = 120;
const SCROLL_VIEWPORT_H = 640; // 640px viewport keeps ~10 rows visible
const FETCH_CAP         = 10_000;

// Single column template shared between header and every virtualized row.
// Keeps column widths stable without a real <table> and zero layout shift.
const COLS = 'minmax(80px, 100px) minmax(200px, 1.4fr) minmax(120px, 140px) minmax(200px, 1.2fr) minmax(90px, 120px) minmax(100px, 120px)';

// ─── Position badge ───────────────────────────────────────────────────────────

function PosBadge({ pos }: { pos: string }) {
  return (
    <span className="px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] font-black uppercase tracking-widest text-zinc-400">
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
  const inputCls =
    'w-full px-2 py-1.5 bg-zinc-950 border border-zinc-800 rounded-lg text-[13px] ' +
    'text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 ' +
    'focus:ring-[#c8a200]/40 focus:border-[#c8a200]/40 font-mono';

  return (
    <div
      className="grid gap-3 px-4 items-center bg-[#c8a200]/5 border-y border-[#c8a200]/30"
      style={{ gridTemplateColumns: COLS, height: EDIT_ROW_HEIGHT }}
    >
      {/* Band number column — stay blank, edit happens elsewhere */}
      <div />

      {/* Name — two-field packed grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">First</label>
          <input
            className={inputCls}
            value={draft.first_name}
            onChange={e => onChange('first_name', e.target.value)}
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Last</label>
          <input
            className={inputCls}
            value={draft.last_name}
            onChange={e => onChange('last_name', e.target.value)}
          />
        </div>
      </div>

      {/* Date of birth */}
      <div className="space-y-0.5">
        <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">DoB</label>
        <input
          type="date"
          className={inputCls}
          value={draft.date_of_birth}
          onChange={e => onChange('date_of_birth', e.target.value)}
        />
      </div>

      {/* Email */}
      <div className="space-y-0.5">
        <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Parent Email</label>
        <input
          type="email"
          className={inputCls}
          value={draft.parent_email}
          onChange={e => onChange('parent_email', e.target.value)}
        />
      </div>

      {/* Position */}
      <div className="space-y-0.5">
        <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Pos</label>
        <select
          className={inputCls}
          value={draft.position}
          onChange={e => onChange('position', e.target.value)}
        >
          <option value="">—</option>
          {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 items-end">
        {error && (
          <span className="text-[10px] text-red-400 font-medium flex items-center gap-1 self-start">
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
              : <CheckCircle2 className="w-3 h-3" />}
            Save
          </button>
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[11px] font-bold transition-colors"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Data row ─────────────────────────────────────────────────────────────────

interface DataRowProps {
  athlete:      Athlete;
  savedFlash:   boolean;
  onStartEdit:  () => void;
}

// Memoized so scrolling a row in/out of the overscan window doesn't re-render
// siblings. The virtualizer swaps the translateY transform — stable keyed
// children let React reuse DOM.
const DataRow = React.memo(function DataRow({ athlete, savedFlash, onStartEdit }: DataRowProps) {
  return (
    <div
      className="grid gap-3 px-4 items-center border-b border-zinc-900 hover:bg-zinc-900/60 transition-colors"
      style={{ gridTemplateColumns: COLS, height: ROW_HEIGHT }}
    >
      <span className="font-black text-lg text-zinc-500 font-mono tabular-nums">
        {athlete.band_number ?? '—'}
      </span>

      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0">
          <p className="font-bold text-sm text-zinc-100 truncate">
            {athlete.first_name} {athlete.last_name}
          </p>
          <p className="text-[10px] text-zinc-500 font-mono">
            {athlete.result_count} result{athlete.result_count !== 1 ? 's' : ''}
          </p>
        </div>
        {savedFlash && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
      </div>

      <span className="text-sm font-mono text-zinc-400">{athlete.date_of_birth ?? '—'}</span>

      <span className="text-xs text-zinc-500 truncate">{athlete.parent_email}</span>

      <div><PosBadge pos={athlete.position} /></div>

      <div>
        <button
          onClick={onStartEdit}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 rounded-lg text-xs font-bold transition-colors"
        >
          <Pencil className="w-3 h-3" />
          Edit
        </button>
      </div>
    </div>
  );
});

// ─── Main Component ───────────────────────────────────────────────────────────

export function AthletesTab({ event }: { event: any }) {
  const [athletes, setAthletes]     = useState<Athlete[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [draft, setDraft]           = useState<EditState | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const fetchAthletes = useCallback(async () => {
    if (!event) return;
    setLoading(true);
    try {
      // range(0, FETCH_CAP - 1) = up to 10k rows. Supabase's default limit
      // is 1000 — explicit range overrides that. For events >10k athletes,
      // swap this block for a cursor loop.
      const { data, count } = await supabase
        .from('athletes')
        .select(
          `id, first_name, last_name, date_of_birth,
           position, parent_email, parent_phone,
           bands(display_number),
           results(id)`,
          { count: 'exact' },
        )
        .eq('event_id', event.id)
        .order('last_name', { ascending: true })
        .range(0, FETCH_CAP - 1);

      if (import.meta.env.DEV && typeof count === 'number' && count > FETCH_CAP) {
        console.warn(
          `[AthletesTab] Event has ${count} athletes but fetch is capped at ${FETCH_CAP}. ` +
          `Switch to cursor pagination before shipping this event.`,
        );
      }

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
        })),
      );
    } finally {
      setLoading(false);
    }
  }, [event]);

  useEffect(() => { fetchAthletes(); }, [fetchAthletes]);

  // Filtered list — memoized so the virtualizer sees a stable reference
  // until search/athletes actually changes. Recomputing on every render
  // would invalidate the virtualizer's internal item list and force a
  // full remeasure (= dropped frames during keystroke).
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return athletes;
    return athletes.filter(a =>
      `${a.first_name} ${a.last_name}`.toLowerCase().includes(q) ||
      a.parent_email.toLowerCase().includes(q) ||
      (a.band_number?.toString() ?? '').includes(q) ||
      a.position.toLowerCase().includes(q),
    );
  }, [athletes, search]);

  // ─── Virtualizer ─────────────────────────────────────────────────────────
  // estimateSize returns the row's height. Edit rows are taller (form layout);
  // we signal that to the virtualizer so the scroll height math stays correct.
  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count:           filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize:    (index) => (filtered[index]?.id === editingId ? EDIT_ROW_HEIGHT : ROW_HEIGHT),
    overscan:        6,      // render ~6 off-screen rows each side for smooth scroll
    getItemKey:      (index) => filtered[index]?.id ?? index,
  });

  // When the editing target changes, row heights at that index change too —
  // ask the virtualizer to remeasure just those rows. Cheaper than a reset.
  useEffect(() => {
    virtualizer.measure();
  }, [editingId, virtualizer]);

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
      setSaveError(
        error.message.includes('check') || error.message.includes('constraint')
          ? 'Invalid data — please check all fields.'
          : error.message,
      );
      setSaving(false);
      return;
    }

    setAthletes(prev => prev.map(a =>
      a.id === athleteId
        ? { ...a, ...draft, first_name: draft.first_name.trim(), last_name: draft.last_name.trim() }
        : a,
    ));

    setSaving(false);
    setEditingId(null);
    setDraft(null);
    setSavedFlash(athleteId);
    setTimeout(() => setSavedFlash(null), 2000);
  }

  if (!event) return (
    <div className="p-8 text-center text-zinc-500 text-sm font-mono uppercase tracking-widest">
      SELECT AN EVENT TO MANAGE ATHLETES
    </div>
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-xl">
            <Users className="w-4 h-4 text-[#c8a200]" />
          </div>
          <div>
            <h2 className="text-xl font-black text-zinc-100 tracking-tight">Athletes</h2>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 mt-0.5">
              {filtered.length} of {athletes.length} on roster
              {search && ` · matching "${search}"`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchAthletes}
            disabled={loading}
            className="p-2 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-zinc-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Search name, email, band, position..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder:text-zinc-400 outline-none focus:ring-2 focus:ring-[#c8a200]/30 focus:border-[#c8a200]/30 w-72"
            />
          </div>
        </div>
      </div>

      {/* Virtualized container */}
      <div className="bg-zinc-950 rounded-2xl border border-zinc-900 overflow-hidden">
        {/* Header row — uses the shared COLS grid template so columns align
            pixel-perfect with the virtualized rows below. */}
        <div
          className="grid gap-3 px-4 py-3 bg-zinc-900/60 border-b border-zinc-900"
          style={{ gridTemplateColumns: COLS }}
        >
          <HeaderCell>Band</HeaderCell>
          <HeaderCell>Name</HeaderCell>
          <HeaderCell>Date of Birth</HeaderCell>
          <HeaderCell>Parent Email</HeaderCell>
          <HeaderCell>Position</HeaderCell>
          <HeaderCell>Actions</HeaderCell>
        </div>

        {/* Scroll viewport. Fixed height — virtualizer needs a bounded
            scroll container so it can compute which rows are in view. */}
        {loading ? (
          <div className="p-12 text-center text-zinc-500 text-xs font-mono uppercase tracking-widest animate-pulse">
            LOADING ROSTER...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 text-xs font-mono uppercase tracking-widest">
            {search ? `NO ATHLETES MATCHING "${search}"` : 'NO ATHLETES REGISTERED FOR THIS EVENT'}
          </div>
        ) : (
          <div
            ref={parentRef}
            className="overflow-auto"
            style={{ height: SCROLL_VIEWPORT_H, contain: 'strict' }}
          >
            {/* Spacer = total scroll height. Children use absolute positioning
                so only the visible rows actually mount. */}
            <div
              style={{
                height:   virtualizer.getTotalSize(),
                width:    '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map(vi => {
                const a         = filtered[vi.index];
                const isEditing = editingId === a.id && !!draft;

                return (
                  <div
                    key={vi.key}
                    // data-index lets the virtualizer correlate DOM → index
                    // for remeasurement when edit rows toggle size.
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top:      0,
                      left:     0,
                      width:    '100%',
                      // transform instead of top: pushes the browser onto the
                      // compositor thread, no main-thread layout per frame.
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {isEditing
                      ? <EditRow
                          draft={draft!}
                          onChange={(f, v) => setDraft(prev => prev ? { ...prev, [f]: v } : null)}
                          onSave={() => saveEdit(a.id)}
                          onCancel={cancelEdit}
                          saving={saving}
                          error={saveError}
                        />
                      : <DataRow
                          athlete={a}
                          savedFlash={savedFlash === a.id}
                          onStartEdit={() => startEdit(a)}
                        />}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">
      {children}
    </span>
  );
}
