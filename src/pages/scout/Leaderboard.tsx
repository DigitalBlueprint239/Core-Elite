/**
 * Leaderboard.tsx
 * Core Elite — Scout View · L1 + inline L2
 *
 * High-information-density scout leaderboard. Three disclosure levels:
 *
 *   L1 — Position group view. Every supported position renders as its own
 *        bento card; each card lists the top 10 athletes by composite
 *        percentile. Row height is locked at h-10 so a 10-row card is a
 *        deterministic 400-px box. The card is a fixed-height scroll
 *        container so the inline L2 expansion below never moves the
 *        sibling cards (no parent CLS).
 *
 *   L2 — Inline drill breakdown. Tapping a row reveals the athlete's
 *        per-drill percentile bars *inside the same card*. The expansion
 *        scrolls within the card; the card's outer dimensions are stable.
 *
 *   L3 — Full athlete report. From L2, "Open report →" navigates to
 *        `/scout/athletes/:id` (AthleteDetail.tsx). Out of scope here.
 *
 * Local-first cache strategy:
 *   - Module-level Map keyed by event_id.
 *   - First render reads from cache → instantaneous if warm.
 *   - useEffect kicks off a Supabase fetch in the background, updates
 *     state on resolution, and writes back to cache (stale-while-
 *     revalidate). Cold first paint shows the skeleton briefly; warm
 *     paint is sub-100ms because state is seeded from cache before
 *     the first render commits.
 *
 * No light-mode classes anywhere. No marketing prose. No animations
 * that move sibling content.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Sparkles, Trophy } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  getPercentiles,
  type DrillId,
  type Position,
  type PercentileResult,
} from '../../lib/scoring';
import { PercentileBar } from '../../components/scout/PercentileBar';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Position groups rendered as columns / cards. Order follows recruiter
// priority — skill positions first, line second, special teams trailing.
const POSITION_GROUPS: readonly Position[] = [
  'QB', 'RB', 'WR', 'TE',
  'OL', 'DL', 'LB', 'DB',
] as const;

// Drill order shown inside L2. Mirrors the BES weighting hierarchy so the
// most informative metrics surface first regardless of athlete grade.
const DRILL_ORDER: readonly DrillId[] = [
  'forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad',
] as const;

const DRILL_LABELS: Record<DrillId, string> = {
  forty:           '40 YD',
  ten_split:       '10 SPLIT',
  shuttle_5_10_5:  '5-10-5',
  vertical:        'VERT',
  broad:           'BROAD',
};

const DRILL_UNIT: Record<DrillId, 's' | 'in'> = {
  forty:           's',
  ten_split:       's',
  shuttle_5_10_5:  's',
  vertical:        'in',
  broad:           'in',
};

// Top-N per position group. Spec mandates 10.
const TOP_N = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DrillCell {
  drillId:    DrillId;
  value:      number;
  percentile: number;
}

interface AthleteRow {
  id:           string;
  first_name:   string;
  last_name:    string;
  position:     Position;
  band_number:  number | null;
  composite:    number;                // mean of available drill percentiles
  drills:       Partial<Record<DrillId, DrillCell>>;
}

interface LeaderboardData {
  groups:    Record<string, AthleteRow[]>;   // keyed by position
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Local-first cache — module-level, survives re-mounts within the same
// browser session. Keyed by event_id (or 'all' for cross-event view).
// ---------------------------------------------------------------------------

const _scoutCache = new Map<string, LeaderboardData>();

function readCache(eventId: string | null): LeaderboardData | null {
  return _scoutCache.get(eventId ?? 'all') ?? null;
}

function writeCache(eventId: string | null, data: LeaderboardData): void {
  _scoutCache.set(eventId ?? 'all', data);
}

// ---------------------------------------------------------------------------
// Data fetch + composite computation
//
// Single round-trip pulls athletes joined to results. Percentiles come
// from the local scoring engine — no server round-trip per athlete.
// ---------------------------------------------------------------------------

interface RawAthleteRow {
  id:          string;
  first_name:  string;
  last_name:   string;
  position:    string;
  bands:       { display_number: number | null } | null;
  results:     Array<{ drill_type: string; value_num: number }> | null;
}

function isPosition(p: string): p is Position {
  return (POSITION_GROUPS as readonly string[]).includes(p);
}

function isDrillId(d: string): d is DrillId {
  return (DRILL_ORDER as readonly string[]).includes(d);
}

function buildAthleteRow(raw: RawAthleteRow): AthleteRow | null {
  if (!isPosition(raw.position)) return null;

  // Take the BEST raw value per drill — direction-aware:
  //   timed drills (lower is better) → MIN
  //   distance drills (higher is better) → MAX
  // The scoring engine handles the percentile direction, but we still need
  // a single canonical value per drill to feed it.
  const best: Partial<Record<DrillId, number>> = {};
  for (const r of raw.results ?? []) {
    if (!isDrillId(r.drill_type)) continue;
    const v = Number(r.value_num);
    if (!Number.isFinite(v)) continue;
    const lowerIsBetter = r.drill_type === 'forty'
                       || r.drill_type === 'ten_split'
                       || r.drill_type === 'shuttle_5_10_5';
    const prev = best[r.drill_type];
    if (prev === undefined) best[r.drill_type] = v;
    else best[r.drill_type] = lowerIsBetter ? Math.min(prev, v) : Math.max(prev, v);
  }

  const measurements = (Object.keys(best) as DrillId[]).map((drillId) => ({
    drillId,
    value: best[drillId] as number,
  }));

  if (measurements.length === 0) return null;

  const percentiles: PercentileResult[] = getPercentiles(measurements, raw.position);

  const drills: Partial<Record<DrillId, DrillCell>> = {};
  let total = 0;
  for (const p of percentiles) {
    drills[p.drillId] = {
      drillId:    p.drillId,
      value:      p.value,
      percentile: p.percentile,
    };
    total += p.percentile;
  }
  const composite = total / percentiles.length;

  return {
    id:          raw.id,
    first_name:  raw.first_name,
    last_name:   raw.last_name,
    position:    raw.position,
    band_number: raw.bands?.display_number ?? null,
    composite,
    drills,
  };
}

async function fetchLeaderboard(eventId: string | null): Promise<LeaderboardData> {
  let query = supabase
    .from('athletes')
    .select(
      'id, first_name, last_name, position, ' +
      'bands(display_number), ' +
      'results(drill_type, value_num)',
    )
    .order('last_name', { ascending: true })
    .range(0, 9_999);

  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) throw error;

  const groups: Record<string, AthleteRow[]> = {};
  for (const pos of POSITION_GROUPS) groups[pos] = [];

  // Supabase returns a relational join with parametric typing that doesn't
  // narrow cleanly to RawAthleteRow — go through `unknown` so the cast is
  // explicit at the type-system boundary, not silent.
  for (const raw of ((data ?? []) as unknown as RawAthleteRow[])) {
    const row = buildAthleteRow(raw);
    if (!row) continue;
    groups[row.position].push(row);
  }

  for (const pos of POSITION_GROUPS) {
    groups[pos].sort((a, b) => b.composite - a.composite);
    groups[pos] = groups[pos].slice(0, TOP_N);
  }

  return { groups, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface LeaderboardProps {
  /** Optional event filter. Omit / null to view across every event. */
  eventId?: string | null;
}

