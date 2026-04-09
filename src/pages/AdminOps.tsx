import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion, AnimatePresence } from 'motion/react';
import {
  Calendar,
  Settings,
  Database,
  CreditCard,
  ChevronRight,
  Plus,
  Copy,
  Archive,
  CheckCircle2,
  AlertCircle,
  LayoutGrid,
  ClipboardList,
  Activity,
  FileText,
  ShieldAlert,
  Home,
  Users,
} from 'lucide-react';
import { EventsTab } from './admin-ops/EventsTab';
import { StationsTab } from './admin-ops/StationsTab';
import { DrillsTab } from './admin-ops/DrillsTab';
import { BandsTab } from './admin-ops/BandsTab';
import { ResultsTab } from './admin-ops/ResultsTab';
import { WaiversTab } from './admin-ops/WaiversTab';
import { IncidentsTab } from './admin-ops/IncidentsTab';
import { AuditTab } from './admin-ops/AuditTab';
import { AthletesTab } from './admin-ops/AthletesTab';

export default function AdminOps() {
  const [activeTab, setActiveTab] = useState<'events' | 'stations' | 'drills' | 'bands' | 'athletes' | 'results' | 'waivers' | 'incidents' | 'audit'>('events');
  const [activeEvent, setActiveEvent] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    async function checkAdmin() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      if (profile?.role === 'admin') {
        setIsAdmin(true);
        fetchEvents();
      } else {
        // Redirect or show error
      }
    }
    checkAdmin();
  }, []);

  async function fetchEvents() {
    setLoading(true);
    const { data } = await supabase
      .from('events')
      .select('*')
      .order('created_at', { ascending: false });
    
    setEvents(data || []);
    if (data && data.length > 0 && !activeEvent) {
      setActiveEvent(data[0]);
    }
    setLoading(false);
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-zinc-500 text-sm">You do not have permission to access the Event Ops Control Panel.</p>
          <button 
            onClick={() => window.location.href = '/'}
            className="px-6 py-2 bg-zinc-900 text-white rounded-xl font-bold"
          >
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      {/* Top Bar - Event Context */}
      <header className="bg-white border-b border-zinc-200 px-8 py-4 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link 
              to="/" 
              className="p-2 hover:bg-zinc-100 rounded-xl transition-colors text-zinc-500 hover:text-zinc-900"
              title="Back to Home"
            >
              <Home className="w-6 h-6" />
            </Link>
            <div className="h-8 w-px bg-zinc-200 mx-2" />
            <div className="bg-zinc-900 text-white p-2 rounded-lg">
              <Settings className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-black uppercase italic tracking-tighter">Event Ops Control Panel</h1>
              <div className="flex items-center gap-2 text-xs font-bold text-zinc-400">
                <span>Active Event:</span>
                <select 
                  value={activeEvent?.id || ''} 
                  onChange={(e) => setActiveEvent(events.find(ev => ev.id === e.target.value))}
                  className="bg-transparent text-zinc-900 border-none p-0 focus:ring-0 cursor-pointer"
                >
                  {events.map(ev => (
                    <option key={ev.id} value={ev.id}>{ev.name} ({ev.slug})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="px-3 py-1 bg-zinc-100 rounded-full text-[10px] font-bold uppercase tracking-widest text-zinc-500">
              Admin Mode
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto flex gap-8 p-8">
        {/* Sidebar Nav */}
        <aside className="w-64 shrink-0 space-y-1">
          <NavButton 
            active={activeTab === 'events'} 
            onClick={() => setActiveTab('events')} 
            icon={<Calendar />} 
            label="Events" 
          />
          <NavButton 
            active={activeTab === 'stations'} 
            onClick={() => setActiveTab('stations')} 
            icon={<LayoutGrid />} 
            label="Stations" 
          />
          <NavButton 
            active={activeTab === 'drills'} 
            onClick={() => setActiveTab('drills')} 
            icon={<ClipboardList />} 
            label="Drills" 
          />
          <NavButton
            active={activeTab === 'bands'}
            onClick={() => setActiveTab('bands')}
            icon={<CreditCard />}
            label="Bands"
          />
          <NavButton
            active={activeTab === 'athletes'}
            onClick={() => setActiveTab('athletes')}
            icon={<Users />}
            label="Athletes"
          />
          <NavButton 
            active={activeTab === 'results'} 
            onClick={() => setActiveTab('results')} 
            icon={<Activity />} 
            label="Results" 
          />
          <NavButton 
            active={activeTab === 'waivers'} 
            onClick={() => setActiveTab('waivers')} 
            icon={<FileText />} 
            label="Waivers" 
          />
          <NavButton
            active={activeTab === 'incidents'}
            onClick={() => setActiveTab('incidents')}
            icon={<ShieldAlert />}
            label="Incidents"
          />
          <NavButton
            active={activeTab === 'audit'}
            onClick={() => setActiveTab('audit')}
            icon={<ClipboardList />}
            label="Audit Log"
          />

          <div className="pt-8 space-y-4">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 px-4">Event Day Checklist</h3>
            <div className="space-y-2 px-4">
              <ChecklistItem label="Create Event" done={!!activeEvent} />
              <ChecklistItem label="Configure Drills" done={activeEvent?.required_drills?.length > 0} />
              <ChecklistItem label="Configure Stations" done={false} /> {/* Need to check stations count */}
              <ChecklistItem label="Generate Bands" done={false} /> {/* Need to check bands count */}
              <ChecklistItem label="Create Staff Logins" done={true} />
              <ChecklistItem label="Test Scan" done={false} />
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            {activeTab === 'events' && (
              <EventsTab events={events} onRefresh={fetchEvents} />
            )}
            {activeTab === 'stations' && (
              <StationsTab event={activeEvent} />
            )}
            {activeTab === 'drills' && (
              <DrillsTab event={activeEvent} onRefresh={fetchEvents} />
            )}
            {activeTab === 'bands' && (
              <BandsTab event={activeEvent} />
            )}
            {activeTab === 'athletes' && (
              <AthletesTab event={activeEvent} />
            )}
            {activeTab === 'results' && (
              <ResultsTab eventId={activeEvent?.id} />
            )}
            {activeTab === 'waivers' && (
              <WaiversTab eventId={activeEvent?.id} />
            )}
            {activeTab === 'incidents' && (
              <IncidentsTab eventId={activeEvent?.id} />
            )}
            {activeTab === 'audit' && (
              <AuditTab eventId={activeEvent?.id} />
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm transition-all ${
        active 
          ? 'bg-zinc-900 text-white shadow-lg' 
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
      }`}
    >
      {React.cloneElement(icon as any, { className: 'w-5 h-5' })}
      {label}
    </button>
  );
}

function ChecklistItem({ label, done }: { label: string, done: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-zinc-300'}`}>
        {done && <CheckCircle2 className="w-3 h-3" />}
      </div>
      <span className={done ? 'text-zinc-400 line-through' : 'text-zinc-600'}>{label}</span>
    </div>
  );
}
