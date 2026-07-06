import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { generateArmsCSV, downloadCSV, buildExportFilename, ExportableAthlete } from '../lib/b2b-exports';
import { supabase } from '../lib/supabase';
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
  Shield,
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

function scoreColor(score: number): string {
  if (score >= 80) return 'text-[#c8a200]';
  if (score >= 60) return 'text-emerald-400';
  if (score >= 40) return 'text-zinc-300';
  return 'text-zinc-500';
}

function progressBarColor(count: number): string {
  if (count >= 5) return 'bg-[#c8a200]';
  if (count >= 3) return 'bg-emerald-500';
  if (count >= 1) return 'bg-amber-500';
  return 'bg-zinc-700';
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

  const [positionFilter, setPositionFilter] = useState('all');
  const [statusFilter, setStatusFilter]     = useState('all');
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'score', direction: 'desc' });

  const PAGE_SIZE = 20;

  function handleSort(key: SortKey) {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key ? (prev.direction === 'desc' ? 'asc' : 'desc') : 'desc',
    }));
    setPage(0);
  }

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

  const filteredAndSortedAthletes = useMemo(() => {
    const lower = searchTerm.toLowerCase();

    const filtered = athletes.filter(a => {
      const nameMatch = `${a.first_name} ${a.last_name}`.toLowerCase().includes(lower);
      const bandMatch = a.bands?.display_number?.toString().includes(searchTerm);
      if (!nameMatch && !bandMatch) return false;

      if (positionFilter !== 'all' && a.position !== positionFilter) return false;

      const s = athleteStatus(a);
      if (statusFilter === 'completed'   && s !== 'completed')   return false;
      if (statusFilter === 'in_progress' && s !== 'in_progress') return false;
      if (statusFilter === 'missing'     && s !== 'missing')     return false;

      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortConfig.key === 'name') {
        const na = `${a.first_name} ${a.last_name}`.toLowerCase();
        const nb = `${b.first_name} ${b.last_name}`.toLowerCase();
        cmp = na.localeCompare(nb);
      } else if (sortConfig.key === 'progress') {
        cmp = (a.results?.length || 0) - (b.results?.length || 0);
      } else {
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

  const hasActiveFilter = positionFilter !== 'all' || statusFilter !== 'all' || !!searchTerm;

  return (
    <div className="min-h-screen bg-zinc-950 text-white">

      {/* ── Sticky Nav — glassmorphism ──────────────────────────────────────── */}
      <nav className="sticky top-0 z-20 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800/60">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 h-16 flex items-center justify-between gap-6">

          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-all"
              title="Back to Home"
            >
              <Home className="w-5 h-5" />
            </Link>
            <div className="h-5 w-px bg-zinc-800" />
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-[#c8a200] rounded-md flex items-center justify-center shrink-0">
                <Shield className="w-4 h-4 text-zinc-900" />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500 leading-none">Core Elite Network</p>
                <p className="text-sm font-black uppercase tracking-tight text-white leading-tight">Admin Dashboard</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <CoachPortalLink />
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex items-center gap-2 px-4 py-2 bg-[#c8a200] hover:bg-[#b89200] text-zinc-900 rounded-lg text-xs font-black uppercase tracking-wider transition-colors disabled:opacity-40"
              >
                <Download className="w-3.5 h-3.5" />
                {exporting ? 'Building...' : 'Export ARMS CSV'}
              </button>
              {exportError && (
                <span className="text-[10px] text-red-400 font-medium max-w-xs text-right">{exportError}</span>
              )}
            </div>
          </div>

        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 lg:px-8 py-8 space-y-8">

        {/* ── Metric Cards ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {loading ? (
            <><SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard /></>
          ) : (
            <>
              <StatCard icon={<Users />}       label="Athletes Registered" value={stats.athletes}  accent="gold"    />
              <StatCard icon={<CreditCard />}  label="Bands Assigned"      value={stats.bands}     accent="violet"  />
              <StatCard icon={<Activity />}    label="Results Captured"    value={stats.results}   accent="emerald" />
              <StatCard icon={<CheckCircle />} label="Drills Complete"     value={stats.completed} accent="amber"   />
            </>
          )}
        </div>

        {/* ── Station Health Ribbon ────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Live Station Health</p>
            <div className="flex-1 h-px bg-zinc-800" />
            <p className="text-[10px] font-mono text-zinc-400">{stations.length} stations</p>
          </div>

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

                const isStale     = seenMinsAgo !== null && seenMinsAgo > 2;
                const isSyncStale = syncMinsAgo !== null && syncMinsAgo > 10;
                const isOffline   = !status || !status.is_online || isStale;
                const isCritical  = (status?.pending_queue_count ?? 0) > 50;
                const isWarning   = !isOffline && (isSyncStale || (status?.pending_queue_count ?? 0) > 10);

                // Pill shell — dark base, colored border only
                const pillClass = !status
                  ? 'border-zinc-700 text-zinc-500'
                  : isCritical || isOffline
                    ? 'border-red-800/60 text-red-400'
                    : isWarning
                      ? 'border-amber-800/60 text-amber-400'
                      : 'border-emerald-800/60 text-emerald-400';

                // Dot + glow
                const dotClass = !status
                  ? 'bg-zinc-600'
                  : isCritical || isOffline
                    ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.7)]'
                    : isWarning
                      ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.7)]'
                      : 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]';

                const statusLabel = !status
                  ? 'No heartbeat'
                  : isOffline
                    ? `Offline${seenMinsAgo !== null ? ` · ${seenMinsAgo}m ago` : ''}`
                    : isCritical
                      ? `Critical · ${status.pending_queue_count} pending`
                      : isSyncStale
                        ? `Sync stale · ${syncMinsAgo}m ago`
                        : 'Online';

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
                    className={`flex items-center gap-2 px-3 py-1.5 bg-zinc-900 rounded-full border text-[11px] font-bold cursor-default select-none transition-all ${pillClass}`}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
                    <span className="font-sans">{station.name}</span>
                    {!status ? (
                      <span className="opacity-50 font-mono text-[9px]">–</span>
                    ) : isOffline ? (
                      <WifiOff className="w-3 h-3 opacity-60 shrink-0" />
                    ) : (status?.pending_queue_count ?? 0) > 0 ? (
                      <span className="font-mono text-[9px] opacity-70">{status.pending_queue_count}</span>
                    ) : (
                      <Wifi className="w-3 h-3 opacity-40 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Athlete Ledger ───────────────────────────────────────────────── */}
        <section className="space-y-4">

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-zinc-500">Athlete Ledger</p>
              <div className="h-4 w-px bg-zinc-800" />
              {!loading && (
                <p className="font-mono text-[10px] text-zinc-400">
                  {filteredAndSortedAthletes.length}<span className="text-zinc-700">/{athletes.length}</span>
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Search */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search athletes..."
                  value={searchTerm}
                  onChange={e => { setSearchTerm(e.target.value); setPage(0); }}
                  className="pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-xs text-white placeholder-zinc-600 outline-none focus:border-[#c8a200]/60 focus:ring-1 focus:ring-[#c8a200]/20 transition-all w-48 font-sans"
                />
              </div>

              {/* Position filter */}
              <select
                value={positionFilter}
                onChange={e => { setPositionFilter(e.target.value); setPage(0); }}
                className="py-2 pl-3 pr-7 bg-zinc-900 border border-zinc-700 rounded-lg text-xs font-bold text-zinc-300 outline-none focus:border-[#c8a200]/60 appearance-none cursor-pointer"
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
                className="py-2 pl-3 pr-7 bg-zinc-900 border border-zinc-700 rounded-lg text-xs font-bold text-zinc-300 outline-none focus:border-[#c8a200]/60 appearance-none cursor-pointer"
              >
                <option value="all">All Statuses</option>
                <option value="completed">Completed</option>
                <option value="in_progress">In Progress</option>
                <option value="missing">Missing Data</option>
              </select>

              {/* Clear filters */}
              {hasActiveFilter && (
                <button
                  onClick={() => { setPositionFilter('all'); setStatusFilter('all'); setSearchTerm(''); setPage(0); }}
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-all"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Table */}
          {loading ? (
            <SkeletonTable />
          ) : (
            <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden shadow-xl">
              <table className="w-full text-left border-collapse">

                {/* ── Header ─────────────────────────────────────────────── */}
                <thead>
                  <tr className="bg-zinc-950 border-b border-zinc-800">
                    <th className="px-5 py-3.5 text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      #
                    </th>
                    <th className="px-5 py-3.5">
                      <SortHeader
                        label="Athlete"
                        sortKey="name"
                        active={sortConfig.key === 'name'}
                        indicator={sortIndicator('name')}
                        onClick={() => handleSort('name')}
                      />
                    </th>
                    <th className="px-5 py-3.5 text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      Pos
                    </th>
                    <th className="px-5 py-3.5">
                      <SortHeader
                        label="Progress"
                        sortKey="progress"
                        active={sortConfig.key === 'progress'}
                        indicator={sortIndicator('progress')}
                        onClick={() => handleSort('progress')}
                      />
                    </th>
                    <th className="px-5 py-3.5">
                      <SortHeader
                        label="Score"
                        sortKey="score"
                        active={sortConfig.key === 'score'}
                        indicator={sortIndicator('score')}
                        onClick={() => handleSort('score')}
                      />
                    </th>
                    <th className="px-5 py-3.5 text-[10px] font-black uppercase tracking-widest text-zinc-400">
                      Status
                    </th>
                  </tr>
                </thead>

                {/* ── Rows ───────────────────────────────────────────────── */}
                <tbody className="divide-y divide-zinc-800/60">
                  {paginatedAthletes.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-16 text-center">
                        <p className="text-sm text-zinc-400 font-medium">No athletes match the current filters.</p>
                      </td>
                    </tr>
                  ) : (
                    paginatedAthletes.map((athlete, idx) => {
                      const score  = avgPercentile(athlete);
                      const status = athleteStatus(athlete);
                      const count  = athlete.results?.length || 0;
                      return (
                        <tr
                          key={athlete.id}
                          className="hover:bg-[#c8a200]/[0.04] transition-colors group"
                        >
                          {/* Band # */}
                          <td className="px-5 py-4">
                            <span className="font-mono font-black text-base text-zinc-500 group-hover:text-zinc-400 tabular-nums">
                              {athlete.bands?.display_number || '--'}
                            </span>
                          </td>

                          {/* Athlete name + email */}
                          <td className="px-5 py-4">
                            <div className="font-bold text-sm text-white">{athlete.first_name} {athlete.last_name}</div>
                            <div className="font-mono text-[10px] text-zinc-400 mt-0.5">{athlete.parent_email}</div>
                          </td>

                          {/* Position */}
                          <td className="px-5 py-4">
                            <span className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] font-black uppercase tracking-wider text-zinc-400">
                              {athlete.position || '—'}
                            </span>
                          </td>

                          {/* Progress bar + x/5 */}
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${progressBarColor(count)}`}
                                  style={{ width: `${Math.min(count / 5 * 100, 100)}%` }}
                                />
                              </div>
                              <span className="font-mono text-[11px] font-bold tabular-nums text-zinc-500">
                                {count}<span className="text-zinc-700">/5</span>
                              </span>
                            </div>
                          </td>

                          {/* Score */}
                          <td className="px-5 py-4">
                            {score !== null ? (
                              <span className={`font-mono font-black text-lg tabular-nums ${scoreColor(score)}`}>
                                {score}<span className="text-[11px] font-normal text-zinc-400">th</span>
                              </span>
                            ) : (
                              <span className="font-mono text-zinc-700 text-sm">—</span>
                            )}
                          </td>

                          {/* Status */}
                          <td className="px-5 py-4">
                            {status === 'completed' ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-950/60 border border-emerald-800/50 rounded-full text-[10px] font-black uppercase tracking-wider text-emerald-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]" />
                                Ready
                              </span>
                            ) : status === 'in_progress' ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-950/60 border border-amber-800/50 rounded-full text-[10px] font-black uppercase tracking-wider text-amber-400">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.8)]" />
                                Testing
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-zinc-800/60 border border-zinc-700/50 rounded-full text-[10px] font-black uppercase tracking-wider text-zinc-500">
                                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                                Waiting
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
            <div className="flex items-center justify-between px-1">
              <p className="font-mono text-[10px] text-zinc-400">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredAndSortedAthletes.length)}
                <span className="text-zinc-700"> of {filteredAndSortedAthletes.length}</span>
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg disabled:opacity-20 hover:bg-zinc-800 hover:border-zinc-700 transition-all text-zinc-400"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-mono text-[11px] font-bold text-zinc-500 tabular-nums">
                  {page + 1}<span className="text-zinc-700">/{totalPages}</span>
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page === totalPages - 1}
                  className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg disabled:opacity-20 hover:bg-zinc-800 hover:border-zinc-700 transition-all text-zinc-400"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortHeader — sortable column header button
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  sortKey,
  active,
  indicator,
  onClick,
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  indicator: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active ? 'text-[#c8a200]' : 'text-zinc-400 hover:text-zinc-300'
      }`}
    >
      {label}
      <span className={`font-mono text-[9px] ${active ? 'text-[#c8a200]' : 'text-zinc-700'}`}>
        {indicator}
      </span>
    </button>
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
      className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 hover:border-zinc-600 rounded-lg text-xs font-bold text-zinc-300 hover:text-white transition-all"
    >
      <Trophy className="w-3.5 h-3.5 text-[#c8a200]" />
      Coach Portal
    </Link>
  );
}

// ---------------------------------------------------------------------------
// StatCard — premium dark metric card
// ---------------------------------------------------------------------------

type AccentKey = 'gold' | 'violet' | 'emerald' | 'amber';

const ACCENT_TOP: Record<AccentKey, string> = {
  gold:    'bg-[#c8a200]',
  violet:  'bg-violet-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
};

const ACCENT_ICON: Record<AccentKey, string> = {
  gold:    'text-[#c8a200]',
  violet:  'text-violet-400',
  emerald: 'text-emerald-400',
  amber:   'text-amber-400',
};

function StatCard({ icon, label, value, accent }: {
  icon:   React.ReactNode;
  label:  string;
  value:  number;
  accent: AccentKey;
}) {
  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden shadow-md">
      <div className={`h-0.5 ${ACCENT_TOP[accent]}`} />
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[9px] font-black uppercase tracking-widest text-zinc-400">{label}</p>
          <span className={`${ACCENT_ICON[accent]} opacity-70`}>
            {React.cloneElement(icon as any, { className: 'w-4 h-4' })}
          </span>
        </div>
        <p className="font-mono font-black text-4xl text-white tabular-nums leading-none">
          {value.toLocaleString()}
        </p>
      </div>
    </div>
  );
}
