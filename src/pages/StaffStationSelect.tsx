import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion, AnimatePresence } from 'motion/react';
import { MapPin, Zap, Clock, ChevronRight, RefreshCw, LogOut } from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LAST_STATION_KEY = 'ce_last_station_id';

function logDevError(context: string, err: unknown) {
  if (import.meta.env.DEV) {
    console.error(`[StaffStationSelect] ${context}`, err);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Station {
  id: string;
  name: string;
  drill_type: string;
  status: string;
  event_id: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function StaffStationSelect() {
  const navigate = useNavigate();

  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastStationId, setLastStationId] = useState<string | null>(null);
  const [lastStation, setLastStation] = useState<Station | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(LAST_STATION_KEY);
    if (saved) setLastStationId(saved);
    loadStations(saved);
  }, []);

  const loadStations = async (savedId?: string | null) => {
    setLoading(true);
    setError(null);

    try {
      const { data: events, error: eventError } = await supabase
        .from('events')
        .select('id, name, status')
        .in('status', ['live', 'draft'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (eventError) {
        logDevError('loadStations event lookup', eventError);
        setError('Could not load event information. Please try again.');
        return;
      }

      if (!events || events.length === 0) {
        setError('No active event found. Please contact the event director.');
        return;
      }

      const activeEvent = events[0];

      const { data: stationData, error: stationError } = await supabase
        .from('stations')
        .select('id, name, drill_type, status, event_id')
        .eq('event_id', activeEvent.id)
        .order('name', { ascending: true });

      if (stationError) {
        logDevError('loadStations station lookup', stationError);
        setError('Could not load stations. Please try again.');
        return;
      }

      const list: Station[] = stationData ?? [];
      setStations(list);

      if (savedId) {
        const match = list.find((s) => s.id === savedId);
        setLastStation(match ?? null);
        if (!match) {
          localStorage.removeItem(LAST_STATION_KEY);
          setLastStationId(null);
        }
      }
    } catch (err: unknown) {
      logDevError('loadStations unexpected', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (station: Station) => {
    localStorage.setItem(LAST_STATION_KEY, station.id);
    navigate(`/staff/station/${station.id}`);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate('/staff/login');
  };

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; className: string }> = {
      active:   { label: 'Active',   className: 'bg-emerald-100 text-emerald-700' },
      inactive: { label: 'Inactive', className: 'bg-zinc-100 text-zinc-500' },
      paused:   { label: 'Paused',   className: 'bg-amber-100 text-amber-700' },
    };
    const { label, className } = map[status] ?? { label: status, className: 'bg-zinc-100 text-zinc-500' };
    return (
      <span className={`text-xs font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${className}`}>
        {label}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-pulse text-zinc-400 font-medium">Loading stations...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
        <div className="max-w-sm w-full bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-6">
          <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto">
            <MapPin className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-xl font-bold mb-2">Stations unavailable</h2>
            <p className="text-zinc-500 text-sm">{error}</p>
          </div>
          <button
            onClick={() => loadStations(lastStationId)}
            className="w-full py-3 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
          <button
            onClick={handleSignOut}
            className="w-full py-3 bg-white border border-zinc-200 text-zinc-600 rounded-2xl font-bold hover:bg-zinc-50 transition-all"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-10">
      <div className="max-w-lg mx-auto space-y-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-black uppercase italic tracking-tighter">
              Select Station
            </h1>
            <p className="text-zinc-500 text-sm mt-1">
              Choose the testing station you are operating today.
            </p>
          </div>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-700 text-sm font-bold transition-colors pt-1"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>

        <AnimatePresence>
          {lastStation && (
            <motion.div
              key="rejoin"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="bg-zinc-900 text-white p-5 rounded-3xl shadow-lg"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-white/10 rounded-xl">
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-0.5">
                      Last used
                    </p>
                    <p className="font-bold text-lg leading-tight">{lastStation.name}</p>
                    <p className="text-zinc-400 text-xs">{lastStation.drill_type}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleSelect(lastStation)}
                  className="shrink-0 px-5 py-2.5 bg-white text-zinc-900 rounded-2xl font-bold text-sm hover:bg-zinc-100 transition-all"
                >
                  Rejoin
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {stations.length === 0 ? (
          <div className="bg-white p-8 rounded-3xl border border-zinc-200 text-center text-zinc-400">
            <MapPin className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No stations found for this event.</p>
            <p className="text-sm mt-1">Please contact the event director to set up stations.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-400 px-1">
              All Stations ({stations.length})
            </p>
            {stations.map((station) => (
              <motion.button
                key={station.id}
                onClick={() => handleSelect(station)}
                whileTap={{ scale: 0.98 }}
                className={`w-full bg-white p-5 rounded-2xl border text-left flex items-center justify-between gap-4 hover:border-zinc-400 hover:shadow-md transition-all ${
                  station.id === lastStationId
                    ? 'border-zinc-900 shadow-md'
                    : 'border-zinc-200'
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className="p-2.5 bg-zinc-100 rounded-xl shrink-0">
                    <Zap className="w-5 h-5 text-zinc-700" />
                  </div>
                  <div>
                    <p className="font-bold text-zinc-900">{station.name}</p>
                    <p className="text-zinc-500 text-sm">{station.drill_type}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {statusBadge(station.status)}
                  <ChevronRight className="w-4 h-4 text-zinc-400" />
                </div>
              </motion.button>
            ))}
          </div>
        )}

        <div className="text-center">
          <button
            onClick={() => loadStations(lastStationId)}
            className="text-zinc-400 hover:text-zinc-700 text-sm font-bold flex items-center gap-1.5 mx-auto transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh stations
          </button>
        </div>
      </div>
    </div>
  );
          }
