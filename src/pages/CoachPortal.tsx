import React, { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { DRILL_CATALOG } from '../constants';
import { calculatePercentile, gradeFromPercentile, gradeColor } from '../lib/analytics';

interface AthleteRow {
  id: string;
  first_name: string;
  last_name: string;
  position: string;
  results: { drill_type: string; value_num: number }[];
  avgPct: number | null;
  percentiles: Record<string, number | null>;
}

const RADAR_DRILLS = ['forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad'];

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

const RADAR_COLORS = ['#c8a200', '#059669', '#3b82f6', '#f59e0b', '#8b5cf6'];

export default function CoachPortal() {
  const { eventId } = useParams<{ eventId: string }>();
  const [athletes, setAthletes] = useState<AthleteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventName, setEventName] = useState('');
  const [positionFilter, setPositionFilter] = useState<string>('all');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [compareMode, setCompareMode] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);

    const [{ data: eventData }, { data: athleteData }] = await Promise.all([
      supabase.from('events').select('name').eq('id', eventId).single(),
      supabase
        .from('athletes')
        .select('id, first_name, last_name, position, results(drill_type, value_num)')
        .eq('event_id', eventId)
        .order('created_at', { ascending: false }),
    ]);

    if (eventData) setEventName(eventData.name);

    const rows: AthleteRow[] = (athleteData || []).map((a: any) => {
      const percentiles: Record<string, number | null> = {};
      for (const r of (a.results || [])) {
        percentiles[r.drill_type] = calculatePercentile(r.value_num, r.drill_type);
      }
      const validPcts = Object.values(percentiles).filter((p): p is number => p !== null);
      const avgPct = validPcts.length > 0
        ? Math.round(validPcts.reduce((a, b) => a + b, 0) / validPcts.length)
        : null;
      return { ...a, percentiles, avgPct };
    });

    setAthletes(rows);
    setLoading(false);
  }, [eventId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const positions = Array.from(new Set(athletes.map(a => a.position).filter(Boolean))).sort();

  const filtered = athletes
    .filter(a => positionFilter === 'all' || a.position === positionFilter)
    .sort((a, b) => {
      const pa = a.avgPct ?? -1;
      const pb = b.avgPct ?? -1;
      return sortDir === 'desc' ? pb - pa : pa - pb;
    });

  const compareAthletes = athletes.filter(a => selected.has(a.id));

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 4) {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* Nav */}
      <nav className="bg-white border-b border-zinc-200 px-8 py-4 sticky top-0 z-20 print:hidden">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/admin/dashboard"
              className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500 hover:text-zinc-900"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="h-8 w-px bg-zinc-200" />
            <div className="bg-zinc-900 text-white p-2 rounded-lg">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-black uppercase italic tracking-tighter">Coach Portal</h1>
              {eventName && <p className="text-xs text-zinc-400 font-medium">{eventName}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setCompareMode(m => !m); if (compareMode) setSelected(new Set()); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
                compareMode ? 'bg-zinc-900 text-white' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
              }`}
            >
              <Users className="w-4 h-4" />
              {compareMode ? `Compare (${selected.size}/4)` : 'Compare Mode'}
            </button>
            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors"
            >
              <Printer className="w-4 h-4" />
              Print
            </button>
            <button onClick={fetchData} className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">
        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap print:hidden">
          <Filter className="w-4 h-4 text-zinc-400" />
          <select
            value={positionFilter}
            onChange={e => setPositionFilter(e.target.value)}
            className="px-3 py-2 bg-white border border-zinc-200 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-zinc-900"
          >
            <option value="all">All Positions</option>
            {positions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          {compareMode && selected.size >= 2 && (
            <span className="text-xs font-bold text-zinc-500">
              Select up to 4 athletes · Radar chart below
            </span>
          )}
        </div>

        {/* Leaderboard */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-14 bg-zinc-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-100">
                  {compareMode && <th className="px-4 py-4 w-12" />}
                  <th className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Rank</th>
                  <th className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Athlete</th>
                  <th className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-left">Pos</th>
                  {DRILL_CATALOG.filter(d => d.type === 'numeric').map(d => (
                    <th key={d.id} className="px-4 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-center">
                      {d.label.split(' ')[0]}
                    </th>
                  ))}
                  <th
                    className="px-6 py-4 text-xs font-black uppercase tracking-widest text-zinc-400 text-center cursor-pointer select-none hover:text-zinc-900 transition-colors"
                    onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                  >
                    Avg {sortDir === 'desc' ? <ChevronDown className="w-3 h-3 inline" /> : <ChevronUp className="w-3 h-3 inline" />}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={20} className="px-6 py-16 text-center text-zinc-400">
                      <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      No athletes found.
                    </td>
                  </tr>
                ) : (
                  filtered.map((athlete, idx) => {
                    const isSelected = selected.has(athlete.id);
                    return (
                      <tr
                        key={athlete.id}
                        className={`transition-colors ${
                          compareMode ? 'cursor-pointer' : ''
                        } ${isSelected ? 'bg-amber-50' : 'hover:bg-zinc-50'}`}
                        onClick={compareMode ? () => toggleSelect(athlete.id) : undefined}
                      >
                        {compareMode && (
                          <td className="px-4 py-3 text-center">
                            {isSelected
                              ? <CheckSquare className="w-4 h-4 text-amber-600 mx-auto" />
                              : <Square className="w-4 h-4 text-zinc-300 mx-auto" />
                            }
                          </td>
                        )}
                        <td className="px-6 py-3 font-black text-zinc-300 text-sm">
                          {idx + 1}
                        </td>
                        <td className="px-6 py-3">
                          <div className="font-bold text-zinc-900">{athlete.first_name} {athlete.last_name}</div>
                        </td>
                        <td className="px-6 py-3">
                          <span className="px-2 py-0.5 bg-zinc-100 rounded text-[10px] font-black uppercase">{athlete.position || '—'}</span>
                        </td>
                        {DRILL_CATALOG.filter(d => d.type === 'numeric').map(d => {
                          const res = athlete.results.find(r => r.drill_type === d.id);
                          const pct = res ? athlete.percentiles[d.id] : null;
                          const grade = pct !== null && pct !== undefined ? gradeFromPercentile(pct) : null;
                          return (
                            <td key={d.id} className="px-4 py-3 text-center">
                              {res ? (
                                <div className="flex flex-col items-center gap-0.5">
                                  <span className="font-bold text-zinc-900 text-xs">{res.value_num}</span>
                                  {pct !== null && grade && (
                                    <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-black ${gradeColor(grade)}`}>
                                      {pct}th
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-zinc-200 text-xs">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-6 py-3 text-center">
                          {athlete.avgPct !== null ? (
                            <span className="text-base font-black text-zinc-900">
                              {athlete.avgPct}<span className="text-xs font-normal text-zinc-400">th</span>
                            </span>
                          ) : (
                            <span className="text-zinc-200 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Radar Chart Compare */}
        <AnimatePresence>
          {compareMode && compareAthletes.length >= 2 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="bg-white rounded-3xl border border-zinc-200 shadow-sm p-8"
            >
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-black uppercase italic tracking-tighter">Athlete Comparison</h2>
                <div className="flex items-center gap-4 flex-wrap">
                  {compareAthletes.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-2 text-sm font-bold">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: RADAR_COLORS[i] }} />
                      {a.first_name} {a.last_name}
                    </div>
                  ))}
                </div>
              </div>
              <div className="h-80">
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
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
