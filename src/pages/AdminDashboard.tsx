import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
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
  AlertTriangle,
  Clock,
  Home,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { DRILL_CATALOG } from '../constants';

const PAGE_SIZE = 25;
const COMPLETION_THRESHOLD = DRILL_CATALOG.length || 5;

interface DashboardStats {
  athletes: number;
  bands: number;
  results: number;
  completed: number;
}

interface AthleteRow {
  id: string;
  first_name: string;
  last_name: string;
  position: string | null;
  bands: { display_number: number | null } | null;
  results: { drill_type: string; value_num: number | null }[];
}

interface StationRow {
  id: string;
  name: string;
  drill_type: string;
  status: { is_online: boolean; last_seen_at: string; pending_queue_count: number } | null;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats>({ athletes: 0, bands: 0, results: 0, completed: 0 });
  const [stations, setStations] = useState<StationRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteRow[]>([]);
  const [totalAthletes, setTotalAthletes] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [statsLoading, setStatsLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState(true);
  const [exportLoading, setExportLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;

  const fetchSummary = useCallback(async () => {
    try {
      const [
        { count: athleteCount },
        { count: bandCount },
        { count: resultCount },
        { data: resultAthleteIds },
        { data: stationList },
        { data: statusData },
      ] = await Promise.all([
        supabase.from('athletes').select('*', { count: 'exact', head: true }),
        supabase.from('bands').select('*', { count: 'exact', head: true }).eq('status', 'assigned'),
        supabase.from('results').select('*', { count: 'exact', head: true }),
        supabase.from('results').select('athlete_id').limit(10000),
        supabase.from('stations').select('id, name, drill_type'),
        supabase.from('device_status').select('station_id, is_online, last_seen_at, pending_queue_count'),
      ]);

      const countByAthlete: Record<string, number> = {};
      for (const row of resultAthleteIds ?? []) {
        countByAthlete[row.athlete_id] = (countByAthlete[row.athlete_id] ?? 0) + 1;
      }
      const completed = Object.values(countByAthlete).filter((n) => n >= COMPLETION_THRESHOLD).length;

      const mergedStations: StationRow[] = (stationList ?? []).map((s) => {
        const ds = (statusData ?? []).find((st) => st.station_id === s.id);
        return {
          id: s.id,
          name: s.name,
          drill_type: s.drill_type,
          status: ds ? { is_online: ds.is_online, last_seen_at: ds.last_seen_at, pending_queue_count: ds.pending_queue_count } : null,
        };
      });

      setStats({ athletes: athleteCount ?? 0, bands: bandCount ?? 0, results: resultCount ?? 0, completed });
      setStations(mergedStations);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchAthletePage = useCallback(async (page: number, search: string) => {
    setTableLoading(true);
    try {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let query = supabase
        .from('athletes')
        .select('id, first_name, last_name, position, bands(display_number), results(drill_type, value_num)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (search.trim()) {
        const isNumeric = /^\d+$/.test(search.trim());
        if (isNumeric) {
          query = query.eq('bands.display_number', parseInt(search.trim(), 10));
        } else {
          query = query.or(`first_name.ilike.%${search.trim()}%,last_name.ilike.%${search.trim()}%`);
        }
      }

      const { data, count, error } = await query;
      if (error) {
        if (import.meta.env.DEV) console.error('[AdminDashboard] fetchAthletePage error:', error);
        return;
      }
      setAthletes((data as AthleteRow[]) ?? []);
      setTotalAthletes(count ?? 0);
    } finally {
      setTableLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    fetchAthletePage(0, '');
    const interval = setInterval(fetchSummary, 30_000);
    return () => clearInterval(interval);
  }, [fetchSummary, fetchAthletePage]);

  useEffect(() => {
    fetchAthletePage(currentPage, searchTerm);
  }, [currentPage, searchTerm, fetchAthletePage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(0);
      setSearchTerm(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const exportCSV = async () => {
    setExportLoading(true);
    try {
      const drillIds = DRILL_CATALOG.map((d) => d.id);
      const headers = ['ID', 'Number', 'Name', 'Position', ...drillIds.map((id) => DRILL_CATALOG.find((d) => d.id === id)?.label ?? id)];
      const { data: allAthletes, error } = await supabase
        .from('athletes')
        .select('id, first_name, last_name, position, bands(display_number), results(drill_type, value_num)')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) {
        if (import.meta.env.DEV) console.error('[AdminDashboard] exportCSV error:', error);
        return;
      }
      const rows = (allAthletes as AthleteRow[]).map((a) => {
        const drillResults = drillIds.map((id) => {
          const res = a.results?.find((r) => r.drill_type === id);
          return res?.value_num != null ? res.value_num : '';
        });
        return [a.id, a.bands?.display_number ?? 'N/A', `${a.first_name} ${a.last_name}`, a.position ?? 'N/A', ...drillResults];
      });
      const csvContent = [headers, ...rows].map((e) => e.join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `combine_results_${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setExportLoading(false);
    }
  };

  const totalPages = Math.ceil(totalAthletes / PAGE_SIZE);
  const canGoPrev = currentPage > 0;
  const canGoNext = currentPage < totalPages - 1;

  return (
    <div className="min-h-screen bg-zinc-50">
      <nav className="bg-white border-b border-zinc-200 px-8 py-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500 hover:text-zinc-900" title="Back to Home">
              <Home className="w-6 h-6" />
            </Link>
            <div className="h-8 w-px bg-zinc-200 mx-2" />
            <div className="bg-zinc-900 text-white p-2 rounded-lg">
              <Activity className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-black uppercase italic tracking-tighter">Admin Dashboard</h1>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => { fetchSummary(); fetchAthletePage(currentPage, searchTerm); }}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
            <button
              onClick={exportCSV}
              disabled={exportLoading}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              {exportLoading ? 'Exporting...' : 'Export CSV'}
            </button>
            <div className="w-10 h-10 bg-zinc-200 rounded-full border-2 border-white shadow-sm" />
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <StatCard icon={<Users />} label="Athletes Registered" value={stats.athletes} color="blue" loading={statsLoading} />
          <StatCard icon={<CreditCard />} label="Bands Assigned" value={stats.bands} color="purple" loading={statsLoading} />
          <StatCard icon={<Activity />} label="Results Captured" value={stats.results} color="emerald" loading={statsLoading} />
          <StatCard icon={<CheckCircle />} label="Completed Drills" value={stats.completed} color="amber" loading={statsLoading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold">Athlete Progress</h2>
                {!tableLoading && <span className="text-sm text-zinc-500">{totalAthletes} total</span>}
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search athletes..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
                />
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-100">
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">#</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Athlete</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Position</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Progress</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {tableLoading ? (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-zinc-400 text-sm">Loading...</td></tr>
                  ) : athletes.length === 0 ? (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-zinc-400 text-sm">{searchTerm ? 'No athletes match your search.' : 'No athletes registered yet.'}</td></tr>
                  ) : (
                    athletes.map((athlete) => {
                      const resultCount = athlete.results?.length ?? 0;
                      const progress = Math.min(Math.round((resultCount / COMPLETION_THRESHOLD) * 100), 100);
                      const isComplete = resultCount >= COMPLETION_THRESHOLD;
                      return (
                        <motion.tr key={athlete.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="hover:bg-zinc-50 transition-colors">
                          <td className="px-6 py-4 text-sm font-bold text-zinc-900">{athlete.bands?.display_number ?? '—'}</td>
                          <td className="px-6 py-4">
                            <div className="font-semibold text-zinc-900 text-sm">{athlete.first_name} {athlete.last_name}</div>
                          </td>
                          <td className="px-6 py-4 text-sm text-zinc-500">{athlete.position ?? '—'}</td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 bg-zinc-100 rounded-full h-2 min-w-[60px]">
                                <div className={`h-2 rounded-full transition-all ${isComplete ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${progress}%` }} />
                              </div>
                              <span className="text-xs text-zinc-500 whitespace-nowrap">{resultCount}/{COMPLETION_THRESHOLD}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            {isComplete ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-700 text-xs font-bold rounded-full">
                                <CheckCircle className="w-3 h-3" /> Done
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 text-xs font-bold rounded-full">
                                <Clock className="w-3 h-3" /> In Progress
                              </span>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })
                  )}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="px-6 py-4 border-t border-zinc-100 flex items-center justify-between">
                  <span className="text-sm text-zinc-500">Page {currentPage + 1} of {totalPages} &nbsp;·&nbsp; {totalAthletes} athletes</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setCurrentPage((p) => p - 1)} disabled={!canGoPrev || tableLoading} className="p-2 rounded-lg hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" aria-label="Previous page">
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button onClick={() => setCurrentPage((p) => p + 1)} disabled={!canGoNext || tableLoading} className="p-2 rounded-lg hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" aria-label="Next page">
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-xl font-bold">Station Health</h2>
            <div className="space-y-3">
              {statsLoading ? (
                <div className="bg-white rounded-2xl border border-zinc-200 p-4 text-sm text-zinc-400">Loading stations...</div>
              ) : stations.length === 0 ? (
                <div className="bg-white rounded-2xl border border-zinc-200 p-4 text-sm text-zinc-400">No stations configured.</div>
              ) : (
                stations.map((station) => {
                  const isOnline = station.status?.is_online ?? false;
                  const lastSeen = station.status?.last_seen_at ? new Date(station.status.last_seen_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
                  const pendingCount = station.status?.pending_queue_count ?? 0;
                  return (
                    <div key={station.id} className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-bold text-sm text-zinc-900">{station.name}</div>
                          <div className="text-xs text-zinc-400">{station.drill_type}</div>
                        </div>
                        <div className={`flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full ${isOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                          {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                          {isOnline ? 'Online' : 'Offline'}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-zinc-400">
                        {lastSeen && <span>Last seen {lastSeen}</span>}
                        {pendingCount > 0 && (
                          <span className="flex items-center gap-1 text-amber-600 font-semibold">
                            <AlertTriangle className="w-3 h-3" /> {pendingCount} pending
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: 'blue' | 'purple' | 'emerald' | 'amber';
  loading?: boolean;
}

const COLOR_MAP: Record<StatCardProps['color'], string> = {
  blue: 'bg-blue-50 text-blue-600',
  purple: 'bg-purple-50 text-purple-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
};

function StatCard({ icon, label, value, color, loading }: StatCardProps) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="bg-white rounded-3xl border border-zinc-200 shadow-sm p-6 space-y-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${COLOR_MAP[color]}`}>
        {React.cloneElement(icon as React.ReactElement, { className: 'w-5 h-5' })}
      </div>
      <div>
        {loading ? (
          <div className="h-8 w-16 bg-zinc-100 rounded animate-pulse" />
        ) : (
          <div className="text-3xl font-black text-zinc-900">{value.toLocaleString()}</div>
        )}
        <div className="text-sm text-zinc-500 font-medium mt-1">{label}</div>
      </div>
    </motion.div>
  );
               }
