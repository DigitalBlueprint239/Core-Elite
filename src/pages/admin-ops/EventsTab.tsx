import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { motion } from 'motion/react';
import { 
  Plus, 
  Copy, 
  Archive, 
  Calendar as CalendarIcon, 
  MapPin, 
  ChevronRight,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import { DRILL_CATALOG } from '../../constants';

export function EventsTab({ events, onRefresh }: { events: any[], onRefresh: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    location: '',
    status: 'draft',
    required_drills: [] as string[],
    age_groups: ['8-10', '11-13', '14-17']
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } = await supabase
      .from('events')
      .insert({
        name: formData.name,
        slug: formData.slug,
        location: formData.location,
        status: formData.status,
        required_drills: formData.required_drills,
        age_groups: formData.age_groups
      });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      onRefresh();
      setShowCreate(false);
      setLoading(false);
    }
  }

  async function handleDuplicate(event: any) {
    setLoading(true);
    const newSlug = `${event.slug}-copy-${Math.floor(Math.random() * 1000)}`;
    const { data: newEvent, error } = await supabase
      .from('events')
      .insert({
        name: `${event.name} (Copy)`,
        slug: newSlug,
        location: event.location,
        status: 'draft',
        required_drills: event.required_drills,
        age_groups: event.age_groups
      })
      .select()
      .single();

    if (error) {
      alert(error.message);
    } else {
      // Also duplicate stations
      const { data: stations } = await supabase
        .from('stations')
        .select('*')
        .eq('event_id', event.id);

      if (stations && stations.length > 0) {
        const stationsToInsert = stations.map(s => ({
          id: `${s.id}-${newEvent.id.slice(0, 4)}`,
          event_id: newEvent.id,
          name: s.name,
          drill_type: s.drill_type,
          lane_count: s.lane_count,
          enabled: s.enabled,
          requires_auth: s.requires_auth
        }));
        await supabase.from('stations').insert(stationsToInsert);
      }
      onRefresh();
    }
    setLoading(false);
  }

  async function createDemoEvent() {
    setLoading(true);
    const { error } = await supabase
      .from('events')
      .insert({
        name: 'Core Elite Combine 2026',
        slug: 'coreelite2026',
        location: 'Miami, FL',
        status: 'live',
        required_drills: ['40YARD', 'VERTICAL', 'BENCH'],
        age_groups: ['8-10', '11-13', '14-17']
      });

    if (error) {
      alert(error.message);
    } else {
      onRefresh();
    }
    setLoading(false);
  }

  async function toggleStatus(event: any) {
    const statuses: ('draft' | 'live' | 'closed')[] = ['draft', 'live', 'closed'];
    const currentIndex = statuses.indexOf(event.status);
    const nextStatus = statuses[(currentIndex + 1) % statuses.length];
    
    setLoading(true);
    const { error } = await supabase
      .from('events')
      .update({ status: nextStatus })
      .eq('id', event.id);
    
    if (error) alert(error.message);
    else onRefresh();
    setLoading(false);
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Event Management</h2>
        <div className="flex items-center gap-3">
          {import.meta.env.DEV && (
            <button 
              onClick={createDemoEvent}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-700 border border-amber-200 rounded-xl font-bold text-sm hover:bg-amber-100 transition-all disabled:opacity-50"
            >
              <AlertCircle className="w-4 h-4" />
              Create Demo Event
            </button>
          )}
          <button 
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-800 transition-all"
          >
            <Plus className="w-4 h-4" />
            Create Event
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">New Event</h3>
            <button onClick={() => setShowCreate(false)} className="text-zinc-400 hover:text-zinc-900">Cancel</button>
          </div>

          <form onSubmit={handleCreate} className="grid grid-cols-2 gap-6">
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Event Name</label>
              <input 
                required
                value={formData.name}
                onChange={e => setFormData({...formData, name: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                placeholder="Core Elite Combine 2026"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Slug (URL)</label>
              <input 
                required
                value={formData.slug}
                onChange={e => setFormData({...formData, slug: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                placeholder="coreelite2026-miami"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Location</label>
              <input 
                required
                value={formData.location}
                onChange={e => setFormData({...formData, location: e.target.value})}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900"
                placeholder="Hard Rock Stadium"
              />
            </div>

            <div className="col-span-2 pt-4">
              <button 
                type="submit"
                disabled={loading}
                className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Event'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {events.map(event => (
          <div key={event.id} className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm flex items-center justify-between group hover:border-zinc-900 transition-all">
            <div className="flex items-center gap-6">
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
                event.status === 'live' ? 'bg-emerald-100 text-emerald-600' : 
                event.status === 'closed' ? 'bg-zinc-100 text-zinc-400' : 'bg-amber-100 text-amber-600'
              }`}>
                <CalendarIcon className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold">{event.name}</h3>
                  <button 
                    onClick={() => toggleStatus(event)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-colors ${
                      event.status === 'live' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 
                      event.status === 'closed' ? 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    }`}
                  >
                    {event.status}
                  </button>
                </div>
                <div className="flex items-center gap-4 text-sm text-zinc-400 mt-1">
                  <div className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    {event.location}
                  </div>
                  <div className="text-xs font-mono">/{event.slug}</div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button 
                onClick={() => handleDuplicate(event)}
                className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-all"
                title="Duplicate Event"
              >
                <Copy className="w-5 h-5" />
              </button>
              <button 
                className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                title="Archive Event"
              >
                <Archive className="w-5 h-5" />
              </button>
              <div className="w-px h-6 bg-zinc-100 mx-2" />
              <button className="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-xl text-sm font-bold">
                Manage
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
