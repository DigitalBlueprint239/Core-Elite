/**
 * LiveCommandCenter.tsx
 * Core Elite — Phase 3: Live Admin Command Center
 *
 * Three-panel real-time dashboard for Event Directors:
 *   Panel 1 — Global Event Stats (athletes seen, total results)
 *   Panel 2 — Station Throughput Grid (per drill, with bottleneck detection)
 *   Panel 3 — Live Feed (scrolling ticker of the 50 most recent results)
 *
 * Real-time strategy:
 *   Supabase Realtime postgres_changes subscription on results (INSERT).
 *   No polling. Seed query on mount loads the last SEED_WINDOW_HOURS of results.
 *
 * Performance strategy (Constraint 3):
 *   useReducer with object-identity-preserving updates: only the affected
 *   station's object gets a new reference on NEW_RESULT. All other station
 *   objects keep their prior reference. StationCard is React.memo with a
 *   custom comparator so unaffected cards are skipped entirely. LiveFeed is
 *   also memo'd and only updates when feed changes (every new result).
 *   A 10s tick (setInterval) drives idle/throughput refresh for station cards
 *   without triggering re-renders anywhere else.
 *
 * Bottleneck detection:
 *   If a drill has had no results in the last 3 minutes it is flagged 'idle'
 *   (amber). Throughput is expressed as results in the last 60 seconds.
 */

