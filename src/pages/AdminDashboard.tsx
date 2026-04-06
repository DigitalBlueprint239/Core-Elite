import React, { useState, useEffect } from 'react';
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
  MoreVertical,
  AlertTriangle,
  Clock,
  Home,
  ChevronLeft,
  ChevronRight,
  Trophy,
} from 'lucide-react';
import { DRILL_CATALOG } from '../constants';
import { SkeletonCard, SkeletonTable } from '../components/Skeleton';
import { calculatePercentile } from '../lib/analytics';

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    athletes: 0,
    bands: 0,
    results: 0,
    completed: 0
  });
  const [stations, setStations] = useState<any[]>([]);
  const [athletes, setAthletes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(0);
  const [scoreSortDir, setScoreSortDir] = useState<'desc' | 'asc'>('desc');
  const PAGE_SIZE = 20;

  const handleExport = async () => {
    setExporting(true);
    try {
      const { data: event } = await supabase.from('events').select('id').eq('status', 'live').single();
      if (!event) throw new Error('No live event found');

      const { data, error } = await supabase.rpc('admin_export_event_results', {
        p_event_id: event.id
      });
      if (error) throw error;
      alert(data.message || 'Export job queued successfully.');
    } catch (err: any) {
      alert('Export failed: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      
      // 1. Fetch Stats
      const { count: athleteCount } = await supabase.from('athletes').select('*', { count: 'exact', head: true });
      const { count: bandCount } = await supabase.from('bands').select('*', { count: 'exact', head: true }).eq('status', 'assigned');
      const { count: resultCount } = await supabase.from('results').select('*', { count: 'exact', head: true });
      
      // 2. Fetch Stations Health
      const { data: stationList } = await supabase.from('stations').select('*');
      const { data: statusData } = await supabase.from('device_status').select('*');
      
      const mergedStations = (stationList || []).map(s => {
        const status = (statusData || []).find(st => st.station_id === s.id);
        return {
          ...s,
          status: status || null
        };
      });
      
      // 3. Fetch Athlete Progress
      const { data: athleteData } = await supabase
        .from('athletes')
        .select('*, bands(display_number), results(drill_type, value_num)')
        .order('created_at', { ascending: false });

      setStats({
        athletes: athleteCount || 0,
        bands: bandCount || 0,
        results: resultCount || 0,
        completed: athleteData?.filter(a => {
          // Dynamic completion check: has results for all required drills of the event
          // For now, we'll assume a simple check if they have at least 5 results as a fallback
          // or if they have results for all unique drill types in the catalog (if event required_drills is not available)
          return a.results?.length >= 5;
        }).length || 0
      });
      
      setStations(mergedStations);
      setAthletes(athleteData || []);
      setLoading(false);
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  function avgPercentile(athlete: any): number | null {
    const results: any[] = athlete.results || [];
    const percentiles = results
      .map((r: any) => calculatePercentile(r.value_num, r.drill_type))
      .filter((p): p is number => p !== null);
    if (percentiles.length === 0) return null;
    return Math.round(percentiles.reduce((a, b) => a + b, 0) / percentiles.length);
  }

  const filteredAthletes = athletes.filter(a =>
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    a.bands?.display_number?.toString().includes(searchTerm)
  );

  const sortedAthletes = [...filteredAthletes].sort((a, b) => {
    const pa = avgPercentile(a) ?? -1;
    const pb = avgPercentile(b) ?? -1;
    return scoreSortDir === 'desc' ? pb - pa : pa - pb;
  });

  const paginatedAthletes = sortedAthletes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filteredAthletes.length / PAGE_SIZE);

  const exportCSV = () => {
    const drillIds = DRILL_CATALOG.map(d => d.id);
    const headers = ['ID', 'Number', 'Name', 'Position', ...drillIds.map(id => DRILL_CATALOG.find(d => d.id === id)?.label || id)];
    
    const rows = athletes.map(a => {
      const drillResults = drillIds.map(id => {
        const res = a.results?.find((r: any) => r.drill_type === id);
        return res ? res.value_num : '';
      });

      return [
        a.id,
        a.bands?.display_number || 'N/A',
        `${a.first_name} ${a.last_name}`,
        a.position || 'N/A',
        ...drillResults
      ];
    });
    
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `combine_results_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="min-h-screen bg-zinc-50">
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
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-100 hover:bg-zinc-200 rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {exporting ? 'Queueing...' : 'Export Results'}
            </button>
            <div className="w-10 h-10 bg-zinc-200 rounded-full border-2 border-white shadow-sm" />
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-8 space-y-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : (
            <>
              <StatCard icon={<Users />} label="Athletes Registered" value={stats.athletes} color="blue" />
              <StatCard icon={<CreditCard />} label="Bands Assigned" value={stats.bands} color="purple" />
              <StatCard icon={<Activity />} label="Results Captured" value={stats.results} color="emerald" />
              <StatCard icon={<CheckCircle />} label="Completed Drills" value={stats.completed} color="amber" />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Athlete Table */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Athlete Progress</h2>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input 
                  type="text" 
                  placeholder="Search athletes..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
                />
              </div>
            </div>

            {loading ? (
              <SkeletonTable />
            ) : (
            <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-100">
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">#</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Athlete</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Position</th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Progress</th>
                    <th
                      className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500 cursor-pointer select-none hover:text-zinc-900 transition-colors"
                      onClick={() => setScoreSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                    >
                      Score {scoreSortDir === 'desc' ? '↓' : '↑'}
                    </th>
                    <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {paginatedAthletes.map((athlete) => (
                    <tr key={athlete.id} className="hover:bg-zinc-50 transition-colors">
                      <td className="px-6 py-4 font-black text-zinc-400">
                        {athlete.bands?.display_number || '--'}
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-bold">{athlete.first_name} {athlete.last_name}</div>
                        <div className="text-xs text-zinc-400">{athlete.parent_email}</div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="px-2 py-1 bg-zinc-100 rounded text-xs font-bold">{athlete.position || 'N/A'}</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-emerald-500 rounded-full" 
                              style={{ width: `${Math.min((athlete.results?.length || 0) / 5 * 100, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs font-bold">{athlete.results?.length || 0}/5</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {(() => {
                          const score = avgPercentile(athlete);
                          return score !== null ? (
                            <span className="text-sm font-black text-zinc-900">{score}<span className="text-xs font-normal text-zinc-400">th</span></span>
                          ) : (
                            <span className="text-xs text-zinc-300 font-medium">—</span>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        {athlete.results?.length >= 5 ? (
                          <span className="text-emerald-600 flex items-center gap-1 text-xs font-bold">
                            <CheckCircle className="w-3 h-3" /> Ready
                          </span>
                        ) : (
                          <span className="text-amber-600 flex items-center gap-1 text-xs font-bold">
                            <Activity className="w-3 h-3" /> Testing
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-2">
                <p className="text-xs text-zinc-500 font-medium">
                  Showing {page * PAGE_SIZE + 1} to {Math.min((page + 1) * PAGE_SIZE, filteredAthletes.length)} of {filteredAthletes.length} athletes
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
                    Page {page + 1} of {totalPages}
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

          {/* Station Health */}
          <div className="space-y-4">
            <h2 className="text-xl font-bold">Station Health</h2>
            <div className="space-y-4">
              {stations.length === 0 ? (
                <div className="p-8 bg-white rounded-3xl border border-zinc-200 text-center text-zinc-400 text-sm">
                  No stations configured.
                </div>
              ) : (
                stations.map((station) => {
                  const status = station.status;
                  const lastSeen = status ? new Date(status.last_seen_at) : null;
                  const now = new Date();
                  const diffMinutes = lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / 60000) : null;
                  const isStale = diffMinutes !== null && diffMinutes > 2;
                  const isOffline = !status || !status.is_online || isStale;
                  
                  const lastSync = status?.last_sync_at ? new Date(status.last_sync_at) : null;
                  const syncDiffMinutes = lastSync ? Math.floor((now.getTime() - lastSync.getTime()) / 60000) : null;
                  const isSyncStale = syncDiffMinutes !== null && syncDiffMinutes > 10;

                  return (
                    <div key={station.id} className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4 relative overflow-hidden">
                      {isOffline && status && <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />}
                      {!status && <div className="absolute top-0 left-0 w-1 h-full bg-zinc-300" />}
                      
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg ${!isOffline ? 'bg-emerald-100 text-emerald-600' : status ? 'bg-red-100 text-red-600' : 'bg-zinc-100 text-zinc-400'}`}>
                            {!isOffline ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                          </div>
                          <div>
                            <h3 className="font-bold">{station.name}</h3>
                            <p className="text-[10px] font-mono text-zinc-400 uppercase">{status?.device_label || 'No device connected'}</p>
                          </div>
                        </div>
                        <div className={`px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                          !isOffline ? 'bg-emerald-100 text-emerald-700' : status ? 'bg-red-100 text-red-700' : 'bg-zinc-100 text-zinc-500'
                        }`}>
                          {!status ? 'Not Active' : !isOffline ? 'Online' : 'Offline'}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-4 border-t border-zinc-50">
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1">Outbox</div>
                          <div className={`text-xl font-black ${status?.pending_queue_count > 50 ? 'text-red-600' : status?.pending_queue_count > 10 ? 'text-amber-600' : 'text-zinc-900'}`}>
                            {status?.pending_queue_count ?? '--'}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1">Last Sync</div>
                          <div className={`text-xs font-bold ${isSyncStale ? 'text-red-600' : 'text-zinc-600'}`}>
                            {lastSync ? lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {status?.pending_queue_count > 50 && (
                          <div className="p-2 bg-red-50 border border-red-100 rounded-xl flex items-center gap-2 text-red-700 text-[10px] font-bold uppercase">
                            <AlertTriangle className="w-3 h-3" />
                            Critical: Large pending queue
                          </div>
                        )}
                        {isSyncStale && (
                          <div className="p-2 bg-amber-50 border border-amber-100 rounded-xl flex items-center gap-2 text-amber-700 text-[10px] font-bold uppercase">
                            <AlertTriangle className="w-3 h-3" />
                            Warning: Stale sync ({syncDiffMinutes}m ago)
                          </div>
                        )}
                        {isStale && status && !status.is_online && (
                          <div className="p-2 bg-zinc-100 border border-zinc-200 rounded-xl flex items-center gap-2 text-zinc-500 text-[10px] font-bold uppercase">
                            <Activity className="w-3 h-3" />
                            Device heartbeat lost
                          </div>
                        )}
                        {!status && (
                          <div className="p-2 bg-zinc-50 border border-zinc-100 rounded-xl flex items-center gap-2 text-zinc-400 text-[10px] font-bold uppercase">
                            <Clock className="w-3 h-3" />
                            Waiting for first heartbeat
                          </div>
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

/**
 * Resolves the current live event and renders a Coach Portal deep-link.
 * Shows nothing while loading or when no live event exists.
 */
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

function StatCard({ icon, label, value, color }: { icon: React.ReactNode, label: string, value: number, color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    purple: 'bg-purple-50 text-purple-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600'
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
