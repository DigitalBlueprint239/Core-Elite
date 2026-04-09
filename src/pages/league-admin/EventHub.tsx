import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CalendarDays, MapPin, Users, ChevronRight } from 'lucide-react';

interface EventRow {
  id:          string;
  name:        string;
  location:    string;
  event_date:  string;
  status:      string;
  athlete_count?: number;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:   'bg-emerald-400/10 text-emerald-400 border-emerald-400/20',
    upcoming: 'bg-sky-400/10 text-sky-400 border-sky-400/20',
    complete: 'bg-zinc-700/40 text-zinc-500 border-zinc-700',
    draft:    'bg-amber-400/10 text-amber-400 border-amber-400/20',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider ${map[status] ?? map.draft}`}>
      {status}
    </span>
  );
}

export default function EventHub() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('events')
        .select('id, name, location, event_date, status')
        .order('event_date', { ascending: false });

      if (data) {
        const enriched = await Promise.all(
          data.map(async (ev: any) => {
            const { count } = await supabase
              .from('athletes')
              .select('*', { count: 'exact', head: true })
              .eq('event_id', ev.id);
            return { ...ev, athlete_count: count ?? 0 };
          })
        );
        setEvents(enriched);
      }
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-sm font-black uppercase tracking-[0.15em] text-white">Event Hub</h1>
        <p className="text-[10px] font-mono text-zinc-500 mt-0.5">All events across your organization</p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_0.5fr] border-b border-zinc-800">
          {['Event Name', 'Date', 'Location', 'Athletes', 'Status'].map(h => (
            <div key={h} className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-600">{h}</div>
          ))}
        </div>

        {loading && (
          <div className="py-10 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest animate-pulse">
            Loading events...
          </div>
        )}

        {!loading && events.map((ev, idx) => (
          <div
            key={ev.id}
            className={`grid grid-cols-[2fr_1fr_1fr_1fr_0.5fr] border-b border-zinc-800/60 hover:bg-zinc-800/40 transition-colors ${idx % 2 === 1 ? 'bg-zinc-900/40' : ''}`}
          >
            <div className="px-4 py-3 flex items-center gap-2">
              <CalendarDays className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
              <span className="text-xs font-bold text-zinc-100 truncate">{ev.name}</span>
            </div>
            <div className="px-4 py-3 flex items-center">
              <span className="text-[10px] font-mono tabular-nums text-zinc-400">{ev.event_date}</span>
            </div>
            <div className="px-4 py-3 flex items-center gap-1.5">
              <MapPin className="w-3 h-3 text-zinc-700 shrink-0" />
              <span className="text-[10px] font-mono text-zinc-400 truncate">{ev.location ?? '—'}</span>
            </div>
            <div className="px-4 py-3 flex items-center gap-1.5">
              <Users className="w-3 h-3 text-zinc-700 shrink-0" />
              <span className="text-[10px] font-mono tabular-nums text-zinc-300">{ev.athlete_count?.toLocaleString()}</span>
            </div>
            <div className="px-4 py-3 flex items-center">
              <StatusPill status={ev.status ?? 'draft'} />
            </div>
          </div>
        ))}

        {!loading && events.length === 0 && (
          <div className="py-10 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest">No events found</div>
        )}
      </div>
    </div>
  );
}