import React, {
  useEffect,
  useReducer,
  useCallback,
  memo,
} from 'react';
import {
  Activity,
  AlertTriangle,
  Radio,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { DRILL_CATALOG } from '../../constants';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Per-drill mutable statistics.
 * `athleteIds` is stored as a plain Record so it is safely immutable in the
 * reducer without requiring a Set (which cannot be trivially compared).
 * `uniqueAthletes` is derived from Object.keys(athleteIds).length at render.
 */
interface StationData {
  drillId: string;
  label: string;
  unit: string;
  totalResults: number;
  /** { [athleteId]: true } — plain object used as an identity set */
  athleteIds: Record<string, true>;
  lastResultAt: number | null;       // ms epoch; null until first result
  recentTimestamps: number[];        // pruned to WINDOW_MS for throughput calc
  resultsLastMinute: number;         // recomputed on TICK
  lastValue: number | null;
  status: 'active' | 'idle' | 'no_data';
}

interface FeedEntry {
  /** Stable key derived from result id — used as React list key */
  key: string;
  athleteId: string;
  drillId: string;
  drillLabel: string;
  unit: string;
  value: number;
  recordedAt: string;
  /** true when source_type = 'live_ble' (BLE hardware capture) */
  isLiveBle: boolean;
}

interface CCState {
  stations: Record<string, StationData>;
  feed: FeedEntry[];
  /** { [athleteId]: true } across all drills — global unique athlete count */
  globalAthleteIds: Record<string, true>;
  totalResults: number;
}

interface ResultRow {
  id: string;
  athlete_id: string;
  drill_type: string;
  value_num: number;
  recorded_at: string;
  validation_status: string;
  source_type?: string;
}

type Action =
  | { type: 'SEED';       results: ResultRow[]; now: number }
  | { type: 'NEW_RESULT'; result: ResultRow;    now: number }
  | { type: 'TICK';                             now: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const IDLE_THRESHOLD_MS    = 3 * 60 * 1_000;  // 3 min → amber "IDLE"
const WINDOW_MS            = 5 * 60 * 1_000;  // sliding window kept in recentTimestamps
const THROUGHPUT_WINDOW_MS =      60 * 1_000;  // 1 min for results/min metric
const MAX_FEED_ITEMS       = 50;
const TICK_INTERVAL_MS     = 10_000;            // 10 s status refresh
const SEED_WINDOW_HOURS    = 4;                 // look back N hours on mount

// Module-level constant — evaluated once. Safe to share across instances
// because the reducer never mutates state in place.
const INITIAL_STATE: CCState = buildInitialState();

// ─── State builder ────────────────────────────────────────────────────────────

function buildInitialState(): CCState {
  const stations: Record<string, StationData> = {};
  for (const drill of DRILL_CATALOG) {
    stations[drill.id] = {
      drillId: drill.id,
      label: drill.label,
      unit: drill.unit,
      totalResults: 0,
      athleteIds: {},
      lastResultAt: null,
      recentTimestamps: [],
      resultsLastMinute: 0,
      lastValue: null,
      status: 'no_data',
    };
  }
  return { stations, feed: [], globalAthleteIds: {}, totalResults: 0 };
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function deriveStatus(lastResultAt: number | null, now: number): StationData['status'] {
  if (lastResultAt === null) return 'no_data';
  return now - lastResultAt > IDLE_THRESHOLD_MS ? 'idle' : 'active';
}

function pruneWindow(timestamps: number[], now: number): number[] {
  return timestamps.filter(t => now - t < WINDOW_MS);
}

function countLastMinute(timestamps: number[], now: number): number {
  return timestamps.filter(t => now - t < THROUGHPUT_WINDOW_MS).length;
}

function toFeedEntry(r: ResultRow): FeedEntry {
  const drill = DRILL_CATALOG.find(d => d.id === r.drill_type);
  return {
    key:        r.id,
    athleteId:  r.athlete_id,
    drillId:    r.drill_type,
    drillLabel: drill?.label ?? r.drill_type,
    unit:       drill?.unit  ?? '',
    value:      r.value_num,
    recordedAt: r.recorded_at,
    isLiveBle:  r.source_type === 'live_ble',
  };
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state: CCState, action: Action): CCState {
  switch (action.type) {

    // ── Seed: populate from historical results ───────────────────────────
    case 'SEED': {
      const { results, now } = action;
      // Start from a fresh initial state so duplicate mounts don't double-count
      const next = buildInitialState();

      for (const r of results) {
        const s = next.stations[r.drill_type];
        if (!s) continue;
        const ts = new Date(r.recorded_at).getTime();

        s.totalResults += 1;
        s.athleteIds[r.athlete_id] = true;
        s.lastValue = r.value_num;
        if (s.lastResultAt === null || ts > s.lastResultAt) s.lastResultAt = ts;
        if (now - ts < WINDOW_MS) s.recentTimestamps.push(ts);
        next.globalAthleteIds[r.athlete_id] = true;
        next.totalResults += 1;
      }

      for (const s of Object.values(next.stations)) {
        s.resultsLastMinute = countLastMinute(s.recentTimestamps, now);
        s.status            = deriveStatus(s.lastResultAt, now);
      }

      // Seed feed: newest first, capped
      const sorted = [...results]
        .sort((a, b) =>
          new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
        )
        .slice(0, MAX_FEED_ITEMS);
      next.feed = sorted.map(toFeedEntry);

      return next;
    }

    // ── New result: only the affected station object gets a new reference ─
    case 'NEW_RESULT': {
      const { result: r, now } = action;
      const existing = state.stations[r.drill_type];
      if (!existing) return state;

      const ts           = new Date(r.recorded_at).getTime() || now;
      const isNewAthlete = !existing.athleteIds[r.athlete_id];
      const pruned       = pruneWindow([...existing.recentTimestamps, ts], now);

      const updatedStation: StationData = {
        ...existing,
        totalResults:       existing.totalResults + 1,
        athleteIds:         isNewAthlete
                              ? { ...existing.athleteIds, [r.athlete_id]: true }
                              : existing.athleteIds,
        lastResultAt:       ts,
        recentTimestamps:   pruned,
        resultsLastMinute:  countLastMinute(pruned, now),
        lastValue:          r.value_num,
        status:             'active',
      };

      return {
        // Spread preserves references of all OTHER station objects → their
        // React.memo cards will not re-render.
        stations:         { ...state.stations, [r.drill_type]: updatedStation },
        feed:             [toFeedEntry(r), ...state.feed].slice(0, MAX_FEED_ITEMS),
        globalAthleteIds: isNewAthlete
                            ? { ...state.globalAthleteIds, [r.athlete_id]: true }
                            : state.globalAthleteIds,
        totalResults:     state.totalResults + 1,
      };
    }

    // ── Tick: prune timestamps, recompute throughput + idle status ────────
    case 'TICK': {
      const { now } = action;
      let dirty = false;
      const nextStations: Record<string, StationData> = {};

      for (const [id, s] of Object.entries(state.stations)) {
        const pruned  = pruneWindow(s.recentTimestamps, now);
        const rpm     = countLastMinute(pruned, now);
        const status  = deriveStatus(s.lastResultAt, now);

        if (
          pruned.length !== s.recentTimestamps.length ||
          rpm           !== s.resultsLastMinute       ||
          status        !== s.status
        ) {
          nextStations[id] = { ...s, recentTimestamps: pruned, resultsLastMinute: rpm, status };
          dirty = true;
        } else {
          // Keep same object reference → StationCard memo will short-circuit
          nextStations[id] = s;
        }
      }

      return dirty ? { ...state, stations: nextStations } : state;
    }

    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

function useLiveCommandCenter(): CCState {
  const [state, rawDispatch] = useReducer(reducer, INITIAL_STATE);

  // dispatch is stable from useReducer; wrap only to get a named reference
  // for the dependency array comment below.
  const dispatch = useCallback(rawDispatch, [rawDispatch]);

  useEffect(() => {
    const mountTime = Date.now();
    const seedCutoff = new Date(
      mountTime - SEED_WINDOW_HOURS * 3_600_000
    ).toISOString();

    // ── Seed ─────────────────────────────────────────────────────────────
    supabase
      .from('results')
      .select(
        'id, athlete_id, drill_type, value_num, recorded_at, validation_status, source_type'
      )
      .gte('recorded_at', seedCutoff)
      .order('recorded_at', { ascending: false })
      .limit(2_000)
      .then(({ data, error }) => {
        if (error) {
          console.error('[LiveCommandCenter] Seed query failed:', error.message);
          return;
        }
        dispatch({
          type: 'SEED',
          results: (data ?? []) as ResultRow[],
          now: Date.now(),
        });
      });

    // ── Realtime subscription ─────────────────────────────────────────────
    // Filter excludes legacy_csv imports so bulk historical uploads do not
    // flood the live dashboard with synthetic station/band activity.
    const channel = supabase
      .channel('lcc-results-v1')
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'results',
          filter: 'source_type=neq.legacy_csv',
        },
        (payload) => {
          dispatch({
            type: 'NEW_RESULT',
            result: payload.new as ResultRow,
            now: Date.now(),
          });
        },
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.info('[LiveCommandCenter] Realtime channel active');
        }
        if (status === 'CHANNEL_ERROR') {
          console.error('[LiveCommandCenter] Channel error:', err);
        }
      });

    // ── Idle/throughput tick ──────────────────────────────────────────────
    const tickId = window.setInterval(() => {
      dispatch({ type: 'TICK', now: Date.now() });
    }, TICK_INTERVAL_MS);

    return () => {
      window.clearInterval(tickId);
      supabase.removeChannel(channel);
    };
  }, [dispatch]);

  return state;
}

// ─── GlobalStats panel ────────────────────────────────────────────────────────

interface GlobalStatsProps {
  totalResults: number;
  totalAthletes: number;
}

const GlobalStats = memo(function GlobalStats({
  totalResults,
  totalAthletes,
}: GlobalStatsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <StatTile
        icon={<Users className="w-5 h-5" />}
        label="Athletes Seen"
        value={totalAthletes}
        colorClass="text-sky-400"
      />
      <StatTile
        icon={<Activity className="w-5 h-5" />}
        label="Total Results"
        value={totalResults}
        colorClass="text-emerald-400"
      />
    </div>
  );
});

interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  colorClass: string;
}

function StatTile({ icon, label, value, colorClass }: StatTileProps) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className={`flex items-center gap-2 mb-3 ${colorClass}`}>
        {icon}
        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
          {label}
        </span>
      </div>
      <p className={`text-5xl font-black tabular-nums leading-none ${colorClass}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

// ─── StationCard ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  StationData['status'],
  {
    border:  string;
    badge:   string;
    dot:     string;
    label:   string;
  }
> = {
  active:  {
    border: 'border-emerald-500/50',
    badge:  'bg-emerald-500/15 text-emerald-300',
    dot:    'bg-emerald-400 animate-pulse',
    label:  'ACTIVE',
  },
  idle:    {
    border: 'border-amber-500/60',
    badge:  'bg-amber-500/15 text-amber-300',
    dot:    'bg-amber-400',
    label:  'IDLE',
  },
  no_data: {
    border: 'border-slate-700',
    badge:  'bg-slate-700 text-slate-500',
    dot:    'bg-slate-600',
    label:  'NO DATA',
  },
};

interface StationCardProps {
  station: StationData;
}

const StationCard = memo(
  function StationCard({ station }: StationCardProps) {
    const cfg           = STATUS_CONFIG[station.status];
    const uniqueCount   = Object.keys(station.athleteIds).length;
    const lastAgo       = station.lastResultAt
      ? formatAgo(Date.now() - station.lastResultAt)
      : null;

    return (
      <div
        className={`bg-slate-800 border-2 ${cfg.border} rounded-xl p-4 flex flex-col gap-3 transition-colors duration-500`}
      >
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-white font-black text-sm leading-tight">{station.label}</p>
            <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-0.5">
              {station.unit}
            </p>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest ${cfg.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
            {cfg.label}
          </span>
        </div>

        {/* ── Primary metrics ── */}
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Results" value={station.totalResults} large />
          <Metric label="Athletes" value={uniqueCount} large />
        </div>

        {/* ── Secondary metrics ── */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-700/80">
          <Metric label="/ min" value={station.resultsLastMinute} />
          {station.lastValue !== null && (
            <div>
              <p className="text-slate-500 text-[9px] font-bold uppercase tracking-widest">
                Last
              </p>
              <p className="text-white font-black text-base tabular-nums">
                {station.lastValue}{' '}
                <span className="text-slate-500 font-normal text-xs">{station.unit}</span>
              </p>
            </div>
          )}
        </div>

        {/* ── Idle warning banner ── */}
        {station.status === 'idle' && lastAgo && (
          <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-amber-300 text-xs font-bold">
              No result for {lastAgo}
            </span>
          </div>
        )}
      </div>
    );
  },
  // Custom comparator: skip re-render if all display-relevant fields are identical.
  // athleteIds uses reference equality — the reducer only allocates a new object
  // when a new athlete is seen at this station.
  (prev, next) => {
    const p = prev.station;
    const n = next.station;
    return (
      p.totalResults      === n.totalResults      &&
      p.resultsLastMinute === n.resultsLastMinute  &&
      p.lastResultAt      === n.lastResultAt       &&
      p.lastValue         === n.lastValue          &&
      p.status            === n.status             &&
      p.athleteIds        === n.athleteIds
    );
  },
);

interface MetricProps {
  label: string;
  value: number;
  large?: boolean;
}

function Metric({ label, value, large }: MetricProps) {
  return (
    <div>
      <p className="text-slate-500 text-[9px] font-bold uppercase tracking-widest">{label}</p>
      <p className={`text-white font-black tabular-nums ${large ? 'text-2xl' : 'text-lg'}`}>
        {value.toLocaleString()}
      </p>
    </div>
  );
}

// ─── LiveFeed panel ───────────────────────────────────────────────────────────

interface LiveFeedProps {
  entries: FeedEntry[];
}

const LiveFeed = memo(function LiveFeed({ entries }: LiveFeedProps) {
  return (
    <div className="overflow-y-auto flex-1">
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 gap-3 text-slate-600">
          <Radio className="w-6 h-6" />
          <p className="text-xs font-bold uppercase tracking-widest">
            Waiting for results…
          </p>
        </div>
      ) : (
        <ul>
          {entries.map(e => (
            <FeedRow key={e.key} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
});

const FeedRow = memo(function FeedRow({ entry }: { entry: FeedEntry }) {
  const timeStr = new Date(entry.recordedAt).toLocaleTimeString([], {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-800/80 hover:bg-slate-800/40 transition-colors">
      {/* BLE-verified accent bar */}
      <span
        aria-label={entry.isLiveBle ? 'Hardware verified' : 'Manual entry'}
        className={`w-1 h-5 rounded-full shrink-0 ${
          entry.isLiveBle ? 'bg-emerald-400' : 'bg-slate-600'
        }`}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-white font-black text-sm tabular-nums">
            {entry.value}
          </span>
          <span className="text-slate-500 text-xs">{entry.unit}</span>
          <span className="text-slate-300 text-xs font-bold truncate">
            — {entry.drillLabel}
          </span>
        </div>
        <p className="text-[10px] font-mono text-slate-600 truncate">
          {entry.athleteId.slice(0, 8)}…
        </p>
      </div>

      <span className="text-[10px] font-mono text-slate-500 tabular-nums shrink-0">
        {timeStr}
      </span>
    </li>
  );
});

// ─── Main export ──────────────────────────────────────────────────────────────

export default function LiveCommandCenter() {
  const state         = useLiveCommandCenter();
  const totalAthletes = Object.keys(state.globalAthleteIds).length;

  return (
    <div className="min-h-screen bg-slate-900 p-4 lg:p-6">

      {/* ── Page header ── */}
      <div className="flex items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-black uppercase tracking-tight text-white flex items-center gap-3">
            <Zap className="w-7 h-7 text-amber-400 shrink-0" />
            Live Command Center
          </h1>
          <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">
            Real-time combine monitoring
          </p>
        </div>
        <LivePill />
      </div>

      {/* ── Three-panel grid ──
          xl: [stats | throughput grid | live feed]
          lg: [stats + feed column | throughput grid]
          mobile: stacked
      ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[220px_1fr_300px] gap-5 items-start">

        {/* Panel 1 — Global Stats */}
        <section aria-label="Event statistics">
          <PanelHeading icon={<Users className="w-4 h-4" />} title="Event Stats" />
          <GlobalStats
            totalResults={state.totalResults}
            totalAthletes={totalAthletes}
          />
        </section>

        {/* Panel 2 — Station Throughput */}
        <section aria-label="Station throughput">
          <PanelHeading
            icon={<TrendingUp className="w-4 h-4" />}
            title="Station Throughput"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {DRILL_CATALOG.map(drill => {
              const station = state.stations[drill.id];
              return station ? (
                <StationCard key={drill.id} station={station} />
              ) : null;
            })}
          </div>
        </section>

        {/* Panel 3 — Live Feed */}
        <section aria-label="Live result feed" className="flex flex-col">
          <PanelHeading icon={<Radio className="w-4 h-4" />} title="Live Feed" />
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden flex flex-col max-h-[640px]">
            {/* Feed header */}
            <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {state.feed.length} results
              </span>
              <span className="flex items-center gap-1.5 text-[10px] font-mono text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            </div>
            <LiveFeed entries={state.feed} />
          </div>
        </section>

      </div>
    </div>
  );
}

// ─── Utility components ───────────────────────────────────────────────────────

function PanelHeading({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-slate-500">{icon}</span>
      <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
        {title}
      </h2>
    </div>
  );
}

function LivePill() {
  return (
    <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 shrink-0">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      <span className="text-xs font-black uppercase tracking-widest text-emerald-300">
        LIVE
      </span>
    </div>
  );
}

// ─── Utility function ─────────────────────────────────────────────────────────

function formatAgo(ms: number): string {
  if (ms < 60_000)   return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}
