# Core Elite Combine App — 5-Phase Execution Prompts
## 2/10 → 11/10 Battle Plan — Ready for Autonomous Agent Deployment

---

## PHASE 1: GO LIVE BLOCKERS

```
You are a Principal Full-Stack Engineer executing Phase 1 of a 5-phase production hardening sprint on the Core Elite Combine 2026 app. This is a React/TypeScript/Supabase web app deployed on Vercel for managing athletic combine events (registration, wristband assignment, drill result capture, admin monitoring).

THE STANDARD: This app will be used at live events with 100+ athletes, parents on their phones, coaches on iPads, and admins running a command center. Every fix must be bulletproof. No half-measures. No "TODO" comments. No placeholder logic.

PHASE 1 OBJECTIVE: Resolve the 7 critical blockers preventing the app from running a live event.

CODEBASE CONTEXT:
- Frontend: React 18+, TypeScript, Tailwind CSS, Motion (framer-motion), Lucide icons
- Backend: Supabase (Postgres + Auth + RLS)
- Offline: IndexedDB via `idb` library (src/lib/offline.ts)
- Routing: react-router-dom v7 with lazy-loaded pages (src/App.tsx)
- Deployment: Vercel
- Key files you will modify:
  - index.html (root HTML)
  - vercel.json (CREATE — does not exist yet)
  - src/constants.ts (DRILL_CATALOG with recommended_range already defined)
  - src/pages/StationMode.tsx (station queue + result submission)
  - src/pages/AdminDashboard.tsx (CSV export + search pagination)
  - src/lib/offline.ts (IndexedDB stores: outbox, athlete_cache, station_config)
  - hardening_migration.sql (Supabase RPC: register_athlete_secure)

EXECUTE THESE 7 COMMITS IN ORDER:

COMMIT 1: Vercel SPA Routing
- CREATE file `vercel.json` in project root with this exact content:
  {
    "rewrites": [{ "source": "/(.*)", "destination": "/" }]
  }
- This fixes 404 errors on direct navigation to /admin/login, /staff/login, /p/:token, and all other client-side routes.
- VERIFY: Confirm that src/App.tsx already has a catch-all route `<Route path="*" element={<Navigate to="/" replace />} />` — it does.

COMMIT 2: HTML Metadata & Branding
- In `index.html`, replace `<title>My Google AI Studio App</title>` with:
  <title>Core Elite Combine 2026</title>
- Add these meta tags inside <head>:
  <meta name="description" content="Elite athletic combine testing — registration, performance data capture, and real-time results." />
  <meta name="theme-color" content="#18181b" />
  <meta property="og:title" content="Core Elite Combine 2026" />
  <meta property="og:description" content="Precision data. Real-time results. Elite performance tracking." />
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏈</text></svg>" />
- Remove any references to "Google AI Studio" or "Gemini" anywhere in the codebase. Check .env.example for GEMINI_API_KEY references and remove or comment them.

COMMIT 3: Duplicate Registration Prevention
- Modify the `register_athlete_secure` RPC in `hardening_migration.sql`. BEFORE the INSERT INTO athletes statement, add this duplicate check:
  IF EXISTS (
    SELECT 1 FROM athletes 
    WHERE event_id = p_event_id 
      AND lower(trim(first_name)) = lower(trim(p_first_name)) 
      AND lower(trim(last_name)) = lower(trim(p_last_name)) 
      AND date_of_birth = p_date_of_birth
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'An athlete with this name and date of birth is already registered for this event.');
  END IF;
- This goes AFTER the event validation check and BEFORE the INSERT.

COMMIT 4: Result Validation Bounds in Station Mode
- In `src/pages/StationMode.tsx`, locate the `handleLaneSubmit` function (for lane mode) and the single-entry submit handler.
- BEFORE calling `addToOutbox`, add validation using the existing DRILL_CATALOG from src/constants.ts:
  import { DRILL_CATALOG } from '../constants';
  
  // Inside the submit handler, after parseFloat(item.result):
  const drill = DRILL_CATALOG.find(d => d.id === station.drill_type);
  const value = parseFloat(item.result);
  if (drill?.recommended_range) {
    if (value < drill.recommended_range.min || value > drill.recommended_range.max) {
      // Do NOT block submission — flag it and ask for confirmation
      const confirmed = window.confirm(
        `⚠️ ${value} ${drill.unit} is outside the expected range (${drill.recommended_range.min}–${drill.recommended_range.max} ${drill.unit}) for ${drill.label}.\n\nSubmit anyway?`
      );
      if (!confirmed) return;
      // Add flag to payload meta
      payload.meta = { ...payload.meta, logic_check_flag: 'EXTRAORDINARY' };
    }
  }
- Apply this validation to BOTH the lane-mode submit (handleLaneSubmit) and the single-entry submit. The station.drill_type matches DRILL_CATALOG[].id (e.g., 'forty', 'vertical', 'shuttle_5_10_5').

COMMIT 5: Station Queue Persistence to IndexedDB
- In `src/lib/offline.ts`, the `station_config` object store already exists (created in initDB). Use it to persist the queue.
- Create two new helper functions in offline.ts:
  export async function saveStationQueue(stationId: string, queue: any[]) {
    const db = await initDB();
    await db.put('station_config', { id: `queue_${stationId}`, data: queue });
  }
  
  export async function loadStationQueue(stationId: string): Promise<any[]> {
    const db = await initDB();
    const record = await db.get('station_config', `queue_${stationId}`);
    return record?.data || [];
  }

- In `src/pages/StationMode.tsx`:
  - Import saveStationQueue and loadStationQueue
  - Add a useEffect that loads the queue on mount:
    useEffect(() => {
      if (stationId) {
        loadStationQueue(stationId).then(saved => {
          if (saved.length > 0) setQueue(saved);
        });
      }
    }, [stationId]);
  - Add a useEffect that saves the queue whenever it changes:
    useEffect(() => {
      if (stationId && queue.length >= 0) {
        saveStationQueue(stationId, queue);
      }
    }, [queue, stationId]);

COMMIT 6: CSV Export Fix
- In `src/pages/AdminDashboard.tsx`, locate the `exportCSV` function (the inline one that builds CSV from athletes array, NOT the handleExport RPC one).
- Replace the CSV row building logic. Change:
  const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
  With:
  const escapeCSV = (val: any) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent = [headers, ...rows].map(e => e.map(escapeCSV).join(",")).join("\n");

COMMIT 7: Pagination Reset on Search
- In `src/pages/AdminDashboard.tsx`, locate the search input's onChange handler:
  onChange={(e) => setSearchTerm(e.target.value)}
- Change it to:
  onChange={(e) => { setSearchTerm(e.target.value); setPage(0); }}

VALIDATION CHECKLIST — Do not proceed to Phase 2 until ALL pass:
[ ] vercel.json exists and contains the rewrite rule
[ ] Browser tab shows "Core Elite Combine 2026" — no Google AI Studio reference anywhere
[ ] Navigating directly to /admin/login in a browser does NOT produce a 404
[ ] hardening_migration.sql contains the duplicate athlete check before INSERT
[ ] StationMode validates result values against DRILL_CATALOG.recommended_range before submission
[ ] StationMode queue persists across page refresh via IndexedDB station_config store
[ ] CSV export correctly handles names containing commas and quotes
[ ] Typing in the admin dashboard search resets pagination to page 0
[ ] All TypeScript compiles without errors: npx tsc --noEmit
[ ] Build succeeds: npm run build
```

