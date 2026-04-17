import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { generateArmsCSV, downloadCSV, buildExportFilename, ExportableAthlete } from '../lib/b2b-exports';
import { supabase } from '../lib/supabase';
import { motion } from 'motion/react';
import {
  Users,
  CreditCard,
  Activity,
  CheckCircle,
  Wifi,
  WifiOff,
  Search,
  Download,
  Home,
  ChevronLeft,
  ChevronRight,
  Trophy,
} from 'lucide-react';
import { DRILL_CATALOG } from '../constants';
import { SkeletonCard, SkeletonTable } from '../components/Skeleton';
import { calculatePercentile } from '../lib/analytics';

// ---------------------------------------------------------------------------
// Module-level helpers — pure functions, no component state deps
// ---------------------------------------------------------------------------

function avgPercentile(athlete: any): number | null {
  const results: any[] = athlete.results || [];
  const percentiles = results
    .map((r: any) => calculatePercentile(r.value_num, r.drill_type))
    .filter((p): p is number => p !== null);
  if (percentiles.length === 0) return null;
  return Math.round(percentiles.reduce((a, b) => a + b, 0) / percentiles.length);
}

function athleteStatus(athlete: any): 'completed' | 'in_progress' | 'missing' {
  const count = athlete.results?.length || 0;
  if (count >= 5) return 'completed';
  if (count > 0)  return 'in_progress';
  return 'missing';
}

// ---------------------------------------------------------------------------
// Sort key type
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'progress' | 'score';

