import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion, AnimatePresence } from 'motion/react';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import {
  Trophy,
  Users,
  Filter,
  ArrowLeft,
  CheckSquare,
  Square,
  Printer,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Activity,
  Star,
  SlidersHorizontal,
  X,
  Zap,
  ShieldCheck,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { DRILL_CATALOG } from '../constants';
import { calculatePercentile, gradeFromPercentile, gradeColor } from '../lib/analytics';
import { generateArmsCSV, downloadCSV, buildExportFilename, type ExportableAthlete } from '../lib/b2b-exports';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResultRow {
  drill_type:        string;
  value_num:         number;
  attempt_number:    number;
  validation_status: 'clean' | 'extraordinary' | 'reviewed' | string;
  meta:              Record<string, any> | null;
}

interface AthleteRow {
  id:          string;
  first_name:  string;
  last_name:   string;
  position:    string;
  results:     ResultRow[];
  avgPct:      number | null;
  percentiles: Record<string, number | null>;
  // Best result per drill (use_best_attempt = true for all timed drills)
  bestResults: Record<string, ResultRow | undefined>;
}

// ---------------------------------------------------------------------------
// Data provenance helpers
// ---------------------------------------------------------------------------

type HardwareType = 'laser' | 'hand_timed' | 'stopwatch' | 'unverified';

function getHardwareType(meta: Record<string, any> | null): HardwareType {
  return (meta?.hardware_type as HardwareType) ?? 'unverified';
}

const HARDWARE_BADGE: Record<HardwareType, { label: string; cls: string }> = {
  laser:      { label: 'LASER', cls: 'bg-emerald-100 text-emerald-800 border border-emerald-200' },
  hand_timed: { label: 'HAND',  cls: 'bg-amber-100  text-amber-800  border border-amber-200'  },
  stopwatch:  { label: 'WATCH', cls: 'bg-amber-50   text-amber-700  border border-amber-100'  },
  unverified: { label: 'MAN',   cls: 'bg-zinc-100   text-zinc-500   border border-zinc-200'   },
};

function ProvenanceBadge({ meta, status }: { meta: Record<string, any> | null; status: string }) {
  const hw = getHardwareType(meta);
  const badge = HARDWARE_BADGE[hw];
  return (
    <div className="flex items-center gap-1">
      <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider ${badge.cls}`}>
        {badge.label}
      </span>
      {status === 'extraordinary' && (
        <span title="Flagged: extraordinary result pending review">
          <AlertTriangle className="w-3 h-3 text-amber-500" />
        </span>
      )}
      {status === 'reviewed' && (
        <span title="Admin-reviewed and accepted">
          <ShieldCheck className="w-3 h-3 text-blue-500" />
        </span>
      )}
      {(meta?.override_applied) && (
        <span title="Admin override applied">
          <Zap className="w-3 h-3 text-red-500" />
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attempt consistency
// ---------------------------------------------------------------------------

function ConsistencyLabel({ attempts }: { attempts: ResultRow[] }) {
  if (attempts.length < 2) return null;
  const vals = attempts.map(a => a.value_num);
  const delta = Math.max(...vals) - Math.min(...vals);
  // Use 0.1 as the unit-agnostic threshold (works for seconds and inches)
  const label   = delta <= 0.05 ? 'HIGH' : delta <= 0.15 ? 'MOD' : 'LOW';
  const cls     = delta <= 0.05
    ? 'text-emerald-600'
    : delta <= 0.15
    ? 'text-amber-600'
    : 'text-red-500';
  return (
    <span className={`text-[8px] font-black uppercase ${cls}`} title={`Attempt delta: ±${delta.toFixed(2)}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

const RADAR_DRILLS  = ['forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad'];
const RADAR_COLORS  = ['#c8a200', '#059669', '#3b82f6', '#f59e0b', '#8b5cf6'];

function buildRadarData(compareAthletes: AthleteRow[]) {
  return RADAR_DRILLS.map(drillId => {
    const drill = DRILL_CATALOG.find(d => d.id === drillId);
    const entry: Record<string, unknown> = {
      drill: drill?.label.replace(' Dash', '').replace('-Yard', 'yd') ?? drillId,
    };
    compareAthletes.forEach((a, i) => {
      entry[`athlete${i}`] = a.percentiles[drillId] ?? 0;
    });
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Head-to-head delta cell
// ---------------------------------------------------------------------------

function DeltaCell({
  value,
  best,
  unit,
  lowerIsBetter,
}: {
  value: number | undefined;
  best:  number | undefined;
  unit:  string;
  lowerIsBetter: boolean;
}) {
  if (value === undefined || best === undefined) {
    return <span className="text-zinc-200 text-xs">—</span>;
  }

  const isBest  = value === best;
  const delta   = Math.abs(value - best);
  const isWorse = lowerIsBetter ? value > best : value < best;

  const cellCls = isBest
    ? 'bg-emerald-50 border-l-2 border-emerald-400'
    : isWorse
    ? 'bg-red-50 border-l-2 border-red-300'
    : 'bg-zinc-50';

  return (
    <div className={`flex flex-col items-center gap-0.5 px-1 py-0.5 rounded ${cellCls}`}>
      {/* font-mono: machine-precision alignment for scouts scanning vertical columns */}
      <span className="font-mono font-bold text-zinc-900 text-xs tabular-nums">
        {value} {isBest && <span className="text-emerald-600">★</span>}
      </span>
      {!isBest && delta > 0 && (
        <span className={`font-mono text-[9px] font-bold tabular-nums ${isWorse ? 'text-red-500' : 'text-zinc-400'}`}>
          {isWorse ? '+' : '−'}{delta.toFixed(2)}{unit}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watchlist hook — persisted to localStorage
// ---------------------------------------------------------------------------

function useWatchlist() {
  const [watchlist, setWatchlist] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('ce_scout_watchlist');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback((id: string) => {
    setWatchlist(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem('ce_scout_watchlist', JSON.stringify([...next]));
      return next;
    });
  }, []);

  return { watchlist, toggle };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CoachPortal() {
  const { eventId } = useParams<{ eventId: string }>();

  const [athletes,     setAthletes]     = useState<AthleteRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [eventName,    setEventName]    = useState('');
  const [sortDrill,    setSortDrill]    = useState<string>('avgPct');
  const [sortDir,      setSortDir]      = useState<'desc' | 'asc'>('desc');
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [compareMode,  setCompareMode]  = useState(false);
  const [showFilters,  setShowFilters]  = useState(false);

  // Compound filter state
  const [posFilter,    setPosFilter]    = useState<string>('all');
  const [minPct,       setMinPct]       = useState<number>(0);
  const [watchlistOnly,setWatchlistOnly]= useState(false);
  // Per-drill max threshold (for speed drills) or min (for jump drills)
  const [drillMax40,   setDrillMax40]   = useState<string>('');
  const [drillMinVert, setDrillMinVert] = useState<string>('');

  const { watchlist, toggle: toggleWatchlist } = useWatchlist();

  // ---------------------------------------------------------------------------
  // Fetch — expanded to include attempt_number, validation_status, meta
  // ---------------------------------------------------------------------------
  const fetchData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const [{ data: eventData }, { data: athleteData }] = await Promise.all([
      supabase.from('events').select('name').eq('id', eventId).single(),
      supabase
        .from('athletes')
        .select(`
          id, first_name, last_name, position,
          results(drill_type, value_num, attempt_number, validation_status, meta)
        `)
        .eq('event_id', eventId)
        .order('created_at', { ascending: false }),
    ]);

    if (eventData) setEventName(eventData.name);

    const LOWER_IS_BETTER_SET = new Set(['forty', 'ten_split', 'shuttle_5_10_5', 'three_cone']);

    const rows: AthleteRow[] = (athleteData || []).map((a: any) => {
      const results: ResultRow[] = a.results || [];

      // Best result per drill: lowest for time drills, highest for jump/power
      const bestResults: Record<string, ResultRow | undefined> = {};
      for (const drill of DRILL_CATALOG) {
        const drillResults = results.filter(r => r.drill_type === drill.id);
        if (drillResults.length === 0) continue;
        bestResults[drill.id] = drillResults.reduce((best, r) => {
          if (!best) return r;
          return LOWER_IS_BETTER_SET.has(drill.id)
            ? r.value_num < best.value_num ? r : best
            : r.value_num > best.value_num ? r : best;
        });
      }

      // Percentiles computed from best result per drill
      const percentiles: Record<string, number | null> = {};
      for (const [drillId, best] of Object.entries(bestResults)) {
        if (best) percentiles[drillId] = calculatePercentile(best.value_num, drillId);
      }

      const validPcts = Object.values(percentiles).filter((p): p is number => p !== null);
      const avgPct    = validPcts.length > 0
        ? Math.round(validPcts.reduce((s, p) => s + p, 0) / validPcts.length)
        : null;

      return { ...a, results, percentiles, avgPct, bestResults };
    });

    setAthletes(rows);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const positions = useMemo(
    () => Array.from(new Set(athletes.map(a => a.position).filter(Boolean))).sort(),
    [athletes]
  );

  const LOWER_IS_BETTER_MAP: Record<string, boolean> = {
    forty: true, ten_split: true, shuttle_5_10_5: true, three_cone: true,
    vertical: false, broad: false, bench_reps: false,
  };

  // Compute best-per-drill across the whole event for delta highlighting
  const eventBests = useMemo(() => {
    const bests: Record<string, number> = {};
    for (const drill of DRILL_CATALOG) {
      const vals = athletes
        .map(a => a.bestResults[drill.id]?.value_num)
        .filter((v): v is number => v !== undefined);
      if (vals.length === 0) continue;
      bests[drill.id] = LOWER_IS_BETTER_MAP[drill.id]
        ? Math.min(...vals)
        : Math.max(...vals);
    }
    return bests;
  }, [athletes]);

  const filtered = useMemo(() => {
    const max40  = drillMax40   ? parseFloat(drillMax40)   : null;
    const minVert= drillMinVert ? parseFloat(drillMinVert) : null;

    return athletes
      .filter(a => {
        if (posFilter !== 'all' && a.position !== posFilter) return false;
        if (minPct > 0 && (a.avgPct ?? 0) < minPct)         return false;
        if (watchlistOnly && !watchlist.has(a.id))            return false;
        if (max40  !== null) {
          const v40 = a.bestResults['forty']?.value_num;
          if (v40 === undefined || v40 > max40) return false;
        }
        if (minVert !== null) {
          const vVert = a.bestResults['vertical']?.value_num;
          if (vVert === undefined || vVert < minVert) return false;
        }
        return true;
      })
      .sort((a, b) => {
        let pa: number, pb: number;
        if (sortDrill === 'avgPct') {
          pa = a.avgPct ?? -1;
          pb = b.avgPct ?? -1;
        } else {
          const lowerBetter = LOWER_IS_BETTER_MAP[sortDrill] ?? false;
          const va = a.bestResults[sortDrill]?.value_num;
          const vb = b.bestResults[sortDrill]?.value_num;
          pa = va !== undefined ? (lowerBetter ? -va : va) : -Infinity;
          pb = vb !== undefined ? (lowerBetter ? -vb : vb) : -Infinity;
        }
        return sortDir === 'desc' ? pb - pa : pa - pb;
      });
  }, [athletes, posFilter, minPct, watchlistOnly, watchlist, drillMax40, drillMinVert, sortDrill, sortDir]);

  const compareAthletes = athletes.filter(a => selected.has(a.id));

  // Export the currently filtered athlete list as an ARMS/JumpForward CSV.
  // Exports the filtered view so scouts can export exactly what they see
  // (e.g., "2026 Edge rushers with sub-4.7 40-yd" → export that cohort only).
  const handleArmsExport = useCallback(() => {
    const exportAthletes: ExportableAthlete[] = filtered.map(a => ({
      id:          a.id,
      first_name:  a.first_name,
      last_name:   a.last_name,
      position:    a.position,
      bestResults: a.bestResults,
      // Extended fields not yet on the AthleteRow client type — empty until
      // migration 015 adds high_school, grad_year, height, weight columns.
      high_school: undefined,
      grad_year:   undefined,
      height:      undefined,
      weight:      undefined,
    }));
    const csv      = generateArmsCSV(exportAthletes, eventName);
    const filename = buildExportFilename(eventName || 'event');
    downloadCSV(csv, filename);
  }, [filtered, eventName]);

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 4) next.add(id);
      return next;
    });
  }

  function handleSortCol(drillId: string) {
    if (sortDrill === drillId) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortDrill(drillId);
      // Time drills: ascending = fastest first; jump drills: descending = highest first
      setSortDir(LOWER_IS_BETTER_MAP[drillId] ? 'asc' : 'desc');
    }
  }

  const activeFilterCount = [
    posFilter !== 'all',
    minPct > 0,
    watchlistOnly,
    drillMax40  !== '',
    drillMinVert !== '',
  ].filter(Boolean).length;

  const numericDrills = DRILL_CATALOG.filter(d => d.type === 'numeric');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-zinc-50">

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="bg-white border-b border-zinc-200 px-8 py-4 sticky top-0 z-20 print:hidden">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin/dashboard" className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500 hover:text-zinc-900">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="h-8 w-px bg-zinc-200" />
            <div className="bg-zinc-900 text-white p-2 rounded-lg">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-black uppercase italic tracking-tighter">Scout Portal</h1>
              {eventName && <p className="text-xs text-zinc-400 font-medium">{eventName}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowFilters(f => !f)}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
                showFilters || activeFilterCount > 0
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
              }`}
            >
              <SlidersHorizontal className="w-4 h-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-amber-400 text-zinc-900 rounded-full text-[9px] font-black flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              onClick={() => { setCompareMode(m => !m); if (compareMode) setSelected(new Set()); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
                compareMode ? 'bg-amber-400 text-zinc-900' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
              }`}
            >
              <Users className="w-4 h-4" />
              {compareMode ? `Compare (${selected.size}/4)` : 'Compare'}
            </button>
            {watchlist.size > 0 && (
              <button
                onClick={() => setWatchlistOnly(w => !w)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
                  watchlistOnly ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
                }`}
              >
                <Star className="w-4 h-4" />
                Watchlist ({watchlist.size})
              </button>
            )}
            {/* ARMS / JumpForward / XOS export — exports the current filtered view */}
            <button
              onClick={handleArmsExport}
              disabled={filtered.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-bold transition-colors"
              title={`Export ${filtered.length} athlete${filtered.length !== 1 ? 's' : ''} to ARMS / JumpForward CSV`}
            >
              <ChevronRight className="w-4 h-4" />
              Export ARMS
            </button>
            <button onClick={() => window.print()} className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors">
              <Printer className="w-4 h-4" />
              Print
            </button>
            <button onClick={fetchData} className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-6 space-y-6">

        {/* ── God-Mode Filter Panel ─────────────────────────────────────── */}
        <AnimatePresence>
          {showFilters && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden print:hidden"
            >
              <div className="bg-white border border-zinc-200 rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm font-black uppercase tracking-wider text-zinc-700">God-Mode Filters</span>
                  </div>
                  {activeFilterCount > 0 && (
                    <button
                      onClick={() => {
                        setPosFilter('all');
                        setMinPct(0);
                        setWatchlistOnly(false);
                        setDrillMax40('');
                        setDrillMinVert('');
                      }}
                      className="text-xs font-bold text-zinc-400 hover:text-red-500 flex items-center gap-1 transition-colors"
                    >
                      <X className="w-3 h-3" />
                      Clear all
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {/* Position */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">Position</label>
                    <select
                      value={posFilter}
                      onChange={e => setPosFilter(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900"
                    >
                      <option value="all">All</option>
                      {positions.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>

                  {/* Min avg percentile */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      Min Avg Pct <span className="text-zinc-600 normal-case font-medium">({minPct}th+)</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={90}
                      step={5}
                      value={minPct}
                      onChange={e => setMinPct(Number(e.target.value))}
                      className="w-full accent-zinc-900"
                    />
                  </div>

                  {/* Max 40-yd */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      Max 40-Yd (sec)
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 4.7"
                      step="0.01"
                      value={drillMax40}
                      onChange={e => setDrillMax40(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                    />
                  </div>

                  {/* Min vertical */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      Min Vertical (in)
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 32"
                      step="0.5"
                      value={drillMinVert}
                      onChange={e => setDrillMinVert(e.target.value)}
                      className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                    />
                  </div>

                  {/* Watchlist filter */}
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-400">Watchlist</label>
                    <button
                      onClick={() => setWatchlistOnly(w => !w)}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-bold transition-colors border ${
                        watchlistOnly
                          ? 'bg-amber-50 border-amber-300 text-amber-800'
                          : 'bg-zinc-50 border-zinc-200 text-zinc-500 hover:border-zinc-400'
                      }`}
                    >
                      <Star className={`w-3.5 h-3.5 ${watchlistOnly ? 'fill-amber-400 text-amber-400' : ''}`} />
                      {watchlistOnly ? 'Starred Only' : 'All Athletes'}
                    </button>
                  </div>
                </div>

                <p className="text-[10px] text-zinc-400 font-medium">
                  Showing <span className="font-black text-zinc-700">{filtered.length}</span> of {athletes.length} athletes
                  {activeFilterCount > 0 ? ` · ${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active` : ''}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Leaderboard ──────────────────────────────────────────────── */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-14 bg-zinc-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-100">
                  {compareMode && <th className="px-4 py-4 w-10" />}
                  {/* Watchlist star column */}
                  <th className="px-3 py-4 w-8 print:hidden" />
                  <th className="px-4 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Rank</th>
                  <th className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Athlete</th>
                  <th className="px-4 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Pos</th>
                  {numericDrills.map(d => (
                    <th
                      key={d.id}
                      className="px-3 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-center cursor-pointer select-none hover:text-zinc-900 hover:bg-zinc-100 transition-colors whitespace-nowrap"
                      onClick={() => handleSortCol(d.id)}
                    >
                      <span className="flex items-center justify-center gap-1">
                        {d.label.split(' ')[0]}
                        {sortDrill === d.id && (
                          sortDir === 'desc'
                            ? <ChevronDown className="w-3 h-3 text-amber-500" />
                            : <ChevronUp   className="w-3 h-3 text-amber-500" />
                        )}
                      </span>
                    </th>
                  ))}
                  <th
                    className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-center cursor-pointer select-none hover:text-zinc-900 hover:bg-zinc-100 transition-colors"
                    onClick={() => handleSortCol('avgPct')}
                  >
                    <span className="flex items-center justify-center gap-1">
                      Avg
                      {sortDrill === 'avgPct' && (
                        sortDir === 'desc'
                          ? <ChevronDown className="w-3 h-3 text-amber-500" />
                          : <ChevronUp   className="w-3 h-3 text-amber-500" />
                      )}
                    </span>
                  </th>
                  <th className="px-4 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-center print:hidden">
                    Data
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={30} className="px-6 py-16 text-center text-zinc-400">
                      <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      No athletes match the current filters.
                    </td>
                  </tr>
                ) : (
                  filtered.map((athlete, idx) => {
                    const isSelected   = selected.has(athlete.id);
                    const isWatchlisted = watchlist.has(athlete.id);

                    // Determine worst provenance status across all of this athlete's best results
                    const worstStatus = (() => {
                      const statuses = Object.values(athlete.bestResults)
                        .filter(Boolean)
                        .map(r => r!.validation_status);
                      if (statuses.includes('extraordinary')) return 'extraordinary';
                      if (statuses.includes('reviewed'))      return 'reviewed';
                      return 'clean';
                    })();

                    // Aggregate hardware type — use the most-common non-unverified type
                    const hwTypes = Object.values(athlete.bestResults)
                      .filter(Boolean)
                      .map(r => getHardwareType(r!.meta));
                    const primaryHw = (hwTypes.find(h => h === 'laser') ??
                                       hwTypes.find(h => h !== 'unverified') ??
                                       'unverified') as HardwareType;
                    const hwMeta = { hardware_type: primaryHw };

                    return (
                      <tr
                        key={athlete.id}
                        className={`transition-colors ${
                          compareMode ? 'cursor-pointer' : ''
                        } ${isSelected ? 'bg-amber-50' : isWatchlisted ? 'bg-zinc-50/80' : 'hover:bg-zinc-50'}`}
                        onClick={compareMode ? () => toggleSelect(athlete.id) : undefined}
                      >
                        {compareMode && (
                          <td className="px-4 py-3 text-center">
                            {isSelected
                              ? <CheckSquare className="w-4 h-4 text-amber-600 mx-auto" />
                              : <Square      className="w-4 h-4 text-zinc-300 mx-auto" />
                            }
                          </td>
                        )}

                        {/* Watchlist star */}
                        <td className="px-3 py-3 print:hidden">
                          <button
                            onClick={e => { e.stopPropagation(); toggleWatchlist(athlete.id); }}
                            className="p-1 rounded-lg hover:bg-zinc-100 transition-colors"
                            title={isWatchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
                          >
                            <Star className={`w-3.5 h-3.5 transition-colors ${
                              isWatchlisted ? 'fill-amber-400 text-amber-400' : 'text-zinc-300 hover:text-zinc-500'
                            }`} />
                          </button>
                        </td>

                        <td className="px-4 py-3 font-black text-zinc-300 text-sm">
                          {idx + 1}
                        </td>

                        <td className="px-6 py-3">
                          <div className="font-bold text-zinc-900 whitespace-nowrap">
                            {athlete.first_name} {athlete.last_name}
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 bg-zinc-100 rounded text-[10px] font-black uppercase">
                            {athlete.position || '—'}
                          </span>
                        </td>

                        {numericDrills.map(d => {
                          const best = athlete.bestResults[d.id];
                          const pct  = best ? athlete.percentiles[d.id] : null;
                          const grade = pct !== null && pct !== undefined ? gradeFromPercentile(pct) : null;
                          const isCompareMode = compareMode && compareAthletes.length >= 2;

                          return (
                            <td key={d.id} className="px-3 py-3 text-center">
                              {best ? (
                                isCompareMode ? (
                                  <DeltaCell
                                    value={best.value_num}
                                    best={eventBests[d.id]}
                                    unit={d.unit === 'sec' ? 's' : '"'}
                                    lowerIsBetter={LOWER_IS_BETTER_MAP[d.id] ?? false}
                                  />
                                ) : (
                                  <div className="flex flex-col items-center gap-0.5">
                                    <span className="font-mono font-bold text-zinc-900 text-xs tabular-nums">{best.value_num}</span>
                                    {pct !== null && grade && (
                                      <span className={`font-mono px-1.5 py-0.5 rounded-full text-[9px] font-black tabular-nums ${gradeColor(grade)}`}>
                                        {pct}th
                                      </span>
                                    )}
                                  </div>
                                )
                              ) : (
                                <span className="text-zinc-200 text-xs">—</span>
                              )}
                            </td>
                          );
                        })}

                        {/* Avg percentile */}
                        <td className="px-6 py-3 text-center">
                          {athlete.avgPct !== null ? (
                            <span className="font-mono text-base font-black text-zinc-900 tabular-nums">
                              {athlete.avgPct}<span className="text-xs font-normal text-zinc-400">th</span>
                            </span>
                          ) : (
                            <span className="text-zinc-200 text-xs">—</span>
                          )}
                        </td>

                        {/* Provenance summary */}
                        <td className="px-4 py-3 print:hidden">
                          <div className="flex flex-col items-center gap-1">
                            <ProvenanceBadge meta={hwMeta} status={worstStatus} />
                            <ConsistencyLabel
                              attempts={athlete.results.filter(
                                r => r.drill_type === 'forty'
                              )}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Head-to-Head Delta Matrix (compare mode, 2–4 athletes) ────── */}
        <AnimatePresence>
          {compareMode && compareAthletes.length >= 2 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden"
            >
              <div className="px-8 py-5 border-b border-zinc-100 flex items-center justify-between">
                <h2 className="text-base font-black uppercase italic tracking-tighter">
                  Head-to-Head Matrix
                </h2>
                <div className="flex items-center gap-4 flex-wrap">
                  {compareAthletes.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-2 text-sm font-bold">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: RADAR_COLORS[i] }} />
                      {a.first_name} {a.last_name}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[10px] text-zinc-400 font-bold">
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded bg-emerald-100 border-l-2 border-emerald-400 inline-block" />
                    BEST
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded bg-red-50 border-l-2 border-red-300 inline-block" />
                    DEFICIT
                  </span>
                </div>
              </div>

              {/* Drill-by-drill delta rows */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-zinc-50 border-b border-zinc-100">
                      <th className="px-6 py-3 text-xs font-black uppercase tracking-widest text-zinc-400 text-left w-36">
                        Drill
                      </th>
                      {compareAthletes.map((a, i) => (
                        <th key={a.id} className="px-4 py-3 text-xs font-bold text-center" style={{ color: RADAR_COLORS[i] }}>
                          {a.first_name} {a.last_name.charAt(0)}.
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-50">
                    {numericDrills.map(d => {
                      const vals = compareAthletes.map(a => a.bestResults[d.id]?.value_num);
                      const definedVals = vals.filter((v): v is number => v !== undefined);
                      if (definedVals.length === 0) return null;

                      const lowerBetter = LOWER_IS_BETTER_MAP[d.id] ?? false;
                      const best = lowerBetter ? Math.min(...definedVals) : Math.max(...definedVals);

                      return (
                        <tr key={d.id} className="hover:bg-zinc-50">
                          <td className="px-6 py-3">
                            <div className="text-xs font-black text-zinc-700">{d.label}</div>
                            <div className="text-[10px] text-zinc-400">{d.unit}</div>
                          </td>
                          {compareAthletes.map(a => {
                            const v   = a.bestResults[d.id]?.value_num;
                            const pct = v !== undefined ? a.percentiles[d.id] : null;
                            const attempts = a.results.filter(r => r.drill_type === d.id);
                            return (
                              <td key={a.id} className="px-4 py-3 text-center">
                                <DeltaCell
                                  value={v}
                                  best={best}
                                  unit={d.unit === 'sec' ? 's' : '"'}
                                  lowerIsBetter={lowerBetter}
                                />
                                {pct !== null && pct !== undefined && (
                                  <div className={`font-mono text-[9px] font-black mt-0.5 tabular-nums ${gradeColor(gradeFromPercentile(pct))} px-1 py-0.5 rounded-full inline-block`}>
                                    {pct}th
                                  </div>
                                )}
                                {attempts.length > 1 && (
                                  <ConsistencyLabel attempts={attempts} />
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                    {/* Summary row */}
                    <tr className="bg-zinc-900">
                      <td className="px-6 py-3 text-xs font-black uppercase tracking-widest text-zinc-400">
                        Avg Pct
                      </td>
                      {compareAthletes.map(a => (
                        <td key={a.id} className="px-4 py-3 text-center">
                          {a.avgPct !== null ? (
                            <span className="font-mono text-lg font-black text-white tabular-nums">
                              {a.avgPct}<span className="text-xs font-normal text-zinc-400">th</span>
                            </span>
                          ) : (
                            <span className="text-zinc-600 text-xs">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Radar chart */}
              <div className="px-8 pb-8 pt-4 border-t border-zinc-100">
                <p className="text-xs font-black uppercase tracking-widest text-zinc-400 mb-4">
                  Percentile Radar — BES Drills
                </p>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={buildRadarData(compareAthletes)}>
                      <PolarGrid stroke="#e4e4e7" />
                      <PolarAngleAxis
                        dataKey="drill"
                        tick={{ fontSize: 11, fontWeight: 700, fill: '#71717a' }}
                      />
                      <Tooltip
                        formatter={(value: number) => [`${value}th percentile`]}
                        contentStyle={{ borderRadius: '12px', border: '1px solid #e4e4e7', fontSize: 12 }}
                      />
                      {compareAthletes.map((athlete, i) => (
                        <Radar
                          key={athlete.id}
                          name={`${athlete.first_name} ${athlete.last_name}`}
                          dataKey={`athlete${i}`}
                          stroke={RADAR_COLORS[i]}
                          fill={RADAR_COLORS[i]}
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      ))}
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>
    </div>
  );
}