---

## PHASE 2: EVENT DAY RELIABILITY

```
You are a Principal Full-Stack Engineer executing Phase 2 of a 5-phase production hardening sprint on the Core Elite Combine 2026 app. Phase 1 (Go Live Blockers) has been completed. The app now has: proper Vercel routing, fixed metadata, duplicate registration prevention, result validation, queue persistence, CSV escaping, and pagination fixes.

THE STANDARD: This phase makes the app reliable enough that a combine event can run for 4+ hours without operational failures. Every feature must handle edge cases: Wi-Fi drops, session expiry, accidental data entry, and staff who aren't tech-savvy.

PHASE 2 OBJECTIVE: Implement 8 event-day reliability features.

CODEBASE CONTEXT (in addition to Phase 1):
- Auth: Supabase Auth with email/password. Staff role checked via `profiles` table (role = 'staff' | 'admin').
- Route protection: src/components/RouteGuard.tsx checks supabase.auth.getSession()
- Offline sync: src/hooks/useOfflineSync.ts — polls every 30s, exponential backoff, dead-letter after 5 retries
- Admin dashboard: src/pages/AdminDashboard.tsx — useEffect with setInterval(fetchData, 30000)
- Station mode: src/pages/StationMode.tsx — queue state, QR scanning, result submission via addToOutbox
- Staff login: src/pages/StaffLogin.tsx
- Supabase RPCs: register_athlete_secure, claim_band_atomic, submit_result_secure (all SECURITY DEFINER in hardening_migration.sql)
- Parent portal: src/pages/ParentPortal.tsx — fetches athlete data via portal_token from parent_portals table
- Constants: src/constants.ts — DRILL_CATALOG with id, label, unit, recommended_range, attempts_allowed

EXECUTE THESE 8 COMMITS IN ORDER:

COMMIT 1: Forgot Password for Staff
- In `src/pages/StaffLogin.tsx`, add a "Forgot Password?" link below the login button.
- When clicked, show an inline form: email input + "Send Reset Link" button.
- On submit, call: `await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/staff/login' })`
- Show success message: "If an account exists for that email, a reset link has been sent."
- Show error state if the call fails.
- Style consistently with the existing page (zinc/white theme, rounded-2xl inputs, font-bold uppercase labels).

COMMIT 2: Session Expiry Handling with Context Preservation
- In `src/components/RouteGuard.tsx`, add a `supabase.auth.onAuthStateChange` listener.
- On `TOKEN_REFRESHED` failure or `SIGNED_OUT` event:
  - Save current path + stationId to sessionStorage: `sessionStorage.setItem('ce_return_path', window.location.pathname)`
  - Show a toast/banner: "Session expired. Please log in again." (use a simple fixed-position div, not a library)
  - Redirect to the appropriate login page (/staff/login or /admin/login based on the current path)
- On successful re-login:
  - Check sessionStorage for `ce_return_path`, navigate there, then clear it.
- In `src/pages/StaffLogin.tsx` and `src/pages/AdminLogin.tsx`, after successful login, check for the saved return path and redirect.

COMMIT 3: Supabase Realtime for Admin Dashboard
- In `src/pages/AdminDashboard.tsx`, replace the `setInterval(fetchData, 30000)` polling pattern with Supabase Realtime subscriptions.
- Keep the initial fetchData() call on mount.
- Add three channel subscriptions:
  const channel = supabase.channel('admin-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'athletes' }, () => fetchData())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'results' }, () => fetchData())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' }, () => fetchData())
    .subscribe();
