import React from 'react';
import { Outlet, NavLink, Link, useNavigate } from 'react-router-dom';

interface NavItem {
  label: string;
  to: string;
  isHash?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Platform',     to: '/enterprise' },
  { label: 'Scale',        to: '/enterprise#scale', isHash: true },
  { label: 'Trust Center', to: '/enterprise/trust-center' },
];

export default function EnterpriseLayout() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-white text-zinc-900 font-sans antialiased">

      {/* ── Sticky Navigation ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-zinc-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between gap-8">

          {/* Wordmark */}
          <Link to="/enterprise" className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 bg-zinc-900 rounded-md flex items-center justify-center">
              <span className="text-white text-[10px] font-black tracking-tighter">CE</span>
            </div>
            <span className="text-sm font-black tracking-tight uppercase text-zinc-900">
              Core Elite
            </span>
            <span className="px-1.5 py-0.5 bg-zinc-100 text-zinc-400 text-[9px] font-bold uppercase rounded tracking-widest leading-none">
              Enterprise
            </span>
          </Link>

          {/* Nav Links */}
          <nav className="hidden md:flex items-center gap-8">
            {NAV_ITEMS.map((item) =>
              item.isHash ? (
                // Hash anchors — scroll within CommissionerOverview
                <a
                  key={item.label}
                  href={item.to}
                  className="text-sm font-medium text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                  {item.label}
                </a>
              ) : (
                <NavLink
                  key={item.label}
                  to={item.to}
                  end={item.to === '/enterprise'}
                  className={({ isActive }) =>
                    `text-sm font-medium transition-colors ${
                      isActive ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-900'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              )
            )}
          </nav>

          {/* Sticky CTA */}
          <button
            onClick={() => navigate('/enterprise/trust-center')}
            aria-label="Request a Demo"
            className="shrink-0 px-4 py-2 bg-black text-white text-sm font-bold rounded-lg hover:bg-zinc-800 active:scale-95 transition-all"
          >
            Request Demo
          </button>

        </div>
      </header>

      {/* ── Page Content ──────────────────────────────────────────────── */}
      <main>
        <Outlet />
      </main>

      {/* ── Enterprise Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-zinc-100 mt-24">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 bg-zinc-900 rounded flex items-center justify-center">
              <span className="text-white text-[9px] font-black">CE</span>
            </div>
            <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">
              Core Elite Enterprise
            </span>
          </div>
          <div className="flex flex-wrap gap-6">
            <Link to="/enterprise/trust-center" className="text-xs text-zinc-400 hover:text-zinc-700 transition-colors">
              Trust Center
            </Link>
            <Link to="/staff/login" className="text-xs text-zinc-400 hover:text-zinc-700 transition-colors">
              Staff Login
            </Link>
            <Link to="/" className="text-xs text-zinc-400 hover:text-zinc-700 transition-colors">
              Athlete Portal
            </Link>
          </div>
          <p className="text-xs text-zinc-300">
            © {new Date().getFullYear()} Core Elite. All rights reserved.
          </p>
        </div>
      </footer>

    </div>
  );
}
