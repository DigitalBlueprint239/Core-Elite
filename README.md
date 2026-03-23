# Core Elite Combine 2026

A production-ready web application for athletic combine events.

## How to Run

1. **Supabase Setup**:
   - Create a new Supabase project.
   - Run the contents of `supabase_schema.sql` in the Supabase SQL Editor.
   - Enable Email Auth (or add staff users manually in the Auth table).
   - Add your `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to your environment variables.

2. **Development**:
   - `npm install`
   - `npm run dev`

3. **Production Build**:
   - `npm run build`

## Launch Readiness Runbook

- See `docs/launch-readiness.md` for deployment order, SQL verification queries, and the full end-to-end smoke test checklist.

## Event Day Checklist

### 1. Pre-Event Setup
- [ ] Ensure all staff have their login credentials.
- [ ] Print Registration QR posters and place them at the entrance.
- [ ] Prepare pre-printed wristbands (001-500) with unique QR codes.
- [ ] Pre-populate the `bands` table with the unique QR IDs and display numbers.
- [ ] Configure `stations` table with station IDs (e.g., SPEED-1, VERT-1) and drill types.

### 2. Check-in Desk
- [ ] Staff should have iPads/Tablets with the app loaded.
- [ ] Verify athletes scan the Registration QR, complete the form, and sign the waiver.
- [ ] Staff scans the wristband QR to link it to the athlete after registration.

### 3. Testing Stations
- [ ] Coaches login to `/staff/login`.
- [ ] Select/Enter the station ID.
- [ ] Scan athlete wristband before each drill.
- [ ] Enter results and submit.
- [ ] Monitor the "Pending Sync" indicator if Wi-Fi is unstable.

### 4. Admin Monitoring
- [ ] Monitor the Admin Dashboard for live registration counts and station health.
- [ ] Check for high latency or large pending queues at stations.
- [ ] Export results to CSV at the end of the event for final reporting.

## Tech Stack Details
- **Frontend**: React, TypeScript, Tailwind CSS, Motion.
- **Backend**: Supabase (Postgres, Auth, RLS).
- **Offline**: IndexedDB (idb) for outbox queue and athlete caching.
- **Scanning**: html5-qrcode for browser-based QR detection.
- **Signature**: signature_pad for waiver consent.