- Debounce the fetchData calls: use a ref-based debounce (300ms) so rapid inserts don't trigger 50 fetches.
- Clean up the subscription in the useEffect return: `supabase.removeChannel(channel)`
- Remove the setInterval entirely.
- NOTE: Supabase Realtime requires the tables to have Realtime enabled in the Supabase dashboard. Add a comment noting this requirement.

COMMIT 4: Station Offline Alerts on Admin Dashboard
- In the station health section of `src/pages/AdminDashboard.tsx`, add an alert banner.
- The station health cards already compute `isOffline` and `isSyncStale` booleans.
- Above the stations grid, add a conditional alert:
  {stations.some(s => { const status = s.status; if (!status) return false; return (Date.now() - new Date(status.last_seen_at).getTime()) > 120000; }) && (
    <div className="p-4 bg-red-50 border border-red-200 rounded-2xl flex items-center gap-3 text-red-700 mb-4">
      <AlertTriangle className="w-5 h-5 shrink-0" />
      <span className="text-sm font-bold">One or more stations have been offline for over 2 minutes. Check device connectivity.</span>
    </div>
  )}

COMMIT 5: Multi-Attempt Tracking in Station Mode
- In `src/pages/StationMode.tsx`, when an athlete is scanned (handleScan), query for their existing results at this station:
  const { data: existingResults } = await supabase
    .from('results')
    .select('value_num, drill_type')
    .eq('athlete_id', athleteData.athlete_id)
    .eq('station_id', stationId)
    .order('recorded_at', { ascending: true });
- Store the attempt count and previous results in the queue item:
  { ...athleteData, attemptNumber: (existingResults?.length || 0) + 1, previousResults: existingResults || [] }
- In the queue item UI, display:
  - "Attempt {attemptNumber} of {drill.attempts_allowed}" (from DRILL_CATALOG)
  - Previous result values if they exist: "Previous: {prev.value_num} {drill.unit}"
- Use DRILL_CATALOG.find(d => d.id === station.drill_type) to get attempts_allowed.

COMMIT 6: Result Correction Flow (Void Last Submission)
- In `src/pages/StationMode.tsx`, expand the `lastSubmitted` display.
- Instead of just showing a green confirmation bar, make it a card with a "Void" button:
  {lastSubmitted && (
    <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center justify-between">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
        <div className="text-sm">
          <span className="font-bold text-emerald-800">Saved:</span> {lastSubmitted.athleteName} — {lastSubmitted.value}
        </div>
      </div>
      <button onClick={() => handleVoid(lastSubmitted.resultId)} className="px-3 py-1 bg-red-100 text-red-700 rounded-lg text-xs font-bold hover:bg-red-200">
        Void
      </button>
    </div>
  )}
- The handleVoid function:
  async function handleVoid(clientResultId: string) {
    if (!window.confirm('Void this result? This cannot be undone.')) return;
    // Mark as voided in Supabase
    await supabase.from('results').update({ voided: true }).eq('client_result_id', clientResultId);
    setLastSubmitted(null);
  }
- NOTE: Add `voided BOOLEAN DEFAULT false` column to the results table in a new migration file if it doesn't exist. Add this SQL to a new file `migrations/005_add_voided_column.sql`:
  ALTER TABLE results ADD COLUMN IF NOT EXISTS voided BOOLEAN DEFAULT false;

COMMIT 7: Band Generation Idempotency
- In `src/pages/admin-ops/BandsTab.tsx`, locate the `generateBands` function.
- BEFORE inserting bands, check for existing bands in the range:
  const { count } = await supabase
    .from('bands')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .gte('display_number', range.start)
    .lte('display_number', range.end);
  if (count && count > 0) {
    if (!window.confirm(`${count} bands already exist in range ${range.start}–${range.end}. Generate missing ones only?`)) return;
  }
- When generating, use ON CONFLICT DO NOTHING (via upsert) or filter out existing numbers.

COMMIT 8: Registration Recovery Lookup
- CREATE new file `src/pages/LookupRegistration.tsx`:
  - Simple page: email input + "Look Up" button
  - On submit, query: `supabase.from('athletes').select('first_name, last_name, id, event_id').eq('parent_email', email)`
  - If found, call `supabase.from('token_claims').select('token_hash').eq('athlete_id', athlete.id).is('used_at', null)` 
  - Display the claim link and parent portal link
  - If token is expired/used, show "Contact event staff for assistance"
- Add route in `src/App.tsx`: `<Route path="/lookup" element={<LookupRegistration />} />`
- Add a small link on the Home page below the registration card: "Already registered? Look up your info"

VALIDATION CHECKLIST — Do not proceed to Phase 3 until ALL pass:
[ ] Staff login page shows "Forgot Password?" link that triggers Supabase password reset email
[ ] After session expiry, staff are redirected to login with a clear message and returned to their station after re-auth
[ ] Admin dashboard updates in real-time when a new athlete registers or result is submitted (no 30s delay)
[ ] A red banner appears on admin dashboard when any station's last_seen_at exceeds 2 minutes
[ ] Station mode shows "Attempt 2 of 2" with previous result when scanning an athlete who already has a result
[ ] "Void" button appears next to last submitted result and marks it voided in the database
[ ] Band generation warns about existing bands in the range before inserting
[ ] /lookup route exists and returns registration info by parent email
[ ] All TypeScript compiles without errors: npx tsc --noEmit
[ ] Build succeeds: npm run build
```

---

## PHASE 3: UX & BRAND ELEVATION

```
You are a Principal Front-End Engineer and Brand Designer executing Phase 3 of a 5-phase production hardening sprint on the Core Elite Combine 2026 app. Phases 1–2 are complete. The app is now functionally reliable. Phase 3 transforms it from "works correctly" to "looks and feels like a premium sports-tech product."

