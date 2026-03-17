import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import { 
  ClipboardList, 
  CheckCircle2, 
  Circle,
  AlertCircle,
  Info
} from 'lucide-react';
import { DRILL_CATALOG } from '../../constants';

export function DrillsTab({ event, onRefresh }: { event: any, onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);
  const requiredDrills = event?.required_drills || [];

  async function toggleDrill(drillId: string) {
    setLoading(true);
    const newDrills = requiredDrills.includes(drillId)
      ? requiredDrills.filter((id: string) => id !== drillId)
      : [...requiredDrills, drillId];

    const { error } = await supabase
      .from('events')
      .update({ required_drills: newDrills })
      .eq('id', event.id);

    if (error) {
      alert(error.message);
    } else {
      onRefresh();
    }
    setLoading(false);
  }

  if (!event) return <div className="p-8 text-center text-zinc-400">Select an event to manage drills.</div>;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Required Drills</h2>
          <p className="text-zinc-500 text-sm">Select which drills are mandatory for completion at this event.</p>
        </div>
        <div className="px-4 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold border border-emerald-100 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {requiredDrills.length} Drills Required
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-100 p-4 rounded-2xl flex items-start gap-3 text-amber-800 text-sm">
        <Info className="w-5 h-5 shrink-0 mt-0.5" />
        <p>
          <strong>Completion Logic:</strong> An athlete is marked as "Complete" in the system when they have at least one recorded result for every drill selected below.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {DRILL_CATALOG.map(drill => {
          const isRequired = requiredDrills.includes(drill.id);
          return (
            <button
              key={drill.id}
              onClick={() => toggleDrill(drill.id)}
              disabled={loading}
              className={`p-6 rounded-3xl border text-left transition-all flex items-center justify-between group ${
                isRequired 
                  ? 'bg-zinc-900 border-zinc-900 text-white shadow-lg' 
                  : 'bg-white border-zinc-200 text-zinc-900 hover:border-zinc-900'
              }`}
            >
              <div className="space-y-1">
                <div className="font-bold">{drill.label}</div>
                <div className={`text-xs ${isRequired ? 'text-zinc-400' : 'text-zinc-500'}`}>
                  {drill.type} • {drill.unit} • {drill.attempts_allowed} attempts
                </div>
              </div>
              <div className={`w-6 h-6 rounded-full border flex items-center justify-center transition-colors ${
                isRequired 
                  ? 'bg-emerald-500 border-emerald-500 text-white' 
                  : 'border-zinc-300 group-hover:border-zinc-900'
              }`}>
                {isRequired && <CheckCircle2 className="w-4 h-4" />}
              </div>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}
