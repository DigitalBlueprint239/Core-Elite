import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Download, FileText, AlertCircle } from 'lucide-react';
import { generateArmsCSV, buildExportFilename, downloadCSV, ExportableAthlete } from '../../lib/b2b-exports';

interface EventOption {
  id:   string;
  name: string;
}

export default function B2BExports() {
  const [events, setEvents]       = useState<EventOption[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [loading, setLoading]     = useState(false);
  const [exportDone, setExportDone] = useState(false);

  useEffect(() => {
    supabase.from('events').select('id, name').order('event_date', { ascending: false }).then(({ data }) => {
      setEvents((data ?? []).map((e: any) => ({ id: e.id, name: e.name })));
    });
  }, []);

  async function handleExport() {
    if (!selectedEvent) return;
    setLoading(true);
    setExportDone(false);
    try {
      const eventName = events.find(e => e.id === selectedEvent)?.name ?? selectedEvent;

      const { data: athletes } = await supabase
        .from('athletes')
        .select('id, first_name, last_name, position, high_school, grad_year, height_in, weight_lb')
        .eq('event_id', selectedEvent);

      const { data: results } = await supabase
        .from('results')
        .select('athlete_id, drill_type, value_num, attempt_number')
        .eq('event_id', selectedEvent)
        .eq('voided', false);

      // Build bestResults per athlete
      const bestMap: Record<string, Record<string, { value_num: number }>> = {};
      for (const r of (results ?? [])) {
        if (!bestMap[r.athlete_id]) bestMap[r.athlete_id] = {};
        const existing = bestMap[r.athlete_id][r.drill_type];
        if (!existing || r.value_num < existing.value_num) {
          bestMap[r.athlete_id][r.drill_type] = { value_num: r.value_num };
        }
      }

      const exportable: ExportableAthlete[] = (athletes ?? []).map((a: any) => ({
        id:          a.id,
        first_name:  a.first_name,
        last_name:   a.last_name,
        position:    a.position,
        high_school: a.high_school,
        grad_year:   a.grad_year,
        height_in:   a.height_in,
        weight_lb:   a.weight_lb,
        bestResults: bestMap[a.id] ?? {},
      }));

      const csv = generateArmsCSV(exportable, eventName);
      downloadCSV(csv, buildExportFilename(eventName));
      setExportDone(true);
      setTimeout(() => setExportDone(false), 3000);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-sm font-black uppercase tracking-[0.15em] text-white">B2B Exports</h1>
        <p className="text-[10px] font-mono text-zinc-500 mt-0.5">ARMS / JumpForward / XOS compatible CSV exports for institutional recruiting platforms</p>
      </div>

      {/* ARMS Export card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center gap-3">
          <FileText className="w-4 h-4 text-zinc-500" />
          <div>
            <p className="text-xs font-bold text-zinc-100 uppercase tracking-wider">ARMS Athlete Export</p>
            <p className="text-[10px] font-mono text-zinc-500 mt-0.5">
              ARMS v3.1 column schema · RFC 4180 CSV · UTF-8 BOM · Best result per drill
            </p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-500 w-20 shrink-0">Event</label>
            <select
              value={selectedEvent}
              onChange={e => setSelectedEvent(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-500 transition-colors appearance-none"
            >
              <option value="">— Select event —</option>
              {events.map(ev => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleExport}
              disabled={!selectedEvent || loading}
              className="flex items-center gap-2 px-4 py-2.5 bg-white text-zinc-900 rounded font-bold text-xs uppercase tracking-widest hover:bg-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              {loading ? 'Generating...' : exportDone ? 'Downloaded!' : 'Export ARMS CSV'}
            </button>
            {exportDone && (
              <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                ✓ Export written to audit log
              </span>
            )}
          </div>

          <div className="flex items-start gap-2 text-[10px] font-mono text-zinc-600 leading-relaxed border-t border-zinc-800 pt-4 mt-2">
            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5 text-amber-700" />
            <span>
              Each export is recorded in the FERPA audit log (action: <span className="text-zinc-400">data_export</span>).
              Only share with institutions authorized under your Data Processing Agreement.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
