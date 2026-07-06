/**
 * ResultsTab.tsx
 * Core Elite — Mission T: Virtualization Engine
 *
 * Virtualized, dark-mode admin results ledger. Same rendering bounds as
 * AthletesTab — only the rows in the viewport (plus overscan) hit the DOM.
 *
 * Edit semantics match the original:
 *   - Inline numeric edit of value_num
 *   - Reason string captured in meta.audit.reason
 *   - Previous value snapshotted in meta.audit.previous_value
 *   - edited_by / edited_at stamped server-side view on meta.audit
 *
 * Layout + data strategy mirror AthletesTab.tsx — see that file's header for
 * the reasoning behind CSS grid (not <table>), fixed row heights, shared
 * COLS template, and the 10k local-cache fetch cap.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import {
  Search, Pencil, CheckCircle2, X, AlertTriangle,
  AlertCircle, RefreshCw, Activity,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResultRow {
  id:           string;
  drill_type:   string;
  value_num:    number;
  recorded_at:  string;
  meta?: {
    outlier?: boolean;
    audit?: {
      edited_by?:      string;
      edited_at?:      string;
      previous_value?: number;
      reason?:         string;
    };
  } | null;
  athletes?: { first_name: string; last_name: string } | null;
  bands?:    { display_number: number } | null;
}

interface EditDraft {
  value:  string;
  reason: string;
}

// Fixed heights — virtualizer's fastest path, zero remeasure during scroll.
const ROW_HEIGHT        = 64;
const EDIT_ROW_HEIGHT   = 96;
const SCROLL_VIEWPORT_H = 640;
const FETCH_CAP         = 10_000;

// Single column template shared between header row and virtualized data rows.
const COLS = 'minmax(220px, 1.4fr) minmax(110px, 130px) minmax(180px, 1fr) minmax(160px, 200px) minmax(110px, 130px)';

// ─── Drill badge ──────────────────────────────────────────────────────────────

function DrillBadge({ drill }: { drill: string }) {
  return (
    <span className="px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] font-black uppercase tracking-widest text-zinc-400">
      {drill || '—'}
    </span>
  );
}

// ─── Inline edit row ──────────────────────────────────────────────────────────

function EditRow({
  result, draft, onChange, onSave, onCancel, saving, error,
}: {
  result:   ResultRow;
  draft:    EditDraft;
  onChange: (field: keyof EditDraft, value: string) => void;
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
      {/* Athlete column — read-only display */}
      <div className="min-w-0">
        <p className="font-bold text-sm text-zinc-100 truncate">
          {result.athletes?.first_name} {result.athletes?.last_name}
        </p>
        <p className="text-[10px] text-zinc-500 font-mono">
          #{result.bands?.display_number ?? '—'}
        </p>
      </div>

      {/* Drill column — read-only */}
      <div><DrillBadge drill={result.drill_type} /></div>

      {/* Value + reason */}
      <div className="grid grid-cols-[90px,1fr] gap-2">
        <div className="space-y-0.5">
          <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Value</label>
          <input
            type="number"
            step="0.01"
            className={inputCls}
            value={draft.value}
            onChange={e => onChange('value', e.target.value)}
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Reason</label>
          <input
            type="text"
            placeholder="Audit reason..."
            className={inputCls}
            value={draft.reason}
            onChange={e => onChange('reason', e.target.value)}
          />
        </div>
      </div>

      {/* Recorded — stays visible so the admin knows which reading they're editing */}
      <span className="text-[11px] font-mono text-zinc-500">
        {new Date(result.recorded_at).toLocaleString()}
      </span>

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
  result:      ResultRow;
  savedFlash:  boolean;
  onStartEdit: () => void;
}

