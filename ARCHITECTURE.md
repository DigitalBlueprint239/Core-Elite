# Core Elite Combine — Architecture Reference

> Last updated: 2026-04-16
> Covers the production Vite/React web application and its planned extension packages.

---

## Table of Contents

1. [Repository Map](#1-repository-map)
2. [Application Structure (Vite / React)](#2-application-structure-vite--react)
3. [Routing Architecture](#3-routing-architecture)
4. [Offline Sync Paradigm](#4-offline-sync-paradigm)
5. [Supabase Auth and RLS](#5-supabase-auth-and-rls)
6. [Scoring Engine](#6-scoring-engine)
7. [Migration Directories](#7-migration-directories)
8. [Unintegrated Packages](#8-unintegrated-packages)
9. [Environment Variables](#9-environment-variables)

---

## 1. Repository Map

```
Core-Elite/
├── src/                        Production Vite/React app (the only thing in the build)
│   ├── pages/                  Route-level components (lazy-loaded)
│   ├── components/             Shared UI components
│   ├── layouts/                Nested layout shells (EnterpriseLayout, LeagueAdminLayout)
│   ├── hooks/                  Custom React hooks
│   ├── lib/                    Pure business logic (no React deps)
│   │   └── scoring/            BES scoring engine (constants, percentile, bes, disparity, validation)
│   ├── constants.ts            DRILL_CATALOG — single source of truth for drill definitions
│   ├── main.tsx                Vite entry point
│   └── App.tsx                 Root router + lazy imports
│
├── migrations/                 PRIMARY SQL migration sequence (001–023+)
├── supabase/
│   ├── migrations/             Supabase CLI migration sequence (timestamp-prefixed)
│   └── functions/              Supabase Edge Functions (Deno runtime)
│
├── packages/                   Planned future packages — NOT imported by the web app
│   ├── field-ops/              React Native station UI + state machine
│   ├── native-ble/             C++/iOS/Android BLE timing hardware bridge
│   └── powersync/              PowerSync sync engine (IndexedDB replacement)
│
├── hardening_migration.sql     Historical reference — contains the original RPC definitions
├── supabase_schema.sql         Historical reference — original baseline schema snapshot
├── ARCHITECTURE.md             This file
└── migrations/README.md        Migration sequence documentation
```

---

## 2. Application Structure (Vite / React)

### Tech stack

| Layer | Technology |
|---|---|
| Bundler | Vite 6 |
| UI framework | React 19 |
| Routing | React Router v7 |
| Styling | Tailwind CSS v4 (Vite plugin) |
| Animation | Motion (Framer Motion successor) |
| Database client | Supabase JS v2 |
| Offline storage | IndexedDB via `idb` |
| Forms / validation | Zod v4 |
| Charts | Recharts |
| QR scanning | html5-qrcode |
| Signature capture | signature_pad |
| Icons | Lucide React |
| Font | Geist Sans / Geist Mono (Vercel, variable fonts) |

### `src/lib/` — pure business logic

All modules in `src/lib/` are framework-agnostic (no React imports, no DOM access).
They are safe to call from tests, SSR, or Web Workers.

| Module | Purpose |
|---|---|
| `supabase.ts` | Singleton Supabase client (reads `VITE_SUPABASE_*` env vars) |
| `offline.ts` | IndexedDB schema + outbox CRUD (4 stores: outbox, athlete_cache, station_config, event_config) |
| `hlc.ts` | Hybrid Logical Clock — deterministic cross-device write ordering |
| `lww.ts` | Add-biased Last-Write-Wins conflict resolution helpers |
| `scoring/` | BES scoring engine (see §6) |
| `analytics.ts` | Simple Gillen-aggregate percentile calculator (used by CoachPortal / ParentPortal) |
| `b2b-exports.ts` | ARMS/JumpForward/XOS CSV generation |
| `types.ts` | Zod schemas + TypeScript interfaces for DB entities |
| `device.ts` | Stable device ID generation (persisted to localStorage) |
| `brand.ts` | Organisation branding (logo URL, name, colours) |
| `authErrors.ts` | Supabase auth error code → user-facing message classifier |
| `overridePin.ts` | PBKDF2 PIN hashing + offline verification (admin override gate) |

---

## 3. Routing Architecture

All routes are defined in `src/App.tsx` using React Router v7.
Every route-level component is **lazy-loaded** via `React.lazy()` and wrapped
in a single top-level `<Suspense>` fallback. This keeps the initial bundle small
and defers page code until first navigation.

### Route tree

```
/                           Home — event info, registration CTA
/register                   Athlete registration (3-step: Profile → Waiver → Claim Band)
/claim-band                 Band claim (consumes claim_token from registration RPC)
/p/:token                   Parent Portal — athlete results (token-gated, public)
/lookup                     Public results lookup

/staff/login                Staff auth (email + password → Supabase session)
/staff/select-station       Station picker (requires auth)
/staff/station/:stationId   StationMode — drill capture (requires auth)

/forgot-password            Password reset flow
/update-password            Password update (after reset link)
/auth/callback              PKCE OAuth callback handler

/admin/login                Admin auth
/admin/dashboard            Admin Dashboard — stats, athlete table, ARMS export
/admin/ops                  Admin Ops — tabbed CRUD for all tables
/admin/diagnostics          Admin Diagnostics — live DB health checks

/coach/:eventId             Coach Portal — leaderboard, position filter, radar compare

/enterprise                 Enterprise landing (EnterpriseLayout shell)
  /enterprise/              Commissioner Overview
  /enterprise/trust-center  Trust Center

/league-admin               League Admin portal (LeagueAdminLayout shell, requires admin auth)
  /league-admin/            League Dashboard
  /league-admin/events      Event Hub
  /league-admin/staff-access Staff Access Management
  /league-admin/compliance  Compliance Audit Viewer
  /league-admin/exports     B2B Exports (ARMS CSV)
  /league-admin/command-center Live Command Center
  /league-admin/import      Vendor Import

*                           NotFound (404)
```

### `<RouteGuard>`

`src/components/RouteGuard.tsx` wraps protected routes. It checks the active
Supabase session via `supabase.auth.getSession()` and redirects unauthenticated
users to `/staff/login`. The `requireAdmin` prop additionally checks the
`profiles.role` column for `'admin'`.

### Layouts

Two nested layout shells use React Router `<Outlet>`:
- `EnterpriseLayout` — unauthenticated marketing shell with its own nav
- `LeagueAdminLayout` — authenticated admin shell with a fixed sidebar and breadcrumb

---

## 4. Offline Sync Paradigm

The web app is designed to operate for an entire 4-hour combine event with zero
network connectivity. Every drill result is durable on the device from the moment
the staff member taps Submit, regardless of connectivity.

### IndexedDB schema (`src/lib/offline.ts`)

Four object stores (`DB_VERSION = 4`):

| Store | Key | Purpose |
|---|---|---|
| `outbox` | `id` (client_result_id) | Write-ahead log for pending Supabase writes |
| `athlete_cache` | `band_id` | Athlete lookups cached after first QR scan |
| `station_config` | `id` | Station queue persistence (survives page reload) |
| `event_config` | `id` | Event KV store; primary use: hashed override PIN for offline validation |

### Outbox item lifecycle

```
Staff taps Submit
    ↓
addToOutbox()  →  IndexedDB outbox (status: 'pending')
    ↓
useOfflineSync.syncOutbox()  (runs on reconnect + 30-second interval)
    ↓  calls submit_result_secure() RPC
    ├─ success / duplicate  →  removeFromOutbox()
    ├─ SUSPICIOUS_DUPLICATE  →  status: 'pending_review'  →  DuplicateChallenge modal
    └─ error (≤5 retries)  →  status: 'retrying' → 'dead_letter' after MAX_RETRIES
                                 →  Force Sync button visible in StationMode
```

### Hybrid Logical Clock (HLC)

**Source:** `src/lib/hlc.ts`

Every write carries an HLC timestamp (`hlc_timestamp`) — a lexicographically
sortable string of the form `{pt:016d}_{l:010d}_{nodeId}`:

- `pt` — physical time (milliseconds since epoch, zero-padded to 16 digits)
- `l` — logical counter (incremented when two events share the same millisecond)
- `nodeId` — stable device identifier from `src/lib/device.ts`

HLC is **generated once per submission** at `addToOutbox()` time and never
regenerated. It flows through the outbox, into the RPC call, and is stored in
`results.hlc_timestamp` on Postgres. The server-side `upsert_device_status_hlc`
RPC enforces strict `HLC_new > HLC_current` to reject stale device heartbeats.

**What HLC is NOT used for:**
- `OutboxItem.timestamp` — this is `Date.now()` used for backoff math only
- `received_at` display fields — wall clock, for human display only

### LWW (Last-Write-Wins)

**Source:** `src/lib/lww.ts`

Add-biased LWW: when two writes conflict, the one with the higher HLC wins.
"Add-biased" means a write is never silently discarded — if two devices recorded
the same athlete at the same drill within 2 minutes, both results reach the server
and the operator is shown a `DuplicateChallenge` modal to resolve which to keep.

### `useOfflineSync` hook

**Source:** `src/hooks/useOfflineSync.ts`

The production sync hook. Returns:

```typescript
{
  isOnline:               boolean,
  pendingCount:           number,
  requiresForceSync:      number,   // dead-letter count
  lastSyncTime:           Date | null,
  syncOutbox:             () => Promise<void>,
  forceSync:              () => Promise<void>,
  updatePendingCount:     () => Promise<void>,
  duplicateChallenges:    DuplicateChallenge[],
  resolveDuplicateChallenge: (itemId, resolution) => Promise<void>,
}
```

Used exclusively by `StationMode.tsx`. All other pages interact with Supabase directly.

---

## 5. Supabase Auth and RLS

### Authentication flow

Staff and admin users authenticate with email + password via
`supabase.auth.signInWithPassword()`. The resulting JWT session is stored
by the Supabase client in `localStorage` and auto-refreshed.

Public-facing routes (registration, parent portal, lookup) use the `anon` key
and rely on RLS policies to restrict what unauthenticated callers can read or write.

### RLS policy model

| Table | Public (anon) | Authenticated (staff) | Admin |
|---|---|---|---|
| `events` | SELECT | SELECT | ALL |
| `athletes` | — (via RPC only) | SELECT | ALL |
| `bands` | SELECT (claim) | ALL | ALL |
| `waivers` | INSERT (via RPC) | SELECT | ALL |
| `stations` | — | SELECT | ALL |
| `results` | — | INSERT, SELECT | ALL |
| `device_status` | — | ALL | ALL |
| `token_claims` | — (via RPC) | — | ALL |
| `audit_log` | — | SELECT | ALL |

Direct public `INSERT` to `athletes`, `waivers`, and `token_claims` is blocked.
All registration writes go through the `register_athlete_secure` RPC
(`SECURITY DEFINER`) which bypasses RLS for its own inserts and enforces
application-level gates (input validation, age range, rate limit, duplicate check).

### `profiles` table

Supabase Auth creates rows in `auth.users`. A public `profiles` table mirrors
the user with a `role` column (`'staff'` or `'admin'`). `RouteGuard` reads
`profiles.role` to gate admin routes.

### Edge Functions

Three Deno Edge Functions live in `supabase/functions/`:

| Function | Purpose |
|---|---|
| `generate-verified-export` | Produces HMAC-SHA-256-signed CSV exports; requires `X-Verification-Secret` header matching `VERIFICATION_SECRET` Edge Function secret |
| `invite-staff` | Sends Supabase auth invitations to new staff email addresses |
| `process-vendor-import` | Ingests legacy CSV uploads, validates format, inserts results with `source_type = 'legacy_csv'` |

---

## 6. Scoring Engine

**Source:** `src/lib/scoring/`

The Biomechanical Efficiency Score (BES) engine is a pure TypeScript module with
no React or DOM dependencies. All functions are deterministic and side-effect free.

### Module map

| File | Contents |
|---|---|
| `constants.ts` | `DrillId`, `Position`, `NormativeStats`, `GILLEN_AGGREGATE_NORMS` (Gillen 2019), `MCKAY_POSITION_NORMS` (McKay 2020, 8 positions × 5 drills), `GATE_THRESHOLDS`, `BES_WEIGHTS`, `BES_BANDS` |
| `validation.ts` | 4-gate validation pipeline: false_start → below_physical_floor → above_max_threshold → extraordinary_result |
| `percentile.ts` | Abramowitz & Stegun CDF (A&S 26.2.17), Z-score computation, `lookupNorm()` with fallback chain, `getPercentile()` returning `PercentileResult` with `isPositionAdjusted` flag |
| `disparity.ts` | Mechanical disparity detection (Morin 2015 horizontal GRF ratio) between ten_split and vertical percentiles |
| `bes.ts` | `computeBES()` — weighted composite score with disparity penalty; returns `BESResult` with `isPositionAdjusted` flag |
| `index.ts` | Public API surface — re-exports all types and functions |

### Normative data sources

| Source | Used for | n |
|---|---|---|
| Gillen et al. 2019 (PMC6355118) | All-position aggregate fallback norms | 7,214 |
| McKay et al. 2020 (PMID 30418328) | Position-specific norms for DB, WR, RB, QB, TE, LB, DL, OL | 7,478 |

### Norm lookup priority

```
lookupNorm(drillId, position, grade):
  1. MCKAY_POSITION_NORMS[position][drillId]   → isPositionAdjusted: true
  2. GILLEN_AGGREGATE_NORMS[drillId]           → isPositionAdjusted: false

Fallback triggers:
  - position is undefined / null / 'ATHLETE'
  - position table is empty (K, P, LS, ATH, EDGE, FB, S, CB)
  - drill absent from populated position table (e.g. DB has no three_cone)
```

### BES formula

```
BES = weighted_average(
  percentile('forty',          position) × 0.30
  percentile('ten_split',      position) × 0.25
  percentile('vertical',       position) × 0.20
  percentile('shuttle_5_10_5', position) × 0.15
  disparity_penalty                       × 0.10  (≤ 0)
)
```

Weights are re-normalised when fewer than 4 drills are available so the score
is always on the 0–100 scale. `broad` jump is excluded from BES but available
for standalone percentile scoring.

---

## 7. Migration Directories

There are two separate migration directories with different naming conventions
and different target tools. They partially overlap (migrations 018–019 exist in both).

### `migrations/` — primary sequence

```
Format:  NNN_description.sql   (001, 002, ..., 023)
Tool:    psql / Supabase SQL editor / manual application
```

The authoritative migration sequence for developers provisioning a fresh database
or applying changes manually. Starts at `001_initial_schema.sql` (canonical seed)
and proceeds numerically. Every migration should be idempotent where possible.

| Range | Content |
|---|---|
| 001 | Baseline schema (tables + RLS policies) |
| 002–009 | Core schema evolution: events status, device_status, parent portals, waiver columns, HLC columns, attempt numbers, indexes |
| 010–016 | Security hardening: RPCs, rate limiting, organizations, audit log, duplicate guards, Tier-1 data hardening |
| 017–019 | Device status HLC, capture telemetry, verification hash |
| 020 | Override PIN column on events |
| 021 | Reserved (exists only in `supabase/migrations/`) |
| 022 | `athletes.high_school` column |
| 023 | `register_athlete_secure` v5 — restores full v3 logic + biometric parameters |

**`add_override_pin_to_events.sql` (formerly unnumbered)** was renamed to `020_*` by Mission B.

### `supabase/migrations/` — Supabase CLI sequence

```
Format:  YYYYMMDDHHmmss_description.sql   (timestamp-prefixed)
Tool:    supabase db push  (Supabase CLI)
```

Managed by the Supabase CLI. Currently contains four files:

| File | Equivalent in migrations/ |
|---|---|
| `20260412000018_capture_telemetry.sql` | 018 |
| `20260412000019_verification_hash.sql` | 019 |
| `20260415000020_legacy_import.sql` | No equivalent — adds `source_type = 'legacy_csv'` support |
| `20260415000021_iam_hardening.sql` | No equivalent — IAM pipeline hardening |

Migrations 020 and 021 in `supabase/migrations/` have **no counterpart** in
`migrations/`. When adding a new migration, add it to both directories to
keep them in sync.

### Which one to use?

| Scenario | Use |
|---|---|
| Provisioning a fresh database manually | `migrations/001` → `migrations/NNN` in order via psql or SQL editor |
| CI/CD via Supabase CLI | `supabase db push` (reads `supabase/migrations/`) |
| Deploying a new feature migration | Add to **both** directories |

`supabase_schema.sql` at the repo root is a **historical reference only**. It
reflects the original schema before any numbered migrations were applied and is
intentionally out of date. Do not use it to provision a new database.

---

## 8. Unintegrated Packages

Three packages in `packages/` are fully authored but not imported by the
production web application. They represent the planned React Native mobile client.

| Package | Purpose | Integration blocker |
|---|---|---|
| `packages/field-ops` | React Native StationCapture screen + state machine | Requires RN host; uses `react-native`, `expo-haptics` |
| `packages/native-ble` | BLE timing hardware bridge (C++/iOS/Android TurboModule) | Requires RN New Architecture + native build |
| `packages/powersync` | PowerSync sync engine replacing IndexedDB outbox | Requires PowerSync service deployment + `VITE_POWERSYNC_URL` |

Each package has a `README.md` stating its status and integration prerequisites.
See `MIGRATION_PLAN.md` inside `packages/powersync/` for the detailed IndexedDB
→ PowerSync cutover procedure including failure mode analysis.

---

## 9. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | Yes | Supabase project REST/Auth/Realtime URL |
| `VITE_SUPABASE_ANON_KEY` | Yes | Public anon key (safe to expose in browser) |
| `VITE_VERIFICATION_SECRET` | Admin only | Must match `VERIFICATION_SECRET` Edge Function secret; used by `VerifiedExportButton` |
| `APP_URL` | Optional | Canonical app URL for OAuth redirects and email links |
| `VITE_POWERSYNC_URL` | Future | PowerSync service endpoint (not yet active) |

See `.env.example` for setup instructions. Never commit `.env` (it is in `.gitignore`).