interface SortConfig {
  key:       SortKey;
  direction: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// AdminDashboard
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    athletes: 0,
    bands: 0,
    results: 0,
    completed: 0
  });
  const [stations, setStations]     = useState<any[]>([]);
  const [athletes, setAthletes]     = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [exporting, setExporting]   = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [page, setPage]             = useState(0);

  // Compound filter state
  const [positionFilter, setPositionFilter] = useState('all');
  const [statusFilter, setStatusFilter]     = useState('all');

  // Multi-column sort state (replaces scoreSortDir)
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'score', direction: 'desc' });

  const PAGE_SIZE = 20;

  // Toggle sort: same column → flip direction; different column → default desc
  function handleSort(key: SortKey) {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key ? (prev.direction === 'desc' ? 'asc' : 'desc') : 'desc',
    }));
    setPage(0);
  }

  // Sort indicator character
  function sortIndicator(key: SortKey): string {
    if (sortConfig.key !== key) return '↕';
    return sortConfig.direction === 'desc' ? '↓' : '↑';
  }

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { data: event } = await supabase
        .from('events')
        .select('id, name')
        .eq('status', 'live')
        .maybeSingle();
      if (!event) throw new Error('No live event found. Set an event to "live" status first.');

      const { data: athleteRows, error: athErr } = await supabase
        .from('athletes')
        .select('id, first_name, last_name, position, high_school, grad_year, height_in, weight_lb')
        .eq('event_id', event.id);
      if (athErr) throw athErr;

      const { data: resultRows, error: resErr } = await supabase
        .from('results')
        .select('athlete_id, drill_type, value_num')
        .eq('event_id', event.id)
        .eq('voided', false);
      if (resErr) throw resErr;

      const bestMap: Record<string, Record<string, { value_num: number }>> = {};
      for (const r of (resultRows ?? [])) {
        if (!bestMap[r.athlete_id]) bestMap[r.athlete_id] = {};
        const prev = bestMap[r.athlete_id][r.drill_type];
        if (!prev || r.value_num < prev.value_num) {
          bestMap[r.athlete_id][r.drill_type] = { value_num: r.value_num };
        }
      }

      const exportable: ExportableAthlete[] = (athleteRows ?? []).map((a: any) => ({
        id:          a.id,
        first_name:  a.first_name,
        last_name:   a.last_name,
        position:    a.position ?? '',
        high_school: a.high_school,
        grad_year:   a.grad_year,
        height_in:   a.height_in,
        weight_lb:   a.weight_lb,
        bestResults: bestMap[a.id] ?? {},
      }));

      const csv = generateArmsCSV(exportable, event.name);
      downloadCSV(csv, buildExportFilename(event.name));
    } catch (err: any) {
      setExportError(err.message ?? 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    async function fetchData() {
      setLoading(true);

      const { count: athleteCount } = await supabase
        .from('athletes').select('*', { count: 'exact', head: true });
      const { count: bandCount } = await supabase
        .from('bands').select('*', { count: 'exact', head: true }).eq('status', 'assigned');
      const { count: resultCount } = await supabase
        .from('results').select('*', { count: 'exact', head: true });

      const { data: stationList } = await supabase.from('stations').select('*');
      const { data: statusData }  = await supabase.from('device_status').select('*');

      const mergedStations = (stationList || []).map(s => {
        const status = (statusData || []).find(st => st.station_id === s.id);
        return { ...s, status: status || null };
      });

      const { data: athleteData } = await supabase
        .from('athletes')
        .select('*, bands(display_number), results(drill_type, value_num)')
        .order('created_at', { ascending: false });

      setStats({
        athletes:  athleteCount || 0,
        bands:     bandCount    || 0,
        results:   resultCount  || 0,
        completed: athleteData?.filter(a => (a.results?.length || 0) >= 5).length || 0,
      });

      setStations(mergedStations);
      setAthletes(athleteData || []);
      setLoading(false);
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // ── Compound filter + sort pipeline ────────────────────────────────────────
  const filteredAndSortedAthletes = useMemo(() => {
    const lower = searchTerm.toLowerCase();

    const filtered = athletes.filter(a => {
      // Text search: name or band number
      const nameMatch = `${a.first_name} ${a.last_name}`.toLowerCase().includes(lower);
      const bandMatch = a.bands?.display_number?.toString().includes(searchTerm);
      if (!nameMatch && !bandMatch) return false;

      // Position filter
      if (positionFilter !== 'all' && a.position !== positionFilter) return false;

      // Status filter
      const s = athleteStatus(a);
      if (statusFilter === 'completed'   && s !== 'completed')   return false;
      if (statusFilter === 'in_progress' && s !== 'in_progress') return false;
      if (statusFilter === 'missing'     && s !== 'missing')     return false;

      return true;
    });

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortConfig.key === 'name') {
        const na = `${a.first_name} ${a.last_name}`.toLowerCase();
        const nb = `${b.first_name} ${b.last_name}`.toLowerCase();
        cmp = na.localeCompare(nb);
      } else if (sortConfig.key === 'progress') {
        cmp = (a.results?.length || 0) - (b.results?.length || 0);
      } else {
        // score
        const pa = avgPercentile(a) ?? -1;
        const pb = avgPercentile(b) ?? -1;
        cmp = pa - pb;
      }
      return sortConfig.direction === 'desc' ? -cmp : cmp;
    });

    return sorted;
  }, [athletes, searchTerm, positionFilter, statusFilter, sortConfig]);

  const paginatedAthletes = filteredAndSortedAthletes.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );
  const totalPages = Math.ceil(filteredAndSortedAthletes.length / PAGE_SIZE);

  return (
    <div className="min-h-screen bg-zinc-50">
      {/* ── Nav ────────────────────────────────────────────────────────────── */}
      <nav className="bg-white border-b border-zinc-200 px-8 py-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500 hover:text-zinc-900"
              title="Back to Home"
            >
              <Home className="w-6 h-6" />
            </Link>
            <div className="h-8 w-px bg-zinc-200 mx-2" />
            <div className="bg-zinc-900 text-white p-2 rounded-lg">
              <Activity className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-black uppercase italic tracking-tighter">Admin Dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            <CoachPortalLink />
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-700 text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                {exporting ? 'Building CSV...' : 'Export ARMS CSV'}
              </button>
              {exportError && (
                <span className="text-xs text-red-600 font-medium max-w-xs text-right">{exportError}</span>
              )}
            </div>
            <div className="w-10 h-10 bg-zinc-200 rounded-full border-2 border-white shadow-sm" />
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">
        {/* ── Stats Grid ───────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {loading ? (
            <><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></>
          ) : (
            <>
              <StatCard icon={<Users />}       label="Athletes Registered" value={stats.athletes}  color="blue"    />
              <StatCard icon={<CreditCard />}  label="Bands Assigned"      value={stats.bands}     color="purple"  />
              <StatCard icon={<Activity />}    label="Results Captured"    value={stats.results}   color="emerald" />
              <StatCard icon={<CheckCircle />} label="Completed Drills"    value={stats.completed} color="amber"   />
            </>
          )}
        </div>

        {/* ── Station Health Ribbon ────────────────────────────────────────── */}
        <div className="space-y-3">
          <h2 className="text-sm font-black uppercase tracking-wider text-zinc-500">Station Health</h2>
          {stations.length === 0 ? (
            <p className="text-xs text-zinc-400 font-medium">No stations configured.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {stations.map(station => {
                const status      = station.status;
                const now         = new Date();
                const lastSeen    = status?.last_seen_at    ? new Date(status.last_seen_at)    : null;
                const lastSync    = status?.last_sync_at    ? new Date(status.last_sync_at)    : null;
                const seenMinsAgo = lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / 60000) : null;
                const syncMinsAgo = lastSync ? Math.floor((now.getTime() - lastSync.getTime()) / 60000) : null;

                const isStale    = seenMinsAgo !== null && seenMinsAgo > 2;
                const isSyncStale = syncMinsAgo !== null && syncMinsAgo > 10;
                const isOffline  = !status || !status.is_online || isStale;
                const isCritical = (status?.pending_queue_count ?? 0) > 50;
                const isWarning  = !isOffline && (isSyncStale || (status?.pending_queue_count ?? 0) > 10);

                const pillStyle = !status
                  ? 'bg-zinc-100 text-zinc-500 border-zinc-200'
                  : isCritical || isOffline
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : isWarning
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200';

                const dotStyle = !status
                  ? 'bg-zinc-400'
                  : isCritical || isOffline
                    ? 'bg-red-500'
                    : isWarning
                      ? 'bg-amber-500'
                      : 'bg-emerald-500';

                const statusLabel = !status
                  ? 'No heartbeat'
                  : isOffline
                    ? `Offline${seenMinsAgo !== null ? ` · ${seenMinsAgo}m ago` : ''}`
                    : isCritical
                      ? `Critical · ${status.pending_queue_count} pending`
                      : isSyncStale
                        ? `Sync stale · ${syncMinsAgo}m ago`
                        : `Online`;

                const tooltipText = [
                  station.name,
                  status?.device_label ? `Device: ${status.device_label}` : 'No device',
                  `Outbox: ${status?.pending_queue_count ?? 0}`,
                  lastSync ? `Last sync: ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Never synced',
                  statusLabel,
                ].join(' · ');

                return (
                  <div
                    key={station.id}
                    title={tooltipText}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold cursor-default select-none ${pillStyle}`}
                  >
                    {/* Traffic-light dot */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotStyle}`} />

                    {/* Station name */}
                    <span>{station.name}</span>

                    {/* Inline alert suffix */}
                    {!status ? (
                      <span className="opacity-60">· waiting</span>
                    ) : isOffline ? (
                      <WifiOff className="w-3 h-3 opacity-70 shrink-0" />
                    ) : (status?.pending_queue_count ?? 0) > 0 ? (
                      <span className="opacity-60">· {status.pending_queue_count}</span>
                    ) : (
                      <Wifi className="w-3 h-3 opacity-50 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Athlete Progress (full width) ────────────────────────────────── */}
        <div className="space-y-4">
          {/* Table toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-bold">Athlete Progress</h2>

            <div className="flex flex-wrap items-center gap-2">
              {/* Text search */}
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search athletes..."
                  value={searchTerm}
                  onChange={e => { setSearchTerm(e.target.value); setPage(0); }}
                  className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-52"
                />
              </div>

              {/* Position filter */}
              <select
                value={positionFilter}
                onChange={e => { setPositionFilter(e.target.value); setPage(0); }}
                className="py-2 pl-3 pr-8 bg-white border border-zinc-200 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-zinc-900 appearance-none cursor-pointer text-zinc-700"
              >
                <option value="all">All Positions</option>
                <option value="QB">QB</option>
                <option value="WR">WR</option>
                <option value="RB">RB</option>
                <option value="TE">TE</option>
                <option value="OL">OL</option>
                <option value="DL">DL</option>
                <option value="LB">LB</option>
                <option value="DB">DB</option>
                <option value="ATH">ATH</option>
                <option value="K">K</option>
                <option value="P">P</option>
                <option value="LS">LS</option>
              </select>

              {/* Status filter */}
              <select
                value={statusFilter}
                onChange={e => { setStatusFilter(e.target.value); setPage(0); }}
                className="py-2 pl-3 pr-8 bg-white border border-zinc-200 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-zinc-900 appearance-none cursor-pointer text-zinc-700"
              >
                <option value="all">All Statuses</option>
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="missing">Missing Data</option>
              </select>

              {/* Active filter count badge */}
              {(positionFilter !== 'all' || statusFilter !== 'all' || searchTerm) && (
                <button
                  onClick={() => { setPositionFilter('all'); setStatusFilter('all'); setSearchTerm(''); setPage(0); }}
                  className="px-3 py-2 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-700 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {/* Result count */}
          {!loading && (
            <p className="text-xs text-zinc-400 font-medium -mt-1">
              {filteredAndSortedAthletes.length} of {athletes.length} athletes
            </p>
          )}

          {loading ? (
            <SkeletonTable />
          ) : (
            <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-100">
                    {/* Band # — not sortable */}
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">#</th>

                    {/* Athlete — sortable */}
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort('name')}
                        className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors hover:text-zinc-900 ${
                          sortConfig.key === 'name' ? 'text-zinc-900' : 'text-zinc-500'
                        }`}
                      >
                        Athlete
                        <span className={sortConfig.key === 'name' ? 'text-zinc-900' : 'text-zinc-300'}>
                          {sortIndicator('name')}
                        </span>
                      </button>
                    </th>

                    {/* Position — not sortable (use dropdown for position filtering) */}
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Position</th>

                    {/* Progress — sortable */}
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort('progress')}
                        className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors hover:text-zinc-900 ${
                          sortConfig.key === 'progress' ? 'text-zinc-900' : 'text-zinc-500'
                        }`}
                      >
                        Progress
                        <span className={sortConfig.key === 'progress' ? 'text-zinc-900' : 'text-zinc-300'}>
                          {sortIndicator('progress')}
                        </span>
                      </button>
                    </th>

                    {/* Score — sortable (default active) */}
                    <th className="px-6 py-4">
                      <button
                        onClick={() => handleSort('score')}
                        className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors hover:text-zinc-900 ${
                          sortConfig.key === 'score' ? 'text-zinc-900' : 'text-zinc-500'
                        }`}
                      >
                        Score
                        <span className={sortConfig.key === 'score' ? 'text-zinc-900' : 'text-zinc-300'}>
                          {sortIndicator('score')}
                        </span>
                      </button>
                    </th>

                    {/* Status — not sortable (use dropdown for status filtering) */}
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {paginatedAthletes.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-sm text-zinc-400">
                        No athletes match the current filters.
                      </td>
                    </tr>
                  ) : (
                    paginatedAthletes.map(athlete => {
                      const score  = avgPercentile(athlete);
                      const status = athleteStatus(athlete);
                      return (
                        <tr key={athlete.id} className="hover:bg-zinc-50 transition-colors">
                          <td className="px-6 py-4 font-black text-zinc-400">
                            {athlete.bands?.display_number || '--'}
                          </td>
                          <td className="px-6 py-4">
                            <div className="font-bold">{athlete.first_name} {athlete.last_name}</div>
                            <div className="text-xs text-zinc-400">{athlete.parent_email}</div>
                          </td>
                          <td className="px-6 py-4">
                            <span className="px-2 py-1 bg-zinc-100 rounded text-xs font-bold">
                              {athlete.position || 'N/A'}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden min-w-[60px]">
                                <div
                                  className="h-full bg-emerald-500 rounded-full"
                                  style={{ width: `${Math.min((athlete.results?.length || 0) / 5 * 100, 100)}%` }}
                                />
                              </div>
                              <span className="text-xs font-bold tabular-nums">
                                {athlete.results?.length || 0}/5
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {score !== null ? (
                              <span className="text-sm font-black text-zinc-900 tabular-nums">
                                {score}<span className="text-xs font-normal text-zinc-400">th</span>
                              </span>
                            ) : (
                              <span className="text-xs text-zinc-300 font-medium">—</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {status === 'completed' ? (
                              <span className="text-emerald-600 flex items-center gap-1 text-xs font-bold">
                                <CheckCircle className="w-3 h-3" /> Ready
                              </span>
                            ) : status === 'in_progress' ? (
                              <span className="text-amber-600 flex items-center gap-1 text-xs font-bold">
                                <Activity className="w-3 h-3" /> Testing
                              </span>
                            ) : (
                              <span className="text-zinc-400 flex items-center gap-1 text-xs font-bold">
                                <span className="w-3 h-3 rounded-full border-2 border-zinc-300 inline-block" /> Waiting
                              </span>
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

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-2">
              <p className="text-xs text-zinc-500 font-medium">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredAndSortedAthletes.length)} of {filteredAndSortedAthletes.length} athletes
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-2 bg-white border border-zinc-200 rounded-lg disabled:opacity-30 hover:bg-zinc-50 transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs font-bold text-zinc-600">
                  {page + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="p-2 bg-white border border-zinc-200 rounded-lg disabled:opacity-30 hover:bg-zinc-50 transition-all"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CoachPortalLink — resolves live event, renders deep-link (unchanged)
// ---------------------------------------------------------------------------

function CoachPortalLink() {
  const [eventId, setEventId] = React.useState<string | null>(null);

  React.useEffect(() => {
    supabase
      .from('events')
      .select('id')
      .eq('status', 'live')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setEventId(data.id);
      });
  }, []);

  if (!eventId) return null;

  return (
    <Link
      to={`/coach/${eventId}`}
      className="flex items-center gap-2 px-4 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl text-sm font-bold text-amber-800 transition-colors"
    >
      <Trophy className="w-4 h-4" />
      Coach Portal
    </Link>
  );
}

// ---------------------------------------------------------------------------
// StatCard (unchanged)
// ---------------------------------------------------------------------------

function StatCard({ icon, label, value, color }: {
  icon:  React.ReactNode;
  label: string;
  value: number;
  color: string;
}) {
  const colors: Record<string, string> = {
    blue:    'bg-blue-50 text-blue-600',
    purple:  'bg-purple-50 text-purple-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber:   'bg-amber-50 text-amber-600',
  };

  return (
    <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colors[color]}`}>
        {React.cloneElement(icon as any, { className: 'w-5 h-5' })}
      </div>
      <div>
        <div className="text-3xl font-black tracking-tight">{value}</div>
        <div className="text-xs font-bold uppercase tracking-wider text-zinc-400">{label}</div>
      </div>
    </div>
  );
}