THE STANDARD: This app represents the Core Elite brand to parents paying $75–150 per athlete. It must look like it belongs in the same visual category as Hudl, NCSA, or TrackMan — not like a hackathon project. Every screen must be mobile-first (80%+ of users are on phones at the event).

PHASE 3 OBJECTIVE: Brand identity, UX polish, missing features, and copy overhaul across 10 commits.

CODEBASE CONTEXT (in addition to Phases 1–2):
- Styling: Tailwind CSS with Inter font (loaded in src/index.css via Google Fonts)
- Animations: Motion (motion/react) — already used for hover effects and page transitions
- Icons: Lucide React
- Current palette: zinc-50 background, zinc-900 text, white cards, emerald for success, red for errors
- Home page: src/pages/Home.tsx — 3 cards (Athlete, Staff, Admin)
- Registration: src/pages/Register.tsx — 2-step form (profile → waiver/signature)
- Parent portal: src/pages/ParentPortal.tsx — dark header, results list, report download
- Positions dropdown: hardcoded in Register.tsx as <option> elements
- Signature: src/components/SignatureCanvas.tsx (uses signature_pad library)

EXECUTE THESE 10 COMMITS IN ORDER:

COMMIT 1: Core Elite Brand System
- Create `src/lib/brand.ts` with brand constants:
  export const BRAND = {
    name: 'Core Elite',
    tagline: 'Prove Your Elite',
    colors: {
      primary: '#18181b',      // zinc-900
      accent: '#c8a200',       // gold
      accentLight: '#fef3c7',  // amber-50
      success: '#059669',      // emerald-600
      danger: '#dc2626',       // red-600
    },
    logo: '/core-elite-logo.svg',
  };
- Create a simple SVG logo mark: bold geometric "CE" monogram in a shield shape. Save as `public/core-elite-logo.svg`. Make it work at 32x32 (favicon) and 200x200 (header). Use only black and gold (#c8a200).
- Update `index.html` favicon to reference this SVG:
  <link rel="icon" type="image/svg+xml" href="/core-elite-logo.svg" />

COMMIT 2: Homepage Redesign
- In `src/pages/Home.tsx`, replace the current plain layout with:
  - Hero section: Full-width dark background (zinc-900), Core Elite logo (64px), event name as H1 ("CORE ELITE COMBINE 2026" in font-black uppercase italic tracking-tighter), tagline below ("Where Data Meets Performance"), event date/location in a subtle zinc-400 line
  - Action cards: Keep the 3-card grid but add the gold accent. The Athlete card should have a gold left border. The Admin card stays dark but with gold accent text.
  - Copy changes:
    - "Athlete Registration" → card description becomes "Lock in your spot. Show what you're made of."
    - "Staff Station" → "Log in. Record results. Keep the event moving."
    - "Admin Dashboard" → "Live command center. Full visibility. Total control."
  - Add the lookup link below registration card: `<Link to="/lookup" className="text-xs text-zinc-400 hover:text-zinc-900 font-bold">Already registered? Find your info →</Link>`
  - Footer: Keep © 2026 but add the logo mark inline

COMMIT 3: Missing Positions in Registration
- In `src/pages/Register.tsx`, replace the position <select> options with this complete list:
  QB (Quarterback), RB (Running Back), FB (Fullback), WR (Wide Receiver), TE (Tight End), OL (Offensive Line), EDGE (Edge Rusher), DL (Defensive Line), LB (Linebacker), CB (Cornerback), S (Safety), DB (Defensive Back), K (Kicker), P (Punter), LS (Long Snapper), ATH (Athlete)
- Sort alphabetically by label in the dropdown.
- "ATH" should be the first option after "Select Position" for athletes who play multiple positions.

COMMIT 4: DOB Age Validation
- In `src/pages/Register.tsx`, after the user enters date_of_birth, validate age:
  const dob = new Date(formData.date_of_birth);
  const today = new Date();
  const age = today.getFullYear() - dob.getFullYear();
  if (age < 10 || age > 19) {
    setDateOfBirthError('Athletes must be between 10 and 19 years old to participate.');
    return;
  }
- Apply this check in the "Continue to Waiver" button's onClick handler, alongside the existing required field checks.
- Also add this validation to the Zod schema in src/lib/types.ts:
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format').refine((val) => {
    const age = new Date().getFullYear() - new Date(val).getFullYear();
    return age >= 10 && age <= 19;
  }, 'Athlete must be between 10 and 19 years old'),

COMMIT 5: Signature Pad UX Improvement
- In `src/components/SignatureCanvas.tsx`:
  - Set canvas minimum height to 160px on mobile (currently may be smaller)
  - Add a visible border with a subtle label: "Sign here" in zinc-300 text, centered, that disappears on first stroke
  - Replace "Signature too short" error with: "Please provide a recognizable signature"
  - Add a clear visual indicator: "✓ Signature captured" in emerald when a valid signature exists
  - Make the "Clear" button more prominent: red-100 bg with red-600 text

COMMIT 6: Waiver Text Enhancement
- In `src/pages/Register.tsx`, replace the 3-sentence waiver with a proper structured version:
  - Section 1: "Assumption of Risk" — acknowledge inherent risks of athletic testing
  - Section 2: "Release of Liability" — release Core Elite, staff, venue from claims
  - Section 3: "Medical Authorization" — authorize staff to seek emergency medical attention
  - Section 4: "Media Release" — consent to photos/videos for promotional use (separate checkbox, already exists)
  - Section 5: "Data Collection Consent" — consent to performance data collection and processing (separate checkbox, already exists)
