import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import { 
  Plus, 
  Trash2, 
  Settings2, 
  LayoutGrid, 
  CheckCircle2, 
  XCircle,
  AlertCircle
} from 'lucide-react';
import { DRILL_CATALOG } from '../../constants';

export function StationsTab({ event }: { event: any }) {
  const [stations, setStations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formData, setFormData] = useState({
    id: '',
    name: '',
    drill_type: '',
    lane_count: 1,
    enabled: true
  });

  useEffect(() => {
    if (event) fetchStations();
  }, [event]);

  async function fetchStations() {
    setLoading(true);
    const { data } = await supabase
      .from('stations')
      .select('*')
      .eq('event_id', event.id);
    setStations(data || []);
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase
      .from('stations')
      .insert({
        ...formData,
        event_id: event.id
      });

    if (error) {
      alert(error.message);
    } else {
      fetchStations();
      setShowCreate(false);
      setFormData({ id: '', name: '', drill_type: '', lane_count: 1, enabled: true });
    }
  }

  async function toggleEnabled(station: any) {
    const { error } = await supabase
      .from('stations')
      .update({ enabled: !station.enabled })
      .eq('id', station.id);
    if (!error) fetchStations();
  }

  async function deleteStation(id: string) {
    if (!confirm('Are you sure you want to delete this station?')) return;
    const { error } = await supabase
      .from('stations')
      .delete()
      .eq('id', id);
    if (!error) fetchStations();
  }

  if (!event) return <div className="p-8 text-center text-zinc-400">Select an event to manage stations.</div>;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Station Layout</h2>
        <button 
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-800 transition-all"
        >
          <Plus className="w-4 h-4" />
          Add Station
        </button>
      </div>

      {showCreate && (
        <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">New Station</h3>
            <button onClick={() => setShowCreate(false)} className="text-zinc-400 hover:text-zinc-900">Cancel</button>
          </div>

          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-6">
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Station ID (e.g. SPEED-1)</label>
              <input 
                required
                value={formData.id}
                onChange={e => setFormData({...formData, id: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Display Name</label>
              <input 
                required
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                placeholder="40-Yard Dash Lane 1"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Drill Type</label>
              <select 
                required
                value={formData.drill_type}
                onChange={e => setFormData({...formData, drill_type: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              >
                <option value="">Select Drill</option>
                {DRILL_CATALOG.map(d => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Lane Count</label>
              <input 
                type="number"
                value={formData.lane_count}
                onChange={e => setFormData({...formData, lane_count: parseInt(e.target.value)})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </div>

            <div className="col-span-2 pt-4">
              <button 
                type="submit"
                className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
              >
                Save Station
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {stations.map(station => (
          <div key={station.id} className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4 group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${station.enabled ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-400'}`}>
                  <LayoutGrid className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold">{station.name}</h3>
                  <div className="text-xs font-mono text-zinc-400">{station.id}</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => toggleEnabled(station)}
                  className={`p-2 rounded-lg transition-all ${station.enabled ? 'text-emerald-600 hover:bg-emerald-50' : 'text-zinc-400 hover:bg-zinc-100'}`}
                >
                  {station.enabled ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                </button>
                <button 
                  onClick={() => deleteStation(station.id)}
                  className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-zinc-50">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1">Drill Type</div>
                <div className="text-xs font-bold text-zinc-900">
                  {DRILL_CATALOG.find(d => d.id === station.drill_type)?.label || station.drill_type}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1">Lanes</div>
                <div className="text-xs font-bold text-zinc-900">{station.lane_count}</div>
              </div>
            </div>
          </div>
        ))}

        {stations.length === 0 && !loading && (
          <div className="col-span-2 p-12 bg-white rounded-3xl border border-dashed border-zinc-200 text-center space-y-4">
            <div className="w-12 h-12 bg-zinc-50 rounded-full flex items-center justify-center mx-auto">
              <LayoutGrid className="w-6 h-6 text-zinc-300" />
            </div>
            <div>
              <h3 className="font-bold text-zinc-900">No stations configured</h3>
              <p className="text-zinc-500 text-sm">Add stations to this event to enable staff testing.</p>
            </div>
            <button 
              onClick={() => setShowCreate(true)}
              className="px-6 py-2 bg-zinc-900 text-white rounded-xl font-bold text-sm"
            >
              Add First Station
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
