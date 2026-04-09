import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Activity, AlertTriangle, Wifi, WifiOff,
  RefreshCw, Clock, TrendingUp, Users,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AggregateMetrics {
  active_events:       number;
  athletes_ytd:        number;
  lasers_online:       number;
  lasers_total:        number;
  compliance_flags:    number;
}

interface LiveEventRow {
  id:                  string;
  name:                string;
  location:            string;
  event_date:          string;
  athlete_count:       number;
  checked_in:          number;
  stations_online:     number;
  stations_total:      number;
  pending_sync_items:  number;
  has_offline:         boolean;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  label, value, sub, accent, icon,
}: {
  label:   string;
  value:   string | number;
  sub?:    string;
  accent?: 'green' | 'amber' | 'red' | 'blue' | 'default';
  icon?:   React.ReactNode;
}) {
  const accentMap = {
    green:   'text-emerald-400',
    amber:   'text-amber-400',
    red:     'text-red-400',
    blue:    'text-sky-400',
    default: 'text-white',
  };
  const color = accentMap[accent ?? 'default'];

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</span>
        {icon && <span className="text-zinc-600">{icon}</span>}
      </div>
      <div>
        <p className={`font-mono font-black text-3xl tabular-nums leading-none ${color}`}>{value}</p>
        {sub && <p className="text-[10px] text-zinc-500 font-mono mt-1.5 tracking-wide">{sub}</p>}
      </div>
    </div>
  );
}

function CheckinBar({ pct }: { pct: number }) {
  const color = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-zinc-600';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono tabular-nums text-zinc-400 w-8 text-right">{pct}%</span>
    </div>
  );
}

