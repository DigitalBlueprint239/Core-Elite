/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { SyncIndicator } from './components/SyncIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RouteGuard } from './components/RouteGuard';
import { ThemeProvider } from './components/ThemeProvider';
import { SyncProvider } from './contexts/SyncProvider';
import { reportNav } from './lib/apm';

// APM route-timing beacon — mounts once inside <BrowserRouter> and fires a
// reportNav() on every pathname change. The first mount reports 0ms so the
// APM pipeline can distinguish initial loads (see LCP) from SPA transitions.
function RouteTiming() {
  const location = useLocation();
  const startRef = useRef<number>(performance.now());
  const pathRef  = useRef<string>(location.pathname);

  useEffect(() => {
    const now = performance.now();
    reportNav(pathRef.current, now - startRef.current);
    startRef.current = now;
    pathRef.current  = location.pathname;
  }, [location.pathname]);

  return null;
}

// Lazy load routes
const Home = lazy(() => import('./pages/Home'));
const Register = lazy(() => import('./pages/Register'));
const ClaimBand = lazy(() => import('./pages/ClaimBand'));
const StaffLogin = lazy(() => import('./pages/StaffLogin'));
const StationMode = lazy(() => import('./pages/StationMode'));
const StationSelection = lazy(() => import('./pages/StationSelection'));
const AdminLogin = lazy(() => import('./pages/AdminLogin'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const AdminOps = lazy(() => import('./pages/AdminOps'));
const AdminDiagnostics = lazy(() => import('./pages/AdminDiagnostics'));
const ParentPortal = lazy(() => import('./pages/ParentPortal'));
const CoachPortal = lazy(() => import('./pages/CoachPortal'));
const ForgotPassword   = lazy(() => import('./pages/ForgotPassword'));
const UpdatePassword   = lazy(() => import('./pages/UpdatePassword'));
const AuthCallback     = lazy(() => import('./pages/auth/AuthCallback'));
const Lookup = lazy(() => import('./pages/Lookup'));
const Pricing = lazy(() => import('./pages/Pricing'));
const NotFound = lazy(() => import('./pages/NotFound'));

// Scout View — high-density leaderboard + per-athlete deep-dive.
// Authenticated (RouteGuard, no requireAdmin — scouts are not admins).
const ScoutLeaderboard       = lazy(() => import('./pages/scout/Leaderboard'));
const ScoutAthleteDetail     = lazy(() => import('./pages/scout/AthleteDetail'));

// Enterprise portal — marketing/sales site (unauthenticated)
const EnterpriseLayout       = lazy(() => import('./layouts/EnterpriseLayout'));
const CommissionerOverview   = lazy(() => import('./pages/enterprise/CommissionerOverview'));
const TrustCenter            = lazy(() => import('./pages/enterprise/TrustCenter'));

// League Admin portal — operational command center (requires admin auth)
const LeagueAdminLayout      = lazy(() => import('./layouts/LeagueAdminLayout'));
const LeagueDashboard        = lazy(() => import('./pages/league-admin/LeagueDashboard'));
const EventHub               = lazy(() => import('./pages/league-admin/EventHub'));
const StaffAccessManagement  = lazy(() => import('./pages/league-admin/StaffAccessManagement'));
const ComplianceAuditViewer  = lazy(() => import('./pages/league-admin/ComplianceAuditViewer'));
const B2BExports             = lazy(() => import('./pages/league-admin/B2BExports'));
const LiveCommandCenter      = lazy(() => import('./pages/league-admin/LiveCommandCenter'));
const VendorImport           = lazy(() => import('./pages/league-admin/VendorImport'));

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <RouteTiming />
        <ThemeProvider>
        <SyncProvider>
        <div className="min-h-screen bg-zinc-50 font-sans text-zinc-900">
          <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen">
              <div className="animate-pulse text-zinc-400 font-medium">Loading Core Elite...</div>
            </div>
          }>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/register" element={<Register />} />
              <Route path="/p/:token" element={<ParentPortal />} />
              <Route path="/claim-band" element={<ClaimBand />} />
              <Route path="/staff/login" element={<StaffLogin />} />
              <Route path="/staff/select-station" element={
                <RouteGuard>
                  <StationSelection />
                </RouteGuard>
              } />
              <Route path="/staff/station/:stationId" element={
                <RouteGuard>
                  <StationMode />
                </RouteGuard>
              } />
              <Route path="/forgot-password"  element={<ForgotPassword />} />
              <Route path="/update-password" element={<UpdatePassword />} />
              {/* Central PKCE handler — must be whitelisted in Supabase Dashboard */}
              <Route path="/auth/callback"   element={<AuthCallback />} />
              <Route path="/admin/login" element={<AdminLogin />} />
              <Route path="/admin/dashboard" element={
                <RouteGuard requireAdmin>
                  <AdminDashboard />
                </RouteGuard>
              } />
              <Route path="/admin/ops" element={
                <RouteGuard requireAdmin>
                  <AdminOps />
                </RouteGuard>
              } />
              <Route path="/admin/diagnostics" element={
                <RouteGuard requireAdmin>
                  <AdminDiagnostics />
                </RouteGuard>
              } />
              <Route path="/coach/:eventId" element={
                <RouteGuard>
                  <CoachPortal />
                </RouteGuard>
              } />
              <Route path="/lookup" element={<Lookup />} />
              <Route path="/pricing" element={<Pricing />} />

              {/* ── Enterprise Portal (/enterprise/*) ─────────────────
                  Nested under EnterpriseLayout (Outlet). Completely
                  separate nav and shell from the athlete/staff app.
              ──────────────────────────────────────────────────────── */}
              <Route path="/enterprise" element={<EnterpriseLayout />}>
                <Route index element={<CommissionerOverview />} />
                <Route path="trust-center" element={<TrustCenter />} />
              </Route>

              {/* ── League Admin Portal (/league-admin/*) ──────────────
                  Operational command center. Fixed sidebar layout.
                  Requires admin authentication (requireAdmin).
              ──────────────────────────────────────────────────────── */}
              <Route path="/league-admin" element={
                <RouteGuard requireAdmin>
                  <LeagueAdminLayout />
                </RouteGuard>
              }>
                <Route index element={<LeagueDashboard />} />
                <Route path="events" element={<EventHub />} />
                <Route path="staff-access" element={<StaffAccessManagement />} />
                <Route path="compliance" element={<ComplianceAuditViewer />} />
                <Route path="exports" element={<B2BExports />} />
                <Route path="command-center" element={<LiveCommandCenter />} />
                <Route path="import"         element={<VendorImport />} />
              </Route>

              {/* ── Scout View (/scout/*) ──────────────────────────────
                  High-density leaderboard + per-athlete deep-dive.
                  Renders OUTSIDE LeagueAdminLayout — the scout pages
                  ship their own dark-mode shell. Wrapped in RouteGuard
                  (auth required, no requireAdmin — scouts are not
                  admins) so unauthenticated traffic can't see the
                  full athletic record.
              ──────────────────────────────────────────────────────── */}
              <Route path="/scout/leaderboard" element={
                <RouteGuard>
                  <ScoutLeaderboard />
                </RouteGuard>
              } />
              <Route path="/scout/athletes/:id" element={
                <RouteGuard>
                  <ScoutAthleteDetail />
                </RouteGuard>
              } />

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          <SyncIndicator />
        </div>
        </SyncProvider>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