const DataRow = React.memo(function DataRow({ result, savedFlash, onStartEdit }: DataRowProps) {
  const audit = result.meta?.audit;
  return (
    <div
      className="grid gap-3 px-4 items-center border-b border-zinc-900 hover:bg-zinc-900/60 transition-colors"
      style={{ gridTemplateColumns: COLS, height: ROW_HEIGHT }}
    >
      {/* Athlete */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0">
          <p className="font-bold text-sm text-zinc-100 truncate">
            {result.athletes?.first_name} {result.athletes?.last_name}
          </p>
          <p className="text-[10px] text-zinc-500 font-mono">
            #{result.bands?.display_number ?? '—'}
          </p>
        </div>
        {savedFlash && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
      </div>

      {/* Drill */}
      <div><DrillBadge drill={result.drill_type} /></div>

      {/* Value + badges */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-black text-lg text-zinc-100 tabular-nums font-mono">
          {result.value_num}
        </span>
        {result.meta?.outlier && (
          <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
            Outlier
          </span>
        )}
        {audit && (
          <div className="group relative shrink-0">
            <AlertCircle className="w-3.5 h-3.5 text-[#c8a200]" />
            <div className="absolute bottom-full right-0 mb-2 w-56 p-2 bg-zinc-900 border border-zinc-800 text-zinc-200 text-[10px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-xl">
              <p className="font-black uppercase tracking-widest text-[9px] text-[#c8a200] mb-1">Edited</p>
              <p className="font-mono">
                prev: <span className="text-zinc-100">{audit.previous_value ?? '—'}</span>
              </p>
              {audit.reason && (
                <p className="mt-1 text-zinc-400">"{audit.reason}"</p>
              )}
              {audit.edited_at && (
                <p className="mt-1 text-zinc-500 font-mono text-[9px]">
                  {new Date(audit.edited_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Recorded */}
      <span className="text-[11px] font-mono text-zinc-500">
        {new Date(result.recorded_at).toLocaleString()}
      </span>

      {/* Actions */}
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

export function ResultsTab({ eventId }: { eventId: string }) {
  const [results, setResults]       = useState<ResultRow[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [draft, setDraft]           = useState<EditDraft | null>(null);
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const fetchResults = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const { data, count } = await supabase
        .from('results')
        .select(
          '*, athletes(first_name, last_name), bands(display_number)',
          { count: 'exact' },
        )
        .eq('event_id', eventId)
        .order('recorded_at', { ascending: false })
        .range(0, FETCH_CAP - 1);

      if (import.meta.env.DEV && typeof count === 'number' && count > FETCH_CAP) {
        console.warn(
          `[ResultsTab] Event has ${count} results but fetch is capped at ${FETCH_CAP}. ` +
          `Switch to cursor pagination before shipping this event.`,
        );
      }

      setResults((data ?? []) as ResultRow[]);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return results;
    return results.filter(r =>
      `${r.athletes?.first_name ?? ''} ${r.athletes?.last_name ?? ''}`.toLowerCase().includes(q) ||
      (r.bands?.display_number?.toString() ?? '').includes(q) ||
      r.drill_type.toLowerCase().includes(q),
    );
  }, [results, search]);

  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count:           filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize:    (index) => (filtered[index]?.id === editingId ? EDIT_ROW_HEIGHT : ROW_HEIGHT),
    overscan:        6,
    getItemKey:      (index) => filtered[index]?.id ?? index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [editingId, virtualizer]);

  function startEdit(r: ResultRow) {
    setEditingId(r.id);
    setSaveError(null);
    setDraft({
      value:  r.value_num.toString(),
      reason: '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setSaveError(null);
  }

  async function saveEdit(result: ResultRow) {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);

    const parsed = parseFloat(draft.value);
    if (!Number.isFinite(parsed)) {
      setSaveError('Value must be a number.');
      setSaving(false);
      return;
    }
    if (!draft.reason.trim()) {
      setSaveError('Audit reason is required.');
      setSaving(false);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();

    const newMeta = {
      ...(result.meta || {}),
      audit: {
        edited_by:      user?.id,
        edited_at:      new Date().toISOString(),
        previous_value: result.value_num,
        reason:         draft.reason.trim(),
      },
    };

    const { error } = await supabase
      .from('results')
      .update({
        value_num: parsed,
        meta:      newMeta,
      })
      .eq('id', result.id);

    if (error) {
      setSaveError(error.message);
      setSaving(false);
      return;
    }

    setResults(prev => prev.map(r =>
      r.id === result.id
        ? { ...r, value_num: parsed, meta: newMeta }
        : r,
    ));

    setSaving(false);
    setEditingId(null);
    setDraft(null);
    setSavedFlash(result.id);
    setTimeout(() => setSavedFlash(null), 2000);
  }

  if (!eventId) return (
    <div className="p-8 text-center text-zinc-500 text-sm font-mono uppercase tracking-widest">
      SELECT AN EVENT TO REVIEW RESULTS
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
            <Activity className="w-4 h-4 text-[#c8a200]" />
          </div>
          <div>
            <h2 className="text-xl font-black text-zinc-100 tracking-tight">Results</h2>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-500 mt-0.5">
              {filtered.length} of {results.length} recorded
              {search && ` · matching "${search}"`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchResults}
            disabled={loading}
            className="p-2 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 text-zinc-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              placeholder="Search athlete, band, or drill..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder:text-zinc-400 outline-none focus:ring-2 focus:ring-[#c8a200]/30 focus:border-[#c8a200]/30 w-72"
            />
          </div>
        </div>
      </div>

      {/* Virtualized container */}
      <div className="bg-zinc-950 rounded-2xl border border-zinc-900 overflow-hidden">
        <div
          className="grid gap-3 px-4 py-3 bg-zinc-900/60 border-b border-zinc-900"
          style={{ gridTemplateColumns: COLS }}
        >
          <HeaderCell>Athlete</HeaderCell>
          <HeaderCell>Drill</HeaderCell>
          <HeaderCell>Value</HeaderCell>
          <HeaderCell>Recorded</HeaderCell>
          <HeaderCell>Actions</HeaderCell>
        </div>

        {loading ? (
          <div className="p-12 text-center text-zinc-500 text-xs font-mono uppercase tracking-widest animate-pulse">
            LOADING RESULTS...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-zinc-500 text-xs font-mono uppercase tracking-widest">
            {search ? `NO RESULTS MATCHING "${search}"` : 'NO RESULTS RECORDED FOR THIS EVENT'}
          </div>
        ) : (
          <div
            ref={parentRef}
            className="overflow-auto"
            style={{ height: SCROLL_VIEWPORT_H, contain: 'strict' }}
          >
            <div
              style={{
                height:   virtualizer.getTotalSize(),
                width:    '100%',
                position: 'relative',
              }}
            >
              {virtualItems.map(vi => {
                const r         = filtered[vi.index];
                const isEditing = editingId === r.id && !!draft;

                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position:  'absolute',
                      top:       0,
                      left:      0,
                      width:     '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    {isEditing
                      ? <EditRow
                          result={r}
                          draft={draft!}
                          onChange={(f, v) => setDraft(prev => prev ? { ...prev, [f]: v } : null)}
                          onSave={() => saveEdit(r)}
                          onCancel={cancelEdit}
                          saving={saving}
                          error={saveError}
                        />
                      : <DataRow
                          result={r}
                          savedFlash={savedFlash === r.id}
                          onStartEdit={() => startEdit(r)}
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
