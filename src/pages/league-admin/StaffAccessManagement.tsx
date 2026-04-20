import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Search, UserX, ChevronDown, Save, RefreshCw,
  AlertTriangle, CheckCircle2, Shield,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type EventRole = 'event_admin' | 'station_operator' | 'coach' | 'scout' | 'no_access';

interface StaffMember {
  id:          string;
  email:       string;
  display_name: string;
  last_sign_in?: string;
}

interface EventSummary {
  id:    string;
  name:  string;
  event_date: string;
}

// role[staffId][eventId] = EventRole
type RoleMatrix = Record<string, Record<string, EventRole>>;

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLES: { value: EventRole; label: string; color: string }[] = [
  { value: 'event_admin',      label: 'Event Admin',      color: 'text-sky-400' },
  { value: 'station_operator', label: 'Station Operator', color: 'text-emerald-400' },
  { value: 'coach',            label: 'Coach',            color: 'text-purple-400' },
  { value: 'scout',            label: 'Scout',            color: 'text-amber-400' },
  { value: 'no_access',        label: 'No Access',        color: 'text-zinc-600' },
];

function roleColor(role: EventRole): string {
  return ROLES.find(r => r.value === role)?.color ?? 'text-zinc-600';
}

// ─── Role selector cell ───────────────────────────────────────────────────────