- Keep the scrollable container (max-h-96) but add section headers in bold
- Add a "Read Summary" toggle that shows a 2-sentence summary by default, with "Read Full Waiver" expanding the full text

COMMIT 7: Skeleton Loading Screens
- Create `src/components/Skeleton.tsx` with reusable skeleton components:
  export function SkeletonCard() — mimics a stat card (rounded-3xl, shimmer animation)
  export function SkeletonTable() — mimics a table with 5 rows
  export function SkeletonHeader() — mimics a page header
- Apply to:
  - AdminDashboard: Replace "Loading Core Elite..." with 4 SkeletonCards + SkeletonTable
  - ParentPortal: Replace loading state with SkeletonHeader + skeleton result cards
  - StationMode: Replace loading state with skeleton station header + empty queue
- Shimmer animation: Use Tailwind's animate-pulse on bg-zinc-200 elements

COMMIT 8: Parent Portal Report Download Fix
- In `src/pages/ParentPortal.tsx`, locate the download button rendered when `data.report?.status === 'ready'`.
- The button currently has NO onClick handler. Fix it:
  <button 
    onClick={() => {
      if (data.report?.report_url) {
        window.open(data.report.report_url, '_blank');
      } else {
        alert('Report URL not available yet. Please try again shortly.');
      }
    }}
    className="p-3 bg-zinc-900 text-white rounded-xl shadow-lg hover:bg-zinc-800 transition-colors"
  >
    <Download className="w-5 h-5" />
  </button>

COMMIT 9: Social Sharing on Parent Portal
- In `src/pages/ParentPortal.tsx`, after the results list section, add a "Share Your Results" card:
  - "Share to X" button: opens `https://twitter.com/intent/tweet?text=...` with pre-filled text:
    "Just completed the ${data.event.name}! 💪🏈 #CoreElite #CombineReady"
  - "Copy Link" button: copies the current portal URL to clipboard with a "Copied!" confirmation
  - Style: white card with zinc border, share icons from Lucide (Share2, Copy, ExternalLink)

COMMIT 10: Registration Success Enhancement
- In `src/pages/Register.tsx`, after successful registration (navigate to /claim-band), OR in `src/pages/ClaimBand.tsx` after successful band claim:
  - Show the athlete's ID number prominently (display_number from the band)
  - Show parent portal link: `/p/${portalToken}`
  - Show event-day instructions: "Your number is #{display_number}. Present your wristband at each testing station. Results will appear in your Parent Portal within minutes."
  - Add the social share buttons here too (same pattern as Commit 9)

VALIDATION CHECKLIST — Do not proceed to Phase 4 until ALL pass:
[ ] Core Elite logo SVG renders correctly as favicon and in the homepage header
[ ] Homepage has dark hero section with gold accent, updated copy, and lookup link
[ ] Position dropdown includes all 16 positions (ATH first after default)
[ ] DOB validation rejects ages outside 10–19 range with clear error message
[ ] Signature pad is at least 160px tall on mobile with "Sign here" placeholder text
[ ] Waiver has 5 named sections with a summary/expand toggle
[ ] All loading states use skeleton shimmer screens instead of text spinners
[ ] Parent portal download button opens report_url in new tab
[ ] Social sharing buttons exist on parent portal and post-registration
[ ] Claim band success screen shows athlete number, portal link, and event-day instructions
[ ] All TypeScript compiles: npx tsc --noEmit
[ ] Build succeeds: npm run build
[ ] Visual spot-check on mobile viewport (375px width) — no overflow, no cut-off text
```

---

## PHASE 4: SECURITY HARDENING

```
You are a Principal Security Engineer executing Phase 4 of a 5-phase production hardening sprint on the Core Elite Combine 2026 app. Phases 1–3 are complete. The app is functional, reliable, and polished. Phase 4 locks it down against abuse, data exposure, and unauthorized access.

THE STANDARD: This app stores PII for minors (names, DOB, parent contact info, digital signatures). It must meet the security expectations of school districts and youth sports leagues. Any data breach would be catastrophic for the brand. Every RLS policy must follow least-privilege. Every public endpoint must be rate-limited or abuse-resistant.

PHASE 4 OBJECTIVE: Close all security gaps identified in the audit across 4 commits.

CODEBASE CONTEXT:
- Supabase schema: supabase_schema.sql (base), hardening_migration.sql (RPCs + tightened RLS)
- Migration files: migrations/002_create_events_and_core_tables.sql, migrations/004_parent_portal_and_reports.sql
- Base RLS PROBLEMS (from supabase_schema.sql — these are the INSECURE defaults):
  - "Public Update Athlete via ID" ON athletes FOR UPDATE USING (true) — anyone can update any athlete
  - "Public Token Claims" ON token_claims FOR ALL USING (true) — anyone can read/write/delete any token
  - "Public Update Band Claim" ON bands FOR UPDATE USING (true) — anyone can update any band
- SECURE RPCs (from hardening_migration.sql) that bypass RLS via SECURITY DEFINER:
  - register_athlete_secure — handles athlete + waiver + token_claim creation atomically
  - claim_band_atomic — handles band claim with FOR UPDATE locking
  - submit_result_secure — handles result insertion with idempotency check
- Auth: Supabase Auth with profiles table (id UUID PK references auth.users, role TEXT 'staff'|'admin')
- Admin diagnostics: src/pages/AdminDiagnostics.tsx — checks table existence but not column/policy validation

EXECUTE THESE 4 COMMITS IN ORDER:

