/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SyncIndicator } from './components/SyncIndicator';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RouteGuard } from './components/RouteGuard';
import { ThemeProvider } from './components/ThemeProvider';

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
        <ThemeProvider>
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

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          <SyncIndicator />
        </div>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