function RoleCell({
  role, onChange, disabled,
}: {
  role:     EventRole;
  onChange: (r: EventRole) => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative inline-flex items-center">
      <select
        value={role}
        disabled={disabled}
        onChange={e => onChange(e.target.value as EventRole)}
        className={`appearance-none bg-transparent border border-zinc-800 rounded px-2 py-1 text-[10px] font-bold uppercase tracking-widest pr-5 cursor-pointer hover:border-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${roleColor(role)}`}
      >
        {ROLES.map(r => (
          <option key={r.value} value={r.value} className="bg-zinc-900 text-zinc-300">
            {r.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 w-3 h-3 text-zinc-600" />
    </div>
  );
}

// ─── Confirm modal (Revoke All) ───────────────────────────────────────────────

function RevokeConfirmModal({
  staffName, onConfirm, onCancel,
}: {
  staffName: string;
  onConfirm: () => void;
  onCancel:  () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm bg-zinc-900 border border-red-800 rounded-lg shadow-2xl overflow-hidden">
        <div className="bg-red-950 border-b border-red-800 px-5 py-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
          <div>
            <p className="text-sm font-black text-white uppercase tracking-wider">Revoke All Access</p>
            <p className="text-[10px] text-red-300 mt-0.5">This action takes effect immediately</p>
          </div>
        </div>
        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-zinc-300">
            All event roles for{' '}
            <span className="font-bold text-white">{staffName}</span>{' '}
            will be set to <span className="font-mono text-red-400">NO ACCESS</span> across every event.
          </p>
          <p className="text-[10px] text-zinc-500 font-mono leading-relaxed">
            Active sessions will be invalidated. The staff member will not be able to log in
            to any station or admin panel until roles are re-assigned.
          </p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onConfirm}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded font-bold text-xs uppercase tracking-widest transition-colors"
            >
              Confirm Revocation
            </button>
            <button
              onClick={onCancel}
              className="flex-1 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded font-bold text-xs uppercase tracking-widest transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StaffAccessManagement() {
  const [staff, setStaff]           = useState<StaffMember[]>([]);
  const [events, setEvents]          = useState<EventSummary[]>([]);
  const [matrix, setMatrix]          = useState<RoleMatrix>({});
  const [dirtyMatrix, setDirtyMatrix] = useState<RoleMatrix>({});
  const [loading, setLoading]        = useState(true);
  const [saving, setSaving]          = useState<string | null>(null);  // staffId being saved
  const [search, setSearch]          = useState('');
  const [revokeTarget, setRevokeTarget] = useState<StaffMember | null>(null);
  const [savedFlash, setSavedFlash]  = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch profiles (staff users)
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, user_id, display_name')
        .order('display_name');

      // Fetch events (recent + upcoming)
      const { data: eventsData } = await supabase
        .from('events')
        .select('id, name, event_date')
        .order('event_date', { ascending: false })
        .limit(20);

      // Fetch current role assignments
      // staff_assignments: { staff_id, event_id, role }
      const { data: assignments } = await supabase
        .from('staff_assignments')
        .select('staff_id, event_id, role');

      const evList: EventSummary[] = (eventsData ?? []).map((e: any) => ({
        id:         e.id,
        name:       e.name,
        event_date: e.event_date,
      }));

      const stList: StaffMember[] = (profiles ?? []).map((p: any) => ({
        id:           p.id,
        email:        p.display_name ?? p.id?.slice(0, 8) ?? '—',
        display_name: p.display_name ?? p.id?.slice(0, 8) ?? '—',
      }));

      // Build matrix from assignments
      const built: RoleMatrix = {};
      for (const s of stList) {
        built[s.id] = {};
        for (const ev of evList) built[s.id][ev.id] = 'no_access';
      }
      for (const a of (assignments ?? [])) {
        if (built[a.staff_id]) built[a.staff_id][a.event_id] = a.role as EventRole;
      }

      setStaff(stList);
      setEvents(evList);
      setMatrix(built);
      setDirtyMatrix(JSON.parse(JSON.stringify(built)));  // deep clone
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  function setRole(staffId: string, eventId: string, role: EventRole) {
    setDirtyMatrix(prev => ({
      ...prev,
      [staffId]: { ...prev[staffId], [eventId]: role },
    }));
  }

  function isDirty(staffId: string): boolean {
    const orig = matrix[staffId] ?? {};
    const dirty = dirtyMatrix[staffId] ?? {};
    return JSON.stringify(orig) !== JSON.stringify(dirty);
  }

  async function saveStaff(staffId: string) {
    setSaving(staffId);
    try {
      const evIds = events.map(e => e.id);
      const upserts = evIds.map(evId => ({
        staff_id: staffId,
        event_id: evId,
        role:     dirtyMatrix[staffId]?.[evId] ?? 'no_access',
      }));

      // Delete existing assignments for this staff member, then bulk insert
      await supabase.from('staff_assignments').delete().eq('staff_id', staffId);
      const nonNoAccess = upserts.filter(u => u.role !== 'no_access');
      if (nonNoAccess.length > 0) {
        await supabase.from('staff_assignments').insert(nonNoAccess);
      }

      // Commit dirty → canonical
      setMatrix(prev => ({ ...prev, [staffId]: { ...dirtyMatrix[staffId] } }));

      setSavedFlash(staffId);
      setTimeout(() => setSavedFlash(null), 2000);
    } finally {
      setSaving(null);
    }
  }

  async function revokeAll(staffId: string) {
    await supabase.from('staff_assignments').delete().eq('staff_id', staffId);
    const resetRow: Record<string, EventRole> = {};
    events.forEach(ev => { resetRow[ev.id] = 'no_access'; });
    setMatrix(prev => ({ ...prev, [staffId]: resetRow }));
    setDirtyMatrix(prev => ({ ...prev, [staffId]: resetRow }));
    setRevokeTarget(null);
  }

  const filteredStaff = staff.filter(s =>
    s.display_name.toLowerCase().includes(search.toLowerCase()) ||
    s.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      {revokeTarget && (
        <RevokeConfirmModal
          staffName={revokeTarget.display_name}
          onConfirm={() => revokeAll(revokeTarget.id)}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-black uppercase tracking-[0.15em] text-white">Staff Identity & Access</h1>
          <p className="text-[10px] font-mono text-zinc-500 mt-0.5">Role matrix across all events · changes auto-invalidate active sessions</p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-600 pointer-events-none" />
        <input
          type="text"
          placeholder="Search staff..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded pl-8 pr-3 py-2 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
        />
      </div>

      {/* Matrix table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-auto">
        {loading ? (
          <div className="px-4 py-10 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest animate-pulse">
            Loading staff matrix...
          </div>
        ) : (
          <table className="w-full border-collapse text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="sticky left-0 z-10 bg-zinc-900 px-4 py-2.5 text-left text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-500 min-w-[180px]">
                  Staff Member
                </th>
                {events.map(ev => (
                  <th
                    key={ev.id}
                    className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-500 whitespace-nowrap min-w-[140px]"
                  >
                    <div className="leading-tight">{ev.name}</div>
                    <div className="font-mono text-zinc-700 text-[8px] mt-0.5">{ev.event_date}</div>
                  </th>
                ))}
                <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-500 text-right min-w-[160px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredStaff.map((s, idx) => {
                const dirty   = isDirty(s.id);
                const isSaving = saving === s.id;
                const saved   = savedFlash === s.id;

                return (
                  <tr
                    key={s.id}
                    className={`border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors ${
                      idx % 2 === 1 ? 'bg-zinc-900/50' : ''
                    }`}
                  >
                    {/* Staff info — sticky on horizontal scroll */}
                    <td className="sticky left-0 z-10 bg-inherit px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                          <Shield className="w-3 h-3 text-zinc-500" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-zinc-200 truncate leading-tight">{s.display_name}</p>
                          <p className="text-[9px] font-mono text-zinc-600 truncate leading-tight">{s.email}</p>
                        </div>
                      </div>
                    </td>

                    {/* Role cell per event */}
                    {events.map(ev => (
                      <td key={ev.id} className="px-3 py-3">
                        <RoleCell
                          role={dirtyMatrix[s.id]?.[ev.id] ?? 'no_access'}
                          onChange={r => setRole(s.id, ev.id, r)}
                          disabled={isSaving}
                        />
                      </td>
                    ))}

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {saved ? (
                          <span className="flex items-center gap-1 text-[10px] font-mono text-emerald-400">
                            <CheckCircle2 className="w-3 h-3" /> Saved
                          </span>
                        ) : (
                          <button
                            onClick={() => saveStaff(s.id)}
                            disabled={!dirty || isSaving}
                            className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {isSaving
                              ? <RefreshCw className="w-3 h-3 animate-spin" />
                              : <Save className="w-3 h-3" />
                            }
                            {isSaving ? 'Saving' : 'Save'}
                          </button>
                        )}
                        <button
                          onClick={() => setRevokeTarget(s)}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-900 hover:bg-red-950 border border-zinc-800 hover:border-red-800 rounded text-[10px] font-bold uppercase tracking-widest text-zinc-500 hover:text-red-400 transition-colors"
                          title="Revoke all access"
                        >
                          <UserX className="w-3 h-3" />
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredStaff.length === 0 && !loading && (
                <tr>
                  <td colSpan={events.length + 2} className="px-4 py-10 text-center text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                    No staff members found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-zinc-800">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-600">Role Legend</span>
        {ROLES.map(r => (
          <span key={r.value} className="flex items-center gap-1.5 text-[9px] font-mono">
            <span className={`font-bold uppercase tracking-widest ${r.color}`}>{r.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