COMMIT 1: Apply the Hardening Migration (RLS Lockdown)
- Create a new migration file: `migrations/006_security_hardening.sql`
- This file must be the DEFINITIVE security lockdown. Include ALL of the following:

  -- 1. DROP the dangerously permissive base policies
  DROP POLICY IF EXISTS "Public Insert Athletes" ON athletes;
  DROP POLICY IF EXISTS "Public Update Athlete via ID" ON athletes;
  DROP POLICY IF EXISTS "Public Update Band Claim" ON bands;
  DROP POLICY IF EXISTS "Public Token Claims" ON token_claims;
  DROP POLICY IF EXISTS "Public Insert Waivers" ON waivers;
  
  -- 2. Athletes: Public can only READ their own record (via band_id or parent_email lookup). All mutations go through RPCs.
  CREATE POLICY "Public Read Own Athlete" ON athletes FOR SELECT USING (true);
  -- Note: SELECT remains public because the parent portal and lookup page need it.
  -- All INSERT/UPDATE operations are handled by SECURITY DEFINER RPCs (register_athlete_secure, claim_band_atomic).
  
  -- 3. Token Claims: No public access. RPCs handle all operations.
  -- (No new public policy — RPCs bypass RLS with SECURITY DEFINER)
  
  -- 4. Bands: Public can only READ. Claims go through claim_band_atomic RPC.
  DROP POLICY IF EXISTS "Public Read Band" ON bands;
  CREATE POLICY "Public Read Band" ON bands FOR SELECT USING (true);
  -- All UPDATE operations handled by claim_band_atomic RPC.
  
  -- 5. Waivers: No public direct insert. Handled by register_athlete_secure RPC.
  -- (No new public policy)
  
  -- 6. Results: Only authenticated staff can read. Public has no access.
  -- (Existing "Staff Insert Results" and "Staff Read Results" policies are correct)
  
  -- 7. Parent Portals: Public read remains (token-based access)
  -- (Existing policy from migrations/004 is correct)

- Add a comment block at the top explaining the security model:
  -- SECURITY MODEL: All public-facing mutations go through SECURITY DEFINER RPCs.
  -- Direct table mutations from unauthenticated clients are blocked by RLS.
  -- Authenticated staff/admin mutations use role-based policies.
  -- Read access is open for athletes/bands (needed for public-facing pages) but restricted for results/waivers.

COMMIT 2: Rate Limiting on Registration RPC
- Modify the `register_athlete_secure` RPC in the migration file.
- Add a rate limit check at the top of the function, AFTER event validation and BEFORE duplicate check:
  -- Rate limit: max 5 registrations per email per hour
  IF (
    SELECT count(*) FROM athletes 
    WHERE parent_email = lower(trim(p_parent_email)) 
      AND created_at > now() - interval '1 hour'
  ) >= 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Too many registration attempts. Please try again later.');
  END IF;
- Also add a rate limit to claim_band_atomic:
  -- Rate limit: max 10 claim attempts per token per hour (prevents brute force)
  -- (The token is already single-use, but this prevents enumeration)
  -- Actually, since tokens are 32-char hex (128-bit entropy), enumeration is infeasible.
  -- Instead, add: token expiration check is already in place (expires_at < now() check).
  -- Verify this check exists in claim_band_atomic. If not, add:
  IF v_claim_row.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Token expired');
  END IF;

COMMIT 3: Enhanced Diagnostics — Schema Validation
- In `src/pages/AdminDiagnostics.tsx`, extend the diagnostics to check:
  a) Critical column existence (not just table existence):
    const criticalColumns = [
      { table: 'results', column: 'client_result_id' },
      { table: 'results', column: 'voided' },
      { table: 'athletes', column: 'band_id' },
      { table: 'bands', column: 'athlete_id' },
      { table: 'incidents', column: 'station_id' },
    ];
  - For each, query: supabase.rpc or a raw query to check information_schema.columns
  - Since we can't query information_schema directly via the Supabase client easily, use a simple test:
    For each critical column, attempt: `supabase.from(table).select(column).limit(0)`
    If the error message contains "column" or "does not exist", flag it as missing.

  b) Security migration status:
  - Add a section "Security Posture" that checks if the hardening RPCs exist:
    Attempt to call: `supabase.rpc('register_athlete_secure', {})` — if it returns an error about parameters (not "function does not exist"), the RPC is installed.
    Same for claim_band_atomic and submit_result_secure.
  - Display green checkmarks for installed RPCs, red X for missing ones.
  
  c) Display the check results in a new section with a shield icon and "Security Posture" heading.

COMMIT 4: Input Sanitization on Client
- In `src/pages/Register.tsx`, add sanitization to all text inputs before submission:
  const sanitize = (str: string) => str.trim().replace(/[<>]/g, '');
- Apply to: firstName, lastName, parentName, emergencyContactName
- In the handleSubmit function, sanitize all string values before passing to the RPC.
- Also ensure parentEmail is lowercased: `p_parent_email: formData.parentEmail.toLowerCase().trim()`
- In `src/pages/StationMode.tsx`, ensure the result value is strictly numeric:
  const value = parseFloat(item.result);
  if (isNaN(value) || value <= 0) {
    setError('Please enter a valid positive number.');
    return;
  }

