import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, CalendarDays, Users, ShieldCheck,
  Download, LogOut, Menu, X, ChevronRight,
  Zap, Radio, Upload, Trophy,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

// ─── Navigation definition ───────────────────────────────────────────────────

interface NavItem {
  label:    string;
  to:       string;
  icon:     React.ReactNode;
  badge?:   string | number;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Global Dashboard',          to: '/league-admin',                  icon: <LayoutDashboard className="w-4 h-4" /> },
  { label: 'Event Hub',                  to: '/league-admin/events',           icon: <CalendarDays className="w-4 h-4" /> },
  { label: 'Staff Identity & Access',    to: '/league-admin/staff-access',     icon: <Users className="w-4 h-4" /> },
  { label: 'Compliance & Audit',         to: '/league-admin/compliance',       icon: <ShieldCheck className="w-4 h-4" /> },
  { label: 'B2B Exports',                to: '/league-admin/exports',          icon: <Download className="w-4 h-4" /> },
  { label: 'Command Center',             to: '/league-admin/command-center',   icon: <Radio    className="w-4 h-4" /> },
  { label: 'Vendor Import',              to: '/league-admin/import',           icon: <Upload   className="w-4 h-4" /> },
  // Scout View (/scout/*) — renders outside this layout's shell. The
  // sidebar entry is the single navigation surface that surfaces it.
  { label: 'Scout Board',                to: '/scout/leaderboard',             icon: <Trophy   className="w-4 h-4" /> },
];

// ─── Sidebar link component ───────────────────────────────────────────────────

function SidebarLink({ item, onClick }: { item: NavItem; onClick?: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/league-admin'}
      onClick={onClick}
      className={({ isActive }) =>
        `group flex items-center gap-3 px-3 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all ${
          isActive
            ? 'bg-zinc-800 text-white'
            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60'
        }`
      }
    >
      <span className="shrink-0 opacity-75 group-[.active]:opacity-100">{item.icon}</span>
      <span className="leading-tight">{item.label}</span>
      {item.badge !== undefined && (
        <span className="ml-auto font-mono text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">
          {item.badge}
        </span>
      )}
    </NavLink>
  );
}

// ─── Main layout ─────────────────────────────────────────────────────────────

export default function LeagueAdminLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Derive active page label for mobile header breadcrumb
  const activeItem = NAV_ITEMS.find(n =>
    n.to === '/league-admin'
      ? location.pathname === '/league-admin'
      : location.pathname.startsWith(n.to)
  );

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/admin/login');
  }

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Wordmark */}
      <div className="px-4 py-5 border-b border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-white rounded flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-zinc-900" />
          </div>
          <div>
            <p className="text-white text-xs font-black tracking-tight uppercase leading-none">Core Elite</p>
            <p className="text-zinc-500 text-[9px] font-bold uppercase tracking-widest leading-none mt-0.5">League Admin</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="px-3 pb-2 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">Navigation</p>
        {NAV_ITEMS.map(item => (
          <SidebarLink key={item.to} item={item} onClick={() => setMobileOpen(false)} />
        ))}
      </nav>

      {/* Session footer */}
      <div className="px-3 py-4 border-t border-zinc-800 space-y-1">
        <div className="px-3 py-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-600 mb-0.5">Signed in as</p>
          <p className="text-zinc-300 text-xs font-bold truncate">League Commissioner</p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-[10px] text-zinc-500 font-mono">LIVE SESSION</span>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2 rounded text-xs font-bold uppercase tracking-widest text-zinc-500 hover:text-red-400 hover:bg-zinc-800/60 transition-all"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-zinc-950 font-sans text-zinc-100">

      {/* ── Fixed desktop sidebar ─────────────────────────────────────── */}
      <aside className="hidden lg:flex lg:flex-col fixed inset-y-0 left-0 w-56 bg-zinc-950 border-r border-zinc-800 z-30">
        {sidebarContent}
      </aside>

      {/* ── Mobile sidebar overlay ────────────────────────────────────── */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative flex flex-col w-56 bg-zinc-950 border-r border-zinc-800 z-10">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* ── Main content area ─────────────────────────────────────────── */}
      <div className="flex-1 lg:ml-56 flex flex-col min-h-screen">

        {/* Mobile top bar */}
        <header className="lg:hidden sticky top-0 z-20 bg-zinc-900 border-b border-zinc-800 px-4 h-12 flex items-center justify-between gap-4">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-1.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <Menu className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-zinc-300">
            {activeItem?.icon}
            {activeItem?.label ?? 'League Admin'}
          </div>
          <div className="w-7" /> {/* balance */}
        </header>

        {/* Desktop top bar — breadcrumb + live indicator */}
        <header className="hidden lg:flex sticky top-0 z-20 bg-zinc-950/95 backdrop-blur-sm border-b border-zinc-800 px-6 h-12 items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            <span>Core Elite</span>
            <ChevronRight className="w-3 h-3" />
            <span className="text-zinc-300">{activeItem?.label ?? 'League Admin'}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Live Data</span>
            </div>
            <div className="text-[10px] font-mono text-zinc-600 tabular-nums">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} LOCAL
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
