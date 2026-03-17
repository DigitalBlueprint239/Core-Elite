import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import { 
  CreditCard, 
  RefreshCw, 
  Upload, 
  Trash2, 
  AlertTriangle, 
  CheckCircle2,
  Search,
  UserPlus
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

export function BandsTab({ event }: { event: any }) {
  const [bands, setBands] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ total: 0, available: 0, assigned: 0, void: 0 });
  const [range, setRange] = useState({ start: 1, end: 500 });
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (event) fetchBands();
  }, [event]);

  async function fetchBands() {
    setLoading(true);
    const { data } = await supabase
      .from('bands')
      .select('*, athletes(first_name, last_name)')
      .eq('event_id', event.id)
      .order('display_number', { ascending: true });
    
    const b = data || [];
    setBands(b);
    setStats({
      total: b.length,
      available: b.filter(x => x.status === 'available').length,
      assigned: b.filter(x => x.status === 'assigned').length,
      void: b.filter(x => x.status === 'void').length,
    });
    setLoading(false);
  }

  async function generateBands() {
    if (!confirm(`Generate bands ${range.start} to ${range.end} for ${event.name}?`)) return;
    setLoading(true);
    
    const newBands = [];
    for (let i = range.start; i <= range.end; i++) {
      const displayNum = i;
      const padded = displayNum.toString().padStart(3, '0');
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const bandId = `${event.slug}-${padded}-${randomSuffix}`;
      
      newBands.push({
        band_id: bandId,
        event_id: event.id,
        display_number: displayNum,
        status: 'available'
      });
    }

    const { error } = await supabase.from('bands').insert(newBands);
    if (error) {
      alert(error.message);
    } else {
      fetchBands();
    }
    setLoading(false);
  }

  async function resetBands() {
    if (event.status !== 'draft') {
      alert('Bands can only be reset while the event is in DRAFT status.');
      return;
    }
    if (!confirm('BIG WARNING: This will reset ALL bands to available and unlink all athletes. This cannot be undone. Results will remain but will be unlinked from current athletes if they are re-assigned. Continue?')) return;
    
    setLoading(true);
    const { error } = await supabase
      .from('bands')
      .update({ status: 'available', athlete_id: null, assigned_at: null, assigned_by: null })
      .eq('event_id', event.id);
    
    if (error) alert(error.message);
    else fetchBands();
    setLoading(false);
  }

  async function voidBand(band: any) {
    if (!confirm(`Void band #${band.display_number}? This will unlink the athlete.`)) return;
    setLoading(true);
    
    // 1. Update band status to void
    const { error: bandError } = await supabase
      .from('bands')
      .update({ status: 'void' })
      .eq('band_id', band.band_id);
    
    if (bandError) {
      alert(bandError.message);
    } else if (band.athlete_id) {
      // 2. Unlink from athlete
      await supabase
        .from('athletes')
        .update({ band_id: null })
        .eq('id', band.athlete_id);
    }
    
    fetchBands();
    setLoading(false);
  }

  async function handleImportCSV(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
      
      const bandIdIdx = headers.indexOf('band_id');
      const displayNumIdx = headers.indexOf('display_number');

      if (bandIdIdx === -1 || displayNumIdx === -1) {
        alert('CSV must have band_id and display_number columns.');
        setLoading(false);
        return;
      }

      const newBands = lines.slice(1).map(line => {
        const parts = line.split(',');
        return {
          band_id: parts[bandIdIdx].trim(),
          display_number: parseInt(parts[displayNumIdx].trim()),
          event_id: event.id,
          status: 'available'
        };
      });

      const { error } = await supabase.from('bands').insert(newBands);
      if (error) alert(error.message);
      else fetchBands();
      setLoading(false);
    };
    reader.readAsText(file);
  }

  async function reissueBand(athleteId: string, oldBandId: string) {
    const newBandId = prompt('Enter new Band ID to assign:');
    if (!newBandId) return;

    setLoading(true);
    
    // 1. Void old band
    await supabase.from('bands').update({ status: 'void' }).eq('band_id', oldBandId);
    
    // 2. Assign new band
    const { error } = await supabase
      .from('bands')
      .update({ status: 'assigned', athlete_id: athleteId, assigned_at: new Date().toISOString() })
      .eq('band_id', newBandId);
    
    if (error) {
      alert(error.message);
    } else {
      // 3. Update athlete
      await supabase.from('athletes').update({ band_id: newBandId }).eq('id', athleteId);
      fetchBands();
    }
    setLoading(false);
  }

  const filteredBands = bands.filter(b => 
    b.display_number.toString().includes(searchTerm) ||
    b.athletes?.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    b.athletes?.last_name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!event) return <div className="p-8 text-center text-zinc-400">Select an event to manage bands.</div>;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Band Inventory</h2>
        <div className="flex items-center gap-2">
          <button 
            onClick={resetBands}
            disabled={event.status !== 'draft' || loading}
            className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-xl font-bold text-sm hover:bg-red-100 transition-all disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4" />
            Reset Inventory
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Available" value={stats.available} color="emerald" />
        <StatCard label="Assigned" value={stats.assigned} color="blue" />
        <StatCard label="Voided" value={stats.void} color="red" />
      </div>

      {/* Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4">
          <h3 className="font-bold flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-zinc-400" />
            Bulk Generate
          </h3>
          <div className="flex gap-4">
            <div className="flex-1 space-y-1">
              <label className="text-[10px] font-bold uppercase text-zinc-400">Start #</label>
              <input 
                type="number" 
                value={range.start} 
                onChange={e => setRange({...range, start: parseInt(e.target.value)})}
                className="w-full p-2 bg-zinc-50 border border-zinc-200 rounded-lg outline-none"
              />
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-[10px] font-bold uppercase text-zinc-400">End #</label>
              <input 
                type="number" 
                value={range.end} 
                onChange={e => setRange({...range, end: parseInt(e.target.value)})}
                className="w-full p-2 bg-zinc-50 border border-zinc-200 rounded-lg outline-none"
              />
            </div>
          </div>
          <button 
            onClick={generateBands}
            disabled={loading}
            className="w-full py-3 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            Generate Records
          </button>
        </div>

        <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4">
          <h3 className="font-bold flex items-center gap-2">
            <Upload className="w-4 h-4 text-zinc-400" />
            Import CSV
          </h3>
          <p className="text-xs text-zinc-500">Upload a CSV with <code>band_id</code> and <code>display_number</code> columns.</p>
          <label className="block w-full py-3 border-2 border-dashed border-zinc-200 text-zinc-500 rounded-xl font-bold text-sm hover:bg-zinc-50 transition-all text-center cursor-pointer">
            <input type="file" accept=".csv" onChange={handleImportCSV} className="hidden" />
            Select CSV File
          </label>
        </div>
      </div>

      {/* Band List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">Inventory List</h3>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input 
              type="text" 
              placeholder="Search by # or name..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
            />
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-100">
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">#</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Band ID</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Athlete</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Status</th>
                <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filteredBands.slice(0, 50).map(band => (
                <tr key={band.band_id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-6 py-4 font-black text-zinc-900">{band.display_number}</td>
                  <td className="px-6 py-4 font-mono text-[10px] text-zinc-400">{band.band_id}</td>
                  <td className="px-6 py-4">
                    {band.athletes ? (
                      <div className="font-bold">{band.athletes.first_name} {band.athletes.last_name}</div>
                    ) : (
                      <span className="text-zinc-300 italic text-xs">Unassigned</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                      band.status === 'assigned' ? 'bg-blue-100 text-blue-700' : 
                      band.status === 'void' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      {band.status}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {band.status === 'assigned' && (
                        <>
                          <button 
                            onClick={() => reissueBand(band.athlete_id, band.band_id)}
                            className="p-2 text-zinc-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                            title="Reissue Band"
                          >
                            <UserPlus className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => voidBand(band)}
                            className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                            title="Void Band"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredBands.length > 50 && (
            <div className="p-4 text-center text-xs text-zinc-400 bg-zinc-50 border-t border-zinc-100">
              Showing first 50 of {filteredBands.length} results
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function StatCard({ label, value, color = 'zinc' }: { label: string, value: number, color?: string }) {
  const colors: Record<string, string> = {
    zinc: 'text-zinc-900',
    emerald: 'text-emerald-600',
    blue: 'text-blue-600',
    red: 'text-red-600'
  };
  return (
    <div className="bg-white p-4 rounded-2xl border border-zinc-200 shadow-sm">
      <div className={`text-2xl font-black ${colors[color]}`}>{value}</div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">{label}</div>
    </div>
  );
}