VALIDATION CHECKLIST — Do not proceed to Phase 5 until ALL pass:
[ ] migrations/006_security_hardening.sql exists with all policy drops and replacements
[ ] Unauthenticated direct INSERT to athletes table fails (test via Supabase client without auth)
[ ] register_athlete_secure RPC rejects after 5 registrations with same email in 1 hour
[ ] claim_band_atomic correctly rejects expired tokens
[ ] AdminDiagnostics page shows "Security Posture" section with RPC existence checks
[ ] AdminDiagnostics checks for critical columns (client_result_id, voided, etc.)
[ ] All text inputs in registration are sanitized (no HTML tags pass through)
[ ] Station mode rejects NaN and negative result values
[ ] All TypeScript compiles: npx tsc --noEmit
[ ] Build succeeds: npm run build
```

---

## PHASE 5: B2B LICENSING READINESS

```
You are a Principal Platform Engineer executing Phase 5 of a 5-phase production hardening sprint on the Core Elite Combine 2026 app. Phases 1–4 are complete. The app is functional, reliable, polished, and secure. Phase 5 transforms it from a single-event tool into a licensable B2B platform for youth sports leagues, independent combine organizers, and athletic training facilities.

THE STANDARD: A league director should be able to sign up, brand the app with their logo and colors, create events, manage staff, and run combines independently — without Core Elite engineering support. The platform must support data isolation between organizations, comprehensive audit trails, and white-label presentation.

PHASE 5 OBJECTIVE: Build the multi-tenant, audit, white-label, and analytics foundations across 5 commits.

CODEBASE CONTEXT (in addition to Phases 1–4):
- Database: Supabase Postgres. All tables reference events.id. Events already support multiple instances.
- Auth: profiles table with role field ('staff' | 'admin'). No organization concept yet.
- Constants: src/constants.ts — DRILL_CATALOG, AGGREGATE_NORMS (from Gillen et al. 2019, n=7,214)
- Biomechanics: Tier-2 corpus contains full Z-score percentile engine, normCDF function, and position×grade normative lookup tables
- Parent portal: src/pages/ParentPortal.tsx — already shows results with progress tracking
- Admin ops: src/pages/AdminOps.tsx with tabs: EventsTab, BandsTab, WaiversTab, StationsTab

EXECUTE THESE 5 COMMITS IN ORDER:

COMMIT 1: Multi-Tenant Organization Layer
- Create migration `migrations/007_organizations.sql`:
  CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    logo_url TEXT,
    primary_color TEXT DEFAULT '#18181b',
    secondary_color TEXT DEFAULT '#c8a200',
    contact_email TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  
  -- Add organization_id to events
  ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
  
  -- Add organization_id to profiles (staff belong to orgs)
  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
  
  -- Create a default organization for existing data
  INSERT INTO organizations (id, name, slug) 
  VALUES (gen_random_uuid(), 'Core Elite', 'core-elite')
  ON CONFLICT DO NOTHING;
  
  -- RLS: Users can only see events from their organization
  CREATE POLICY "Org-scoped event access" ON events FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM profiles WHERE id = auth.uid()
    )
    OR organization_id IS NULL  -- backwards compatibility
  );
  
  -- Enable RLS on organizations
  ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Public Read Orgs" ON organizations FOR SELECT USING (true);
  CREATE POLICY "Admin Manage Orgs" ON organizations FOR ALL TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

- In the frontend, create `src/hooks/useOrganization.ts`:
  - Fetch the organization for the current user (via profiles.organization_id)
  - Expose org name, colors, logo_url
  - For public pages (registration, parent portal), infer org from the event's organization_id

COMMIT 2: Audit Logging
- Create migration `migrations/008_audit_log.sql`:
  CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES events(id),
    user_id UUID REFERENCES auth.users(id),
    action TEXT NOT NULL,  -- 'result_submitted', 'result_voided', 'band_claimed', 'band_voided', 'athlete_registered'
    entity_type TEXT NOT NULL,  -- 'result', 'band', 'athlete', 'waiver'
    entity_id TEXT NOT NULL,
    old_value JSONB,
    new_value JSONB,
    device_info TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  
  ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Admin Read Audit" ON audit_log FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
  
  CREATE INDEX idx_audit_event ON audit_log(event_id);
  CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
  CREATE INDEX idx_audit_user ON audit_log(user_id);
  
  -- Trigger: auto-log result submissions
  CREATE OR REPLACE FUNCTION log_result_insert() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO audit_log (event_id, user_id, action, entity_type, entity_id, new_value)
    VALUES (NEW.event_id, NEW.recorded_by, 'result_submitted', 'result', NEW.id::text, 
      jsonb_build_object('drill_type', NEW.drill_type, 'value_num', NEW.value_num, 'station_id', NEW.station_id));
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  
  DROP TRIGGER IF EXISTS trg_result_audit ON results;
  CREATE TRIGGER trg_result_audit AFTER INSERT ON results
    FOR EACH ROW EXECUTE FUNCTION log_result_insert();
  
  -- Trigger: auto-log result voids
  CREATE OR REPLACE FUNCTION log_result_void() RETURNS TRIGGER AS $$
  BEGIN
    IF OLD.voided IS DISTINCT FROM NEW.voided AND NEW.voided = true THEN
      INSERT INTO audit_log (event_id, user_id, action, entity_type, entity_id, old_value, new_value)
      VALUES (NEW.event_id, auth.uid(), 'result_voided', 'result', NEW.id::text,
        jsonb_build_object('value_num', OLD.value_num),
        jsonb_build_object('voided', true));
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  
  DROP TRIGGER IF EXISTS trg_result_void_audit ON results;
  CREATE TRIGGER trg_result_void_audit AFTER UPDATE ON results
    FOR EACH ROW EXECUTE FUNCTION log_result_void();

