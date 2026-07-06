import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { LayoutGrid, MapPin, ChevronRight, LogOut, Wifi, WifiOff } from 'lucide-react';
import { motion } from 'motion/react';
import HardwareStandby from '../components/HardwareStandby';

export default function StationSelection() {
  const [stations, setStations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const navigate = useNavigate();

  useEffect(() => {
    const handleStatusChange = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', handleStatusChange);
    window.addEventListener('offline', handleStatusChange);
    return () => {
      window.removeEventListener('online', handleStatusChange);
      window.removeEventListener('offline', handleStatusChange);
    };
  }, []);

  useEffect(() => {
    async function fetchStations() {
      try {
        setLoading(true);
        // Fetch active event first
        const { data: event, error: eventError } = await supabase
          .from('events')
          .select('id, name')
          .eq('status', 'live')
          .single();

        if (eventError) throw new Error('No live event found.');

        // Fetch stations for this event
        const { data: stationsData, error: stationsError } = await supabase
          .from('stations')
          .select('*')
          .eq('event_id', event.id)
          .order('name');

        if (stationsError) throw stationsError;
        setStations(stationsData || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchStations();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  const selectStation = (stationId: string) => {
    localStorage.setItem('last_station_id', stationId);
    navigate(`/staff/station/${stationId}`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-center space-y-4">
          <div className="w-10 h-10 border-2 border-zinc-700 border-t-[#c8a200] rounded-full animate-spin mx-auto" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-400 animate-pulse">
            QUERYING LIVE EVENT...
          </p>
        </div>
      </div>
    );
  }

  // No live event — render the cinematic hardware standby terminal
  if (error === 'No live event found.') {
    return <HardwareStandby onRetry={() => window.location.reload()} />;
  }

  return (
    <div className="min-h-screen bg-zinc-50 pb-12">
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-zinc-900 rounded-lg">
              <LayoutGrid className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-black uppercase italic tracking-tighter text-xl">Station Selection</h1>
          </div>
          <div className="flex items-center gap-4">
            {isOnline ? (
              <div className="flex items-center gap-1.5 text-emerald-600 text-[10px] font-black uppercase tracking-widest bg-emerald-50 px-2 py-1 rounded-full">
                <Wifi className="w-3 h-3" /> Online
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-amber-600 text-[10px] font-black uppercase tracking-widest bg-amber-50 px-2 py-1 rounded-full">
                <WifiOff className="w-3 h-3" /> Offline
              </div>
            )}
            <button 
              onClick={handleLogout}
              className="p-2 text-zinc-400 hover:text-zinc-900 transition-colors"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {error ? (
          <div className="bg-zinc-900 border border-red-900/40 p-6 rounded-2xl text-center space-y-4">
            <div className="w-10 h-10 rounded-full bg-red-950/50 border border-red-800/50 flex items-center justify-center mx-auto">
              <span className="font-mono text-red-400 text-xs font-black">ERR</span>
            </div>
            <p className="font-mono text-sm text-red-400 font-bold">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-6 py-2.5 bg-zinc-800 border border-zinc-700 hover:border-zinc-600 text-zinc-300 rounded-lg font-mono text-xs font-bold uppercase tracking-widest transition-all"
            >
              [ RETRY ]
            </button>
          </div>
        ) : stations.length === 0 ? (
          <div className="text-center py-20 space-y-4">
            <MapPin className="w-16 h-16 text-zinc-200 mx-auto" />
            <h2 className="text-2xl font-bold text-zinc-400 uppercase italic tracking-tighter">No Stations Found</h2>
            <p className="text-zinc-400 max-w-xs mx-auto">Please contact the admin to configure stations for the live event.</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {stations.map((station, index) => (
              <motion.button
                key={station.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => selectStation(station.id)}
                className="group w-full bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm hover:border-zinc-900 hover:shadow-xl transition-all text-left flex items-center justify-between"
              >
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 bg-zinc-50 rounded-2xl flex items-center justify-center group-hover:bg-zinc-900 transition-colors">
                    <span className="text-2xl font-black italic text-zinc-300 group-hover:text-white transition-colors">
                      {index + 1}
                    </span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-xl font-bold text-zinc-900">{station.name}</h3>
                      <span className="px-2 py-0.5 bg-zinc-100 text-zinc-500 text-[10px] font-black uppercase tracking-widest rounded-full">
                        {station.type}
                      </span>
                    </div>
                    <p className="text-zinc-400 text-sm">Tap to begin testing at this station</p>
                  </div>
                </div>
                <ChevronRight className="w-6 h-6 text-zinc-200 group-hover:text-zinc-900 group-hover:translate-x-1 transition-all" />
              </motion.button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
