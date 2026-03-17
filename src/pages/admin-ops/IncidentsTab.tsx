import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { 
  Search, 
  ShieldAlert, 
  CheckCircle2,
  Clock,
  AlertTriangle,
  User,
  LayoutGrid
} from 'lucide-react';

export function IncidentsTab({ eventId }: { eventId: string }) {
  const [incidents, setIncidents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchIncidents();
  }, [eventId]);

  async function fetchIncidents() {
    setLoading(true);
    const { data } = await supabase
      .from('incidents')
      .select('*, athletes(first_name, last_name), stations(station_id)')
      .eq('event_id', eventId)
      .order('recorded_at', { ascending: false });
    
    if (data) setIncidents(data);
    setLoading(false);
  }

  async function resolveIncident(id: string) {
    const notes = prompt('Enter resolution notes:');
    if (notes === null) return;

    const { error } = await supabase
      .from('incidents')
      .update({ 
        resolved_at: new Date().toISOString(),
        resolution_notes: notes
      })
      .eq('id', id);

    if (error) alert(error.message);
    else fetchIncidents();
  }

  const filteredIncidents = incidents.filter(i => 
    i.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
    `${i.athletes?.first_name} ${i.athletes?.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    i.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const severityColors = {
    low: 'bg-blue-100 text-blue-700',
    medium: 'bg-amber-100 text-amber-700',
    high: 'bg-orange-100 text-orange-700',
    critical: 'bg-red-100 text-red-700'
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Incident Log</h2>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input 
            type="text" 
            placeholder="Search incidents..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
          />
        </div>
      </div>

      <div className="grid gap-4">
        {filteredIncidents.length === 0 ? (
          <div className="p-12 bg-white rounded-3xl border border-zinc-200 text-center text-zinc-400 font-medium">
            No incidents logged for this event.
          </div>
        ) : (
          filteredIncidents.map((incident) => (
            <div key={incident.id} className={`bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4 relative overflow-hidden ${incident.resolved_at ? 'opacity-60' : ''}`}>
              {!incident.resolved_at && (
                <div className={`absolute top-0 left-0 w-1.5 h-full ${
                  incident.severity === 'critical' ? 'bg-red-500' : 
                  incident.severity === 'high' ? 'bg-orange-500' : 
                  'bg-amber-500'
                }`} />
              )}
              
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${severityColors[incident.severity as keyof typeof severityColors]}`}>
                    {incident.severity}
                  </div>
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">{incident.type}</span>
                </div>
                <div className="text-xs text-zinc-400 font-medium">
                  {new Date(incident.recorded_at).toLocaleString()}
                </div>
              </div>

              <div className="space-y-2">
                <p className="font-medium text-zinc-900">{incident.description}</p>
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                  <span className="flex items-center gap-1"><User className="w-3 h-3" /> {incident.athletes ? `${incident.athletes.first_name} ${incident.athletes.last_name}` : 'N/A'}</span>
                  <span className="flex items-center gap-1"><LayoutGrid className="w-3 h-3" /> {incident.stations?.station_id || 'N/A'}</span>
                </div>
              </div>

              {incident.resolved_at ? (
                <div className="pt-4 border-t border-zinc-50 bg-emerald-50 -mx-6 -mb-6 p-4 flex items-start gap-3">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5" />
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-widest text-emerald-700">Resolved</div>
                    <p className="text-xs text-emerald-600 italic">"{incident.resolution_notes}"</p>
                  </div>
                </div>
              ) : (
                <div className="pt-4 border-t border-zinc-50 flex justify-end">
                  <button 
                    onClick={() => resolveIncident(incident.id)}
                    className="px-4 py-2 bg-zinc-900 text-white rounded-xl text-xs font-bold hover:bg-zinc-800 transition-all"
                  >
                    Mark as Resolved
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