- In `src/pages/AdminOps.tsx`, add a new tab: "Audit Log"
  - Component: `src/pages/admin-ops/AuditTab.tsx`
  - Query: `supabase.from('audit_log').select('*, profiles(email)').order('created_at', { ascending: false }).limit(100)`
  - Display: Table with columns: Time, User, Action, Entity, Details
  - Filter by action type and date range

COMMIT 3: White-Label Theming
- Create `src/components/ThemeProvider.tsx`:
  - Wraps the app and injects CSS custom properties based on the organization's colors:
    document.documentElement.style.setProperty('--brand-primary', org.primary_color);
    document.documentElement.style.setProperty('--brand-accent', org.secondary_color);
  - For public pages (registration, parent portal, home), fetch the org from the event.organization_id
  - For authenticated pages, fetch from the user's profile.organization_id
- Update `src/index.css` to use CSS variables where brand colors appear:
  - Replace hardcoded `bg-zinc-900` on brand elements with a utility class that references --brand-primary
  - Keep zinc-900 as the fallback default
- In `src/pages/Home.tsx`, conditionally render the organization's logo_url if available:
  {org?.logo_url ? <img src={org.logo_url} alt={org.name} className="h-16" /> : <DefaultLogo />}
- Apply the same pattern to ParentPortal.tsx header and Register.tsx header.

COMMIT 4: Z-Score Percentile Analytics Engine
- Create `src/lib/analytics.ts` implementing the percentile engine from the engineering corpus:
  - Import the AGGREGATE_NORMS from Gillen et al. 2019:
    const AGGREGATE_NORMS: Record<string, { mean: number; sd: number; n: number }> = {
      'forty':           { mean: 5.3, sd: 0.4, n: 7077 },
      'ten_split':       { mean: 1.9, sd: 0.2, n: 6975 },
      'shuttle_5_10_5':  { mean: 4.6, sd: 0.3, n: 7055 },
      'three_cone':      { mean: 7.9, sd: 0.6, n: 6344 },
      'vertical':        { mean: 25.2, sd: 4.3, n: 7031 },
      'broad':           { mean: 96.9, sd: 10.6, n: 7066 },
    };
  - Implement normCDF using Abramowitz & Stegun approximation (max error ±7.5×10^-8):
    function normCDF(z: number): number { ... }
  - Implement calculatePercentile:
    export function calculatePercentile(value: number, drillId: string): number | null
    - Use DRILL_CATALOG to determine if lower_is_better (time drills) or higher_is_better (jump/rep drills)
    - Return percentile 1–99, or null if drillId not in norms
  - Implement gradeFromPercentile:
    export function gradeFromPercentile(p: number): string
    - >=95: 'Elite', >=75: 'Above Average', >=50: 'Average', >=25: 'Below Average', <25: 'Developmental'

- In `src/pages/ParentPortal.tsx`, enhance the results display:
  - For each result, compute and show the percentile badge:
    const pct = calculatePercentile(result.value_num, result.drill_type);
    const grade = pct ? gradeFromPercentile(pct) : null;
  - Display as a colored badge next to the result value:
    <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase">
      {pct}th percentile — {grade}
    </span>
  - Color-code: Elite=gold, Above Average=emerald, Average=blue, Below Average=amber, Developmental=zinc

- In `src/pages/AdminDashboard.tsx`, add percentile to the athlete progress table:
  - New column: "Score" showing the average percentile across completed drills
  - Sortable by this column

COMMIT 5: Coach/Scout Read-Only Portal
- Create `src/pages/CoachPortal.tsx`:
  - Route: `/coach/:eventId` — protected by RouteGuard (requires authenticated staff/admin role)
  - Displays a leaderboard/comparison view of all athletes for the event
  - Table columns: Rank, Name, Position, each drill result + percentile
  - Default sort: by average percentile (descending)
  - Filter by position dropdown
  - "Compare" mode: select 2–4 athletes and show a side-by-side radar chart using Recharts:
    import { RadarChart, PolarGrid, PolarAngleAxis, Radar } from 'recharts';
  - Each drill becomes an axis, values are percentiles (0–100 scale)
  - Export comparison as an image (use html2canvas or a simple "Print" button)
- Add route in `src/App.tsx`:
  <Route path="/coach/:eventId" element={<RouteGuard><CoachPortal /></RouteGuard>} />
- Add a link from AdminDashboard to the Coach Portal for the current live event.

VALIDATION CHECKLIST — Phase 5 complete when ALL pass:
[ ] organizations table exists with slug, logo_url, primary_color, secondary_color columns
[ ] events table has organization_id column (nullable for backwards compatibility)
[ ] profiles table has organization_id column
[ ] audit_log table auto-captures result submissions and voids via triggers
[ ] AuditTab in AdminOps displays the last 100 audit entries with user, action, and timestamp
[ ] White-label CSS variables (--brand-primary, --brand-accent) are injected and used on brand elements
[ ] Organization logo renders on Home, Register, and ParentPortal pages when available
[ ] calculatePercentile returns correct values: calculatePercentile(4.51, 'forty') ≈ 98th percentile
[ ] Parent portal shows percentile badges next to each drill result
[ ] Admin dashboard athlete table has a sortable "Score" column (average percentile)
[ ] Coach portal at /coach/:eventId shows leaderboard with position filter
[ ] Radar chart comparison works for 2–4 selected athletes
[ ] All TypeScript compiles: npx tsc --noEmit
[ ] Build succeeds: npm run build
[ ] The app is now an 11/10.
```

---

*End of Execution Prompts. Each phase builds on the previous. Do not skip phases. Do not reorder commits within a phase. Validate before advancing.*