export default function Leaderboard({ eventId = null }: LeaderboardProps) {
  // Seed state from cache so the first commit is sub-100ms when warm.
  const initial = useMemo(() => readCache(eventId), [eventId]);
  const [data,    setData]    = useState<LeaderboardData | null>(initial);
  const [loading, setLoading] = useState<boolean>(initial == null);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fresh = await fetchLeaderboard(eventId);
        if (cancelled) return;
        writeCache(eventId, fresh);
        setData(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load leaderboard.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Sticky glassmorphism header */}
      <div className="sticky top-0 z-30 backdrop-blur-md bg-slate-900/80 border-b border-slate-700/50">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-400/10 border border-cyan-400/30">
              <Trophy className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-tight">SCOUT BOARD</h1>
              <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-slate-500">
                Top {TOP_N} per position · BES composite
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 tabular-nums">
            {data?.fetchedAt != null && (
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {new Date(data.fetchedAt).toLocaleTimeString()}
              </span>
            )}
            {loading && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-cyan-400">
                <Sparkles className="w-3 h-3 animate-pulse" />
                hydrating
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-6">
        {error && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-red-200 text-xs font-mono">
            {error}
          </div>
        )}

        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {POSITION_GROUPS.map((pos) => (
            <PositionCard
              key={pos}
              position={pos}
              athletes={data?.groups[pos] ?? []}
              skeleton={loading && data == null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PositionCard — one bento per position group
//
// The card is a fixed-height container (h-[28rem]) with internal scroll.
// Inline L2 expansion happens INSIDE this scroll container, so siblings
// never reflow — zero layout shift to the parent grid.
// ---------------------------------------------------------------------------

function PositionCard({
  position,
  athletes,
  skeleton,
}: {
  position:  Position;
  athletes:  AthleteRow[];
  skeleton:  boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="h-[28rem] flex flex-col rounded-2xl border border-slate-700/50 bg-slate-900/60 overflow-hidden">
      {/* Card header */}
      <div className="shrink-0 px-4 py-3 backdrop-blur-md bg-slate-900/80 border-b border-slate-700/50 flex items-center justify-between">
        <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">
          {position}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 tabular-nums">
          {skeleton ? '—' : `${athletes.length}/${TOP_N}`}
        </span>
      </div>

      {/* Scroll viewport — fixed parent height, internal scroll. */}
      <div className="flex-1 overflow-y-auto">
        {skeleton ? (
          <SkeletonRows />
        ) : athletes.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[10px] font-mono uppercase tracking-widest text-slate-600">
            no athletes
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {athletes.map((a, idx) => (
              <li key={a.id}>
                <AthleteRowL1
                  rank={idx + 1}
                  athlete={a}
                  expanded={expandedId === a.id}
                  onToggle={() => setExpandedId((cur) => (cur === a.id ? null : a.id))}
                />
                {expandedId === a.id && <AthleteRowL2 athlete={a} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AthleteRowL1 — strict h-10 row (40 px). All metric columns tabular-nums.
// ---------------------------------------------------------------------------

function AthleteRowL1({
  rank,
  athlete,
  expanded,
  onToggle,
}: {
  rank:      number;
  athlete:   AthleteRow;
  expanded:  boolean;
  onToggle:  () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full h-10 px-3 flex items-center gap-3 text-left transition-colors tabular-nums ${
        expanded
          ? 'bg-cyan-400/5 border-l-2 border-cyan-400'
          : 'hover:bg-slate-800/40 border-l-2 border-transparent'
      }`}
      aria-expanded={expanded}
    >
      {/* Rank — fixed-width cell so names align */}
      <span className="w-6 text-[10px] font-mono text-slate-600 shrink-0">
        {rank.toString().padStart(2, '0')}
      </span>

      {/* Name — single line, ellipsised. Last-name dominant. */}
      <span className="flex-1 min-w-0 text-sm font-bold text-slate-100 truncate">
        <span className="text-slate-400 font-medium">{athlete.first_name} </span>
        {athlete.last_name.toUpperCase()}
      </span>

      {/* Composite — tabular-nums, cyan accent */}
      <span className="shrink-0 text-sm font-black text-cyan-400 w-10 text-right">
        {athlete.composite.toFixed(0)}
      </span>

      <ChevronRight
        className={`shrink-0 w-3 h-3 text-slate-600 transition-transform ${expanded ? 'rotate-90 text-cyan-400' : ''}`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// AthleteRowL2 — inline drill breakdown. Stays inside the parent scroll
// container; the card's outer height is fixed so siblings do not reflow.
// ---------------------------------------------------------------------------

function AthleteRowL2({ athlete }: { athlete: AthleteRow }) {
  const cells = DRILL_ORDER.map((drillId) => ({
    drillId,
    cell: athlete.drills[drillId] ?? null,
  }));

  return (
    <div className="px-4 py-3 bg-slate-950/40 border-t border-slate-800/60 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
        {cells.map(({ drillId, cell }) => (
          <PercentileBar
            key={drillId}
            label={DRILL_LABELS[drillId]}
            percentile={cell?.percentile ?? 0}
            rawValue={cell ? `${cell.value.toFixed(2)}${DRILL_UNIT[drillId]}` : '—'}
            compact
          />
        ))}
      </div>

      <div className="pt-1 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest tabular-nums">
        <span className="text-slate-500">
          {athlete.band_number != null ? `BAND #${athlete.band_number}` : ''}
        </span>
        <Link
          to={`/scout/athletes/${athlete.id}`}
          className="text-cyan-400 hover:text-cyan-300 transition-colors"
        >
          OPEN REPORT →
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonRows — minimal loading affordance. No spinning animations,
// just a stable grid that matches the eventual h-10 row layout so cold
// paint and warm paint have identical geometry (zero CLS).
// ---------------------------------------------------------------------------

function SkeletonRows() {
  return (
    <ul className="divide-y divide-slate-800/60" aria-hidden>
      {Array.from({ length: TOP_N }).map((_, i) => (
        <li key={i} className="h-10 px-3 flex items-center gap-3">
          <span className="w-6 h-2 bg-slate-800 rounded" />
          <span className="flex-1 h-2 bg-slate-800 rounded" />
          <span className="w-10 h-2 bg-slate-800 rounded" />
        </li>
      ))}
    </ul>
  );
}
