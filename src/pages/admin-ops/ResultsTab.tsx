import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Search, 
  Edit2, 
  Trash2, 
  Filter, 
  ChevronDown,
  AlertCircle,
  Save,
  X
} from 'lucide-react';

export function ResultsTab({ eventId }: { eventId: string }) {
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editReason, setEditReason] = useState('');

  useEffect(() => {
    fetchResults();
  }, [eventId]);

  async function fetchResults() {
    setLoading(true);
    const { data, error } = await supabase
      .from('results')
      .select('*, athletes(first_name, last_name), bands(display_number)')
      .eq('event_id', eventId)
      .order('recorded_at', { ascending: false });
    
    if (data) setResults(data);
    setLoading(false);
  }

  async function handleUpdate(result: any) {
    const { data: { user } } = await supabase.auth.getUser();
    
    const newMeta = {
      ...(result.meta || {}),
      audit: {
        edited_by: user?.id,
        edited_at: new Date().toISOString(),
        previous_value: result.value_num,
        reason: editReason
      }
    };

    const { error } = await supabase
      .from('results')
      .update({ 
        value_num: parseFloat(editValue),
        meta: newMeta
      })
      .eq('id', result.id);

    if (error) {
      alert(error.message);
    } else {
      setEditingId(null);
      fetchResults();
    }
  }

  const filteredResults = results.filter(r => 
    `${r.athletes?.first_name} ${r.athletes?.last_name}`.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.bands?.display_number?.toString().includes(searchTerm) ||
    r.drill_type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Results Management</h2>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input 
            type="text" 
            placeholder="Search results..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-zinc-900 w-64"
          />
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-100">
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Athlete</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Drill</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Value</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500">Recorded</th>
              <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-zinc-500 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filteredResults.map((result) => (
              <tr key={result.id} className="hover:bg-zinc-50 transition-colors">
                <td className="px-6 py-4">
                  <div className="font-bold">{result.athletes?.first_name} {result.athletes?.last_name}</div>
                  <div className="text-xs text-zinc-400">#{result.bands?.display_number}</div>
                </td>
                <td className="px-6 py-4">
                  <span className="px-2 py-1 bg-zinc-100 rounded text-xs font-bold uppercase tracking-wider">{result.drill_type}</span>
                </td>
                <td className="px-6 py-4">
                  {editingId === result.id ? (
                    <div className="flex items-center gap-2">
                      <input 
                        type="number"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="w-20 p-1 border border-zinc-300 rounded text-sm font-bold"
                      />
                      <input 
                        type="text"
                        placeholder="Reason"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        className="w-32 p-1 border border-zinc-300 rounded text-xs"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="font-black text-lg">{result.value_num}</span>
                      {result.meta?.outlier && (
                        <span className="text-[10px] font-bold text-amber-600 uppercase bg-amber-50 px-1.5 py-0.5 rounded">Outlier</span>
                      )}
                      {result.meta?.audit && (
                        <div className="group relative">
                          <AlertCircle className="w-3 h-3 text-zinc-300" />
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-zinc-900 text-white text-[10px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            Edited by admin. Reason: {result.meta.audit.reason}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-6 py-4 text-xs text-zinc-400">
                  {new Date(result.recorded_at).toLocaleString()}
                </td>
                <td className="px-6 py-4 text-right">
                  {editingId === result.id ? (
                    <div className="flex items-center justify-end gap-2">
                      <button 
                        onClick={() => handleUpdate(result)}
                        className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg"
                      >
                        <Save className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => setEditingId(null)}
                        className="p-2 text-zinc-400 hover:bg-zinc-100 rounded-lg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button 
                      onClick={() => {
                        setEditingId(result.id);
                        setEditValue(result.value_num.toString());
                        setEditReason('');
                      }}
                      className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