function SyncStatusDot({ pending, offline }: { pending: number; offline: boolean }) {
  if (offline)  return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="Station offline" />;
  if (pending)  return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" title={`${pending} pending`} />;
  return             <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" title="Synced" />;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LeagueDashboard() {
  const [metrics, setMetrics]     = useState<AggregateMetrics | null>(null);
  const [liveEvents, setLiveEvents] = useState<LiveEventRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const today = new Date().toISOString().split('T')[0];

      // ── Aggregate: all events ────────────────────────────────────────────
      const { data: eventsData } = await supabase
        .from('events')
        .select('id, name, location, event_date, status');

      const activeCount = (eventsData ?? []).filter(
        (e: any) => e.status === 'active' || e.event_date === today
      ).length;

      // ── Athletes YTD ─────────────────────────────────────────────────────
      const { count: athleteYTD } = await supabase
        .from('athletes')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', `${new Date().getFullYear()}-01-01`);

      // ── Device status (lasers/stations) ──────────────────────────────────
      const { data: deviceData } = await supabase
        .from('device_status')
        .select('station_id, status, pending_queue_count, last_heartbeat, event_id');

      const recentCutoff = Date.now() - 2 * 60 * 1000; // 2 min
      const allStations  = deviceData ?? [];
      const online = allStations.filter(
        (d: any) => new Date(d.last_heartbeat).getTime() > recentCutoff
      );

      // ── Compliance flags (extraordinary results unreviewed) ───────────────
      const { count: flagCount } = await supabase
        .from('results')
        .select('*', { count: 'exact', head: true })
        .eq('validation_status', 'extraordinary')
        .eq('voided', false);

      setMetrics({
        active_events:    activeCount,
        athletes_ytd:     athleteYTD ?? 0,
        lasers_online:    online.length,
        lasers_total:     allStations.length,
        compliance_flags: flagCount ?? 0,
      });

      // ── Today's events (Live Event Matrix) ───────────────────────────────
      const todayEvents = (eventsData ?? []).filter(
        (e: any) => e.event_date === today || e.status === 'active'
      );

      const enriched: LiveEventRow[] = await Promise.all(
        todayEvents.map(async (ev: any) => {
          const { count: total }    = await supabase
            .from('athletes')
            .select('*', { count: 'exact', head: true })
            .eq('event_id', ev.id);

          const { count: checkedIn } = await supabase
            .from('results')
            .select('athlete_id', { count: 'exact', head: true })
            .eq('event_id', ev.id)
            .eq('voided', false);

          const stationsForEvent = allStations.filter((d: any) => d.event_id === ev.id);
          const onlineForEvent   = stationsForEvent.filter(
            (d: any) => new Date(d.last_heartbeat).getTime() > recentCutoff
          );
          const pendingTotal = stationsForEvent.reduce(
            (sum: number, d: any) => sum + (d.pending_queue_count ?? 0), 0
          );

          const athleteCount = total ?? 0;
          const pct = athleteCount > 0 ? Math.round(((checkedIn ?? 0) / athleteCount) * 100) : 0;

          return {
            id:                 ev.id,
            name:               ev.name,
            location:           ev.location ?? '—',
            event_date:         ev.event_date,
            athlete_count:      athleteCount,
            checked_in:         checkedIn ?? 0,
            stations_online:    onlineForEvent.length,
            stations_total:     stationsForEvent.length,
            pending_sync_items: pendingTotal,
            has_offline:        stationsForEvent.some(
              (d: any) => new Date(d.last_heartbeat).getTime() <= recentCutoff
            ),
          };
        })
      );

      setLiveEvents(enriched);
      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const m = metrics;

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-black uppercase tracking-[0.15em] text-white">Global Command Center</h1>
          <p className="text-[10px] font-mono text-zinc-500 mt-0.5 tabular-nums">
            LAST REFRESH — {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* ── Aggregate metrics row ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="Active Events"
          value={loading ? '—' : (m?.active_events ?? 0)}
          sub="TODAY / IN-PROGRESS"
          accent="blue"
          icon={<Activity className="w-4 h-4" />}
        />
        <MetricCard
          label="Athletes YTD"
          value={loading ? '—' : (m?.athletes_ytd ?? 0).toLocaleString()}
          sub="YEAR TO DATE"
          accent="default"
          icon={<Users className="w-4 h-4" />}
        />
        <MetricCard
          label="Stations Online"
          value={loading ? '—' : `${m?.lasers_online ?? 0}/${m?.lasers_total ?? 0}`}
          sub="ACTIVE IN LAST 2 MIN"
          accent={
            !loading && m && m.lasers_total > 0 && m.lasers_online < m.lasers_total
              ? 'amber' : 'green'
          }
          icon={<Wifi className="w-4 h-4" />}
        />
        <MetricCard
          label="Compliance Flags"
          value={loading ? '—' : (m?.compliance_flags ?? 0)}
          sub="EXTRAORDINARY / UNREVIEWED"
          accent={(m?.compliance_flags ?? 0) > 0 ? 'red' : 'green'}
          icon={<AlertTriangle className="w-4 h-4" />}
        />
      </div>

      {/* ── Live Event Matrix ────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live Event Matrix
          </h2>
          <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">
            {liveEvents.length} event{liveEvents.length !== 1 ? 's' : ''} active
          </span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_1fr] gap-0 border-b border-zinc-800">
            {['Event / Location', 'Date', 'Check-in', 'Progress', 'Stations', 'Sync Status'].map(h => (
              <div key={h} className="px-3 py-2 text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-600">{h}</div>
            ))}
          </div>

          {loading && (
            <div className="px-3 py-8 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest animate-pulse">
              Querying live event data...
            </div>
          )}

          {!loading && liveEvents.length === 0 && (
            <div className="px-3 py-8 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
              No active events today
            </div>
          )}

          {!loading && liveEvents.map((ev, idx) => {
            const checkinPct = ev.athlete_count > 0
              ? Math.round((ev.checked_in / ev.athlete_count) * 100)
              : 0;

            return (
              <div
                key={ev.id}
                className={`grid grid-cols-[2fr_1fr_1fr_1.5fr_1fr_1fr] gap-0 border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors ${
                  idx % 2 === 0 ? '' : 'bg-zinc-900/40'
                }`}
              >
                {/* Event name */}
                <div className="px-3 py-3 flex flex-col justify-center">
                  <span className="text-xs font-bold text-zinc-100 truncate leading-tight">{ev.name}</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight mt-0.5 truncate">{ev.location}</span>
                </div>

                {/* Date */}
                <div className="px-3 py-3 flex items-center">
                  <span className="text-[10px] font-mono tabular-nums text-zinc-400">{ev.event_date}</span>
                </div>

                {/* Check-in count */}
                <div className="px-3 py-3 flex items-center">
                  <span className="text-xs font-mono tabular-nums text-zinc-200">
                    <span className="text-white font-bold">{ev.checked_in}</span>
                    <span className="text-zinc-600">/{ev.athlete_count}</span>
                  </span>
                </div>

                {/* Progress bar */}
                <div className="px-3 py-3 flex items-center">
                  <CheckinBar pct={checkinPct} />
                </div>

                {/* Stations */}
                <div className="px-3 py-3 flex items-center gap-1.5">
                  {ev.has_offline
                    ? <WifiOff className="w-3 h-3 text-amber-400 shrink-0" />
                    : <Wifi className="w-3 h-3 text-emerald-400 shrink-0" />
                  }
                  <span className="text-[10px] font-mono tabular-nums text-zinc-400">
                    {ev.stations_online}/{ev.stations_total}
                  </span>
                </div>

                {/* Sync status */}
                <div className="px-3 py-3 flex items-center gap-2">
                  <SyncStatusDot pending={ev.pending_sync_items} offline={ev.has_offline} />
                  <span className="text-[10px] font-mono tabular-nums text-zinc-500">
                    {ev.pending_sync_items > 0 ? `${ev.pending_sync_items} pending` : 'clean'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── System clock footer ──────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2 border-t border-zinc-800">
        <Clock className="w-3 h-3 text-zinc-700" />
        <span className="text-[9px] font-mono text-zinc-700 uppercase tracking-widest">
          All times local · Data polling interval: 30s · HLC sync enabled
        </span>
      </div>
    </div>
  );
}
