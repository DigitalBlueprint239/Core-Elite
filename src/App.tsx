/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <SyncIndicator />
        </div>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
