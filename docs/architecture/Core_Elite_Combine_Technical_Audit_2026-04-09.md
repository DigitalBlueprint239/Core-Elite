# Core Elite Combine Platform — Architect's Technical Audit
## Architecture Snapshot | April 9, 2026
### Prepared for: External Technical Auditor

---

## How to Verify This Audit

All claims in this document are traceable to specific files in this repository. To independently verify:

```bash
# 1. Confirm the code baseline commit
git show 57d26e8 --stat

# 2. Confirm all referenced source files exist
ls src/lib/offline.ts src/lib/hlc.ts src/lib/lww.ts
ls src/lib/scoring/bes.ts src/lib/scoring/percentile.ts src/lib/scoring/disparity.ts
ls src/lib/scoring/validation.ts src/lib/scoring/constants.ts
ls src/hooks/useOfflineSync.ts src/hooks/useOrganization.ts
ls src/components/ThemeProvider.tsx src/pages/CoachPortal.tsx
ls src/pages/AdminDiagnostics.tsx
ls src/pages/enterprise/CommissionerOverview.tsx src/pages/enterprise/TrustCenter.tsx
ls src/pages/league-admin/B2BExports.tsx src/pages/league-admin/ComplianceAuditViewer.tsx
ls migrations/012_organizations.sql migrations/013_audit_log.sql migrations/016_tier1_data_hardening.sql
ls packages/native-ble/cpp/BLETimingBuffer.cpp packages/native-ble/cpp/BLETimingBuffer.h

# 3. Confirm the PowerSync spec (canonical location is this docs/architecture/ directory;
#    an identical copy also exists at the repository root: tech-spec-powersync.md)
ls docs/architecture/tech-spec-powersync.md

# 4. Check normative data citations
grep -n "PMC6355118\|PMID 30418328\|PMID 17127583\|Morin et al" src/lib/scoring/constants.ts

# 5. Confirm all 16 migrations are present
ls migrations/*.sql | wc -l

# 6. Confirm the route tree
grep -n "^import\|<Route" src/App.tsx | head -60
```

> **Note on McKay position norms:** `MCKAY_POSITION_NORMS` in `src/lib/scoring/constants.ts` currently contains a stub for OL/forty only (sd estimated). All other positions fall back to Gillen aggregate norms. The lookup priority chain in `src/lib/scoring/percentile.ts` is fully implemented and will automatically use McKay data when it is populated.

---

## Repository Verification Map

| Architectural Claim | Supporting File(s) |
|---|---|
| Offline outbox with HLC stamping | `src/lib/offline.ts`, `src/lib/hlc.ts` |
| Add-biased LWW conflict resolution | `src/lib/lww.ts`, `src/hooks/useOfflineSync.ts` |
| Exponential backoff + dead-letter | `src/hooks/useOfflineSync.ts` lines 52–56, 162–168 |
| Duplicate challenge protocol | `src/hooks/useOfflineSync.ts` — `resolveDuplicateChallenge()` |
| 4-gate validation pipeline (BES) | `src/lib/scoring/validation.ts`, `src/lib/scoring/constants.ts` |
| normalCDF (A&S 26.2.17) | `src/lib/scoring/percentile.ts` lines 56–93 |
| BES composite formula | `src/lib/scoring/bes.ts` — `computeBES()` |
| Mechanical disparity detection | `src/lib/scoring/disparity.ts` — `detectMechanicalDisparity()` |
| 40-yard phase decomposition | `src/lib/scoring/disparity.ts` — `decompose40Yard()` |
| Gillen 2019 normative data | `src/lib/scoring/constants.ts` — `GILLEN_AGGREGATE_NORMS` |
| McKay 2020 position norms (partial) | `src/lib/scoring/constants.ts` — `MCKAY_POSITION_NORMS` (OL/forty stub only) |
| register_athlete_secure v4 (5 gates) | `migrations/016_tier1_data_hardening.sql` |
| submit_result_secure RPC | `migrations/010_security_hardening.sql` |
| Immutable audit triggers | `migrations/013_audit_log.sql` |
| Multi-tenant organizations + RLS | `migrations/012_organizations.sql` |
| DB-level data hardening constraints | `migrations/016_tier1_data_hardening.sql` |
| Composite uniqueness guard | `migrations/015_composite_uniqueness_guard.sql` |
| HLC column on results table | `migrations/007_phase2_hlc_timestamp.sql` |
| Attempt immutability (per-rep rows) | `migrations/008_phase2_attempt_number.sql` |
| Covering indexes | `migrations/009_phase2_covering_indexes.sql` |
| White-label CSS variable injection | `src/components/ThemeProvider.tsx` |
| Organization context hook | `src/hooks/useOrganization.ts` |
| Coach portal + radar compare | `src/pages/CoachPortal.tsx` |
| B2B ARMS CSV export | `src/lib/b2b-exports.ts`, `src/pages/league-admin/B2BExports.tsx` |
| Enterprise portal routes | `src/pages/enterprise/CommissionerOverview.tsx`, `src/pages/enterprise/TrustCenter.tsx` |
| League admin portal routes | `src/pages/league-admin/` (5 pages) |
| Admin diagnostics + security posture | `src/pages/AdminDiagnostics.tsx` |
| Native BLE C++ buffer | `packages/native-ble/cpp/BLETimingBuffer.h`, `packages/native-ble/cpp/BLETimingBuffer.cpp` |
| React Native TurboModule bridge | `packages/native-ble/src/NativeBLETimingModule.ts` |
| PowerSync migration spec | `docs/architecture/tech-spec-powersync.md` (also at repo root: `tech-spec-powersync.md`) |
| Complete route tree (5 portal trees) | `src/App.tsx` |
| Scoring analytics (Coach Portal) | `src/lib/analytics.ts` |

---

# 1. Contextual Update Scope

## 1.1 What Was Built and Why

The Core Elite Combine Platform is a production-grade athletic combine management system built on **React 18 / TypeScript / Supabase Postgres / Vercel**. The platform crossed approximately 4,000 net lines of new production code across five structured execution phases (`Core_Elite_5_Phase_Execution_Prompts.md` at repository root contains the full battle plan).

The platform's survival imperative was operational: live combine events with 100+ athletes, parents on mobile, coaches on iPads, and admins running a command center — all dependent on a system that previously had no offline resilience, no data integrity enforcement at the database layer, no conflict resolution protocol, and no analytics engine. The five phases addressed every critical failure vector.

| Phase | Theme | Key Deliverable |
|---|---|---|
| 1 | Go-Live Blockers | Vercel SPA routing, registration hardening, CSV escaping, queue persistence (`vercel.json`, `migrations/016_tier1_data_hardening.sql`) |
| 2 | Event-Day Reliability | HLC timestamps, per-rep immutability, covering indexes (`migrations/007–009`) |
| 3 | Scout Intelligence Engine | BES scoring, percentile analytics, 4-gate validation, UX polish (`src/lib/scoring/`) |
| 4 | Security Hardening | RLS lockdown, rate limiting, input sanitization, diagnostics (`migrations/010–011`, `src/pages/AdminDiagnostics.tsx`) |
| 5 | Enterprise Layer | Multi-tenancy, audit logging, white-label, B2B/League Admin portal, Coach Portal (`migrations/012–013`, `src/pages/enterprise/`, `src/pages/league-admin/`, `src/pages/CoachPortal.tsx`) |

---

# 2. Structural Taxonomy — Seven Architecture Pillars

## 2.1 Pillar 1: Offline-First Data Sovereignty

**Source:** `src/lib/offline.ts`, `src/hooks/useOfflineSync.ts`

IndexedDB schema `core_elite_combine_db` at version 4, opened via the `idb` library:

| Store | Key | Purpose |
|---|---|---|
| `outbox` | `id` (client_result_id UUID) | Durable write queue for results, device_status, audit_log items |
| `athlete_cache` | `band_id` | Fast QR lookup cache — avoids network round-trip at station |
| `station_config` | `"queue_<stationId>"` | Crash-safe queue persistence — survives page reload |
| `event_config` | `"override_pin:<event_id>"` | Offline-safe hashed override PIN cache |

The schema uses versioned `upgrade()` callbacks with `oldVersion` guards — each version adds new stores or indexes non-destructively. No data loss occurs on schema upgrade.

The **PowerSync migration path** is documented in `docs/architecture/tech-spec-powersync.md` (an identical copy also lives at the repository root as `tech-spec-powersync.md`). It replaces this IndexedDB outbox with WASM SQLite backed by OPFS, bidirectional sync via a service worker, and a `CoreEliteConnector` extending `PowerSyncBackendConnector`.

## 2.2 Pillar 2: Hybrid Logical Clock (HLC) Timestamping

**Source:** `src/lib/hlc.ts`

Implements the Kulkarni & Demirbas 2014 algorithm. Key properties:

- **`tick()`** — generates a new HLC string for a local write. Advances `max(local.pt, Date.now())` and increments the logical counter if physical time is unchanged.
- **`update(remoteHlcStr)`** — implements the receive-event rule. Local clock advances to be strictly ahead of any remote clock we have successfully synced.
- **Wire format:** `{pt:016d}_{l:010d}_{nodeId}` — zero-padded to fixed widths, making the string directly lexicographically sortable. Standard IndexedDB index or Postgres B-Tree gives correct temporal order without a custom comparator.
- **State persistence:** `localStorage` key `core_elite_hlc_state`. Survives page reload. Handles `localStorage` unavailability (private mode, storage quota exceeded) — state remains valid in memory for the session.
- **`compareHlc(a, b)`** — pure string comparison; no parsing required.

HLC state is promoted to a first-class column on the `results` table in `migrations/007_phase2_hlc_timestamp.sql`.

## 2.3 Pillar 3: Add-Biased Last-Write-Wins (LWW) Conflict Resolution

**Source:** `src/lib/lww.ts`

Core contract: `addBiasedShouldKeep(addHlc, removeHlc)` returns `true` when `addHlc >= removeHlc`. A tie (same-millisecond writes from two tablets) resolves in favor of **keeping the record** — timing results are never silently discarded.

| Function | Comparison | Record Type | Policy |
|---|---|---|---|
| `addBiasedShouldKeep()` | `>=` | Any | Tie preserves the add operation |
| `lwwShouldReplace()` | strict `>` | Mutable records | Tie preserves the existing record (stable) |
| `resolvePayloadConflict<T>()` | HLC comparison | Outbox items | Returns the authoritative payload; both items still reach the server |
| `deviceStatusShouldUpdate()` | strict `>` | `device_status` | Only the strictly newer heartbeat wins |

Server alignment: `submit_result_secure` RPC treats a duplicate `client_result_id` as success — add-biased at the Postgres layer.

## 2.4 Pillar 4: Multi-Gate RPC Security Pipeline

**Source:** `migrations/016_tier1_data_hardening.sql` (`register_athlete_secure` v4), `migrations/010_security_hardening.sql` (`submit_result_secure`)

`register_athlete_secure` runs 5 gates in order:

1. **Input normalization + zero-DB-I/O validation** — name presence, email regex (`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`), 10-digit phone, DOB not null and not future, position present
2. **Event validation** — `SELECT id, status FROM events WHERE id = p_event_id`; `status IN ('active', 'draft')`
3. **Age range check** — `EXTRACT(YEAR FROM AGE(CURRENT_DATE, p_date_of_birth))` must be 10–19
4. **Rate limiting** — max 5 registrations per `(event_id, parent_email)` per hour
5. **Duplicate athlete check** — exact match on `(event_id, lower(first_name), lower(last_name), date_of_birth)`. COPPA-compliant error: never confirms whether a specific child's record exists

**Exception posture:** `SQLERRM` is logged server-side via `RAISE LOG` only and is **never** included in the JSONB response to the caller. All client-facing error strings are literal constants defined in the function body.

**DB-layer safety net** (defense-in-depth):
- `CHECK` constraint `athletes_dob_range_check` — date_of_birth >= 2005-01-01 and <= CURRENT_DATE - 9 years
- `CHECK` constraint `athletes_parent_email_format_check` — RFC 5322 simplified regex
- Functional unique index `idx_athletes_event_email_name_unique` on `(event_id, lower(parent_email), lower(first_name), lower(last_name))`

## 2.5 Pillar 5: Biomechanical Intelligence Engine (BES)

**Source:** `src/lib/scoring/` (6 modules)

The BES is the primary output of the Scout's Intuition Engine: a 0–100 composite score synthesizing drill results with position-adjusted normative context. See Section 4 for the full capability matrix.

## 2.6 Pillar 6: Immutable Audit Trail

**Source:** `migrations/013_audit_log.sql`, `src/pages/admin-ops/AuditTab.tsx`, `src/pages/league-admin/ComplianceAuditViewer.tsx`

The `audit_log` table is populated exclusively by Postgres triggers — no client can `INSERT` directly (no public write policy exists):

- `trg_result_audit` — `AFTER INSERT ON results`: auto-logs every result submission with `drill_type`, `value_num`, `station_id`
- `trg_result_void_audit` — `AFTER UPDATE ON results` when `OLD.voided IS DISTINCT FROM NEW.voided AND NEW.voided = true`: logs the void action

Both triggers run as `SECURITY DEFINER` (inherit definer privileges, bypass client RLS). `SELECT` is admin-only via RLS.

Covering indexes: `idx_audit_event(event_id)`, `idx_audit_entity(entity_type, entity_id)`, `idx_audit_user(user_id)`.

## 2.7 Pillar 7: Multi-Tenant Organization Layer

**Source:** `migrations/012_organizations.sql`, `src/hooks/useOrganization.ts`, `src/components/ThemeProvider.tsx`

The `organizations` table anchors all multi-tenant isolation. Org-scoped RLS policies on all core tables ensure a station tablet for Organization A cannot read Organization B's athletes, bands, or results — even on the same network. `useOrganization.ts` exposes the active org context to React components. `ThemeProvider.tsx` reads org configuration and injects CSS custom properties for white-label event-day branding.

---

# 3. Route Architecture — The Complete Five-Portal Tree

**Source:** `src/App.tsx`

All routes are lazy-loaded via `React.lazy()` with a `<Suspense>` fallback. `RouteGuard` enforces authentication; the `requireAdmin` prop adds role enforcement. A global `<SyncIndicator />` component floats over all portal routes, surfacing offline queue state in real time.

```
/                              → Home (public, white-label branded)
/register                      → Athlete registration (public)
/p/:token                      → Parent portal (token-gated, public)
/claim-band                    → Wristband claim (public)
/lookup                        → Athlete lookup (public)
/forgot-password               → Password reset (public)

/staff/login                   → Staff authentication
/staff/select-station          → RouteGuard → StationSelection
/staff/station/:stationId      → RouteGuard → StationMode (drill result capture)

/admin/login                   → Admin authentication
/admin/dashboard               → RouteGuard(requireAdmin) → AdminDashboard
/admin/ops                     → RouteGuard(requireAdmin) → AdminOps (9 tabs)
/admin/diagnostics             → RouteGuard(requireAdmin) → AdminDiagnostics

/coach/:eventId                → RouteGuard → CoachPortal (leaderboard + radar compare)

/enterprise                    → EnterpriseLayout (Outlet — unauthenticated)
/enterprise/                   → CommissionerOverview
/enterprise/trust-center       → TrustCenter

/league-admin                  → RouteGuard(requireAdmin) → LeagueAdminLayout (Outlet)
/league-admin/                 → LeagueDashboard
/league-admin/events           → EventHub
/league-admin/staff-access     → StaffAccessManagement
/league-admin/compliance       → ComplianceAuditViewer
/league-admin/exports          → B2BExports

*                              → NotFound (catch-all)
```

**AdminOps tabs** (`src/pages/admin-ops/`): Athletes, Bands, Drills, Events, Incidents, Results, Stations, Waivers, Audit.

---

# 4. Functional Mechanics — Offline Dispatch System

**Source:** `src/hooks/useOfflineSync.ts`, `src/lib/offline.ts`

## 4.1 Trigger Architecture

Sync runs under four conditions:

| Trigger | Source |
|---|---|
| `window 'online'` event | `useEffect` event listener in `useOfflineSync` |
| `setInterval` every 30 seconds | Only when `navigator.onLine` is true |
| `resolveDuplicateChallenge()` completes | After operator makes a duplicate decision |
| `forceSync()` called | After admin resets a dead-letter item |

**Lifecycle note:** Sync only runs while the hook's host component is mounted. This is the primary limitation addressed by the PowerSync migration (a service worker decouples sync from component lifecycle).

## 4.2 Outbox Item State Machine

```
PENDING
  │ RPC error, retry_count < MAX_RETRIES (5)
  ▼
RETRYING  ──── exponential backoff: 2^retry_count × 1000 ms
  │ retry_count >= 5
  ▼
DEAD_LETTER  ←── forceSync() resets to PENDING
  │
  │ (separate path) RPC returns code: 'SUSPICIOUS_DUPLICATE'
  ▼
PENDING_REVIEW  ──── DuplicateChallenge modal surfaced
  │ operator resolves: keep_both | replace | discard
  ▼
REMOVED or re-PENDING
```

## 4.3 Multi-Type Dispatch Matrix

| `OutboxItem.type` | Destination | Idempotency Key | Conflict Policy |
|---|---|---|---|
| `result` | `submit_result_secure` RPC | `client_result_id` UUID | Add-biased: duplicate RPC response → success; never discard |
| `device_status` | `supabase.from('device_status').upsert()` | `station_id` | LWW: `deviceStatusShouldUpdate()` strict `>` |
| `audit_log` | `supabase.from('audit_log').insert()` | `id` UUID | Add-biased: `23505` unique violation → success |

## 4.4 HLC Advancement on Sync Completion

After every successful sync: `updateHlc(item.hlc_timestamp)` advances the local clock. This implements the Kulkarni & Demirbas **receive-event rule**: the local clock is always strictly ahead of any confirmed server write, ensuring all future local writes are ordered after it.

HLC is passed to `submit_result_secure` inside `meta.hlc_timestamp`, where it is stored on the result row for cross-device ordering in the audit log.

## 4.5 Suspicious Duplicate Challenge Protocol

When `submit_result_secure` returns `code: 'SUSPICIOUS_DUPLICATE'`, the outbox item transitions to `pending_review` and a `DuplicateChallenge` object is appended to React state. The operator resolves via the StationMode modal with three choices:

| Resolution | Mechanism |
|---|---|
| `keep_both` | `attempt_number` is incremented past `existingAttemptNum`. Gate 2 of `submit_result_secure` skips the duplicate check when `attempt_number > 1` — the new result is written as a separate rep |
| `replace` | Conflicting DB result is set `voided = true` (triggers `trg_result_void_audit`). Outbox item reset to `pending` with `attempt_number = 1`. Voided record is excluded from Gate 2's query |
| `discard` | Outbox item removed. Existing DB record stands |

---

# 5. PowerSync Offline-First Migration Strategy

**Source:** `docs/architecture/tech-spec-powersync.md` (canonical), `tech-spec-powersync.md` (root copy)

The specification defines a three-sprint, non-big-bang migration from the current IndexedDB outbox to `@powersync/web`.

## 5.1 Architecture Target

```
Browser / PWA
│
├── React Components (usePowerSync() hook)
│   └── PowerSync Web Client (@powersync/web)
│       └── WASM SQLite (wa-sqlite, persistent via OPFS)
│           ├── Upload Queue (FIFO, durable, service-worker)
│           └── Download Queue (streaming replication)
│               └── WebSocket (sync stream) + REST (upload)
│
└── PowerSync Service (self-hosted or cloud)
    └── Sync Rules Engine (reads Supabase via logical replication)
        └── Supabase Postgres (source of truth — RLS enforced)
```

## 5.2 Migration Phases

**Phase A — Parallel Read Acceleration (Sprint 1)**
Install `@powersync/web`, `@powersync/react`, `@powersync/supabase-connector`. Wire for reads only: QR scan athlete lookup hits local WASM SQLite instead of `supabase.from('athletes')`. `useOfflineSync` continues handling all writes unchanged. QR-to-athlete-loaded latency: 400–1200ms (network) → <100ms (local SQLite ~2ms indexed query).

**Phase B — Write Migration (Sprint 2)**
Implement `CoreEliteConnector extends PowerSyncBackendConnector`. Override `uploadData(database)` to call `submit_result_secure` with the same payload shape as the current outbox. `SUSPICIOUS_DUPLICATE` branch dispatches a `CustomEvent` to the `window` (connector runs off-main-thread in a service worker; `window.dispatchEvent` bridges to the UI). New result writes go to PowerSync's upload queue instead of the IndexedDB outbox.

**Phase C — Full Cutover (Sprint 3)**
Remove `src/lib/offline.ts` entirely. Remove `useOfflineSync`. Migrate `DuplicateChallenge` logic into the connector's conflict handler. OPFS-backed SQLite becomes the sole local store; IndexedDB is fully retired. One-time `drainLegacyOutbox()` function drains any remaining IndexedDB items through the new connector before cutover.

## 5.3 Sync Rules Bucket Definitions (powersync.yaml)

Two bucket definitions control row-level streaming to authenticated clients:

- **`event_data` bucket:** Scoped per `event_id` injected into the Supabase JWT by `get_powersync_token` RPC. Station tablets receive only their assigned event's rows (`athletes`, `bands`, `results` (non-voided), `device_status`).
- **`admin_data` bucket:** Scoped per `org_id`. Coaches and admins receive all events under their organization, including voided results and `audit_log` entries.

## 5.4 QR/NFC Zero-Touch Check-in

QR payload is base64-encoded JSON `{v:1, b:band_id, e:event_id}`:

```
QR scan → parseQRPayload(raw, expectedEventId)
        → validates: v===1, UUID regex, event_id matches station
        → LOCAL SQLite JOIN (athletes × bands) — ~2ms indexed
        → athlete state + attempt history loaded
        → StationMode renders "Ready to Record"
Total: <300ms (local) / <3s (including camera focus)
```

`parseQRPayload` is defined in the spec at `src/lib/qr.ts` (to be created in Sprint A). The current implementation at `src/pages/StationMode.tsx` performs an equivalent inline parse directly against the Supabase network client — Sprint A replaces only the data source, not the parse logic.

NFC path (Web NFC API on Android Chrome) uses an identical `BandQRPayload` parsed from an NDEF Text record (`src/lib/nfc.ts`, Sprint A). iOS NFC requires a React Native companion app using `react-native-nfc-manager`.

## 5.5 Performance Targets

| Operation | Current (network-dependent) | Target (PowerSync local) |
|---|---|---|
| QR scan → athlete loaded | 400–1200ms | < 100ms |
| Result submit (online) | 300–600ms | < 50ms (local write) + async upload |
| Result submit (offline) | Queued, no lag | Identical — OPFS write is synchronous-feel |
| Full event resync after reconnect | N/A | < 5s for 500-athlete event |

---

# 6. Biomechanical Intelligence Engine (BES) — Capability Matrix

**Source:** `src/lib/scoring/` (6 modules)

## 6.1 Module: Normal CDF (`scoring/percentile.ts`)

Implements **Abramowitz & Stegun Formula 26.2.17** polynomial approximation of the standard normal CDF. Maximum absolute error: `|ε(x)| ≤ 7.5 × 10⁻⁸`. Horner's method (`t*(b1 + t*(b2 + t*(b3 + t*(b4 + t*b5))))`) minimizes floating-point cancellation. Result clamped to `[0, 1]`.

Z-score sign convention is direction-aware:
- `lower_is_better` (time-based drills): `Z = (mean − X) / sd` — faster time yields positive Z and higher percentile
- `higher_is_better` (distance-based drills): `Z = (X − mean) / sd` — standard convention

## 6.2 Module: Normative Lookup Priority Chain (`scoring/constants.ts` + `scoring/percentile.ts`)

The `lookupNorm()` function in `percentile.ts` implements a three-tier fallback:

| Priority | Source | Status |
|---|---|---|
| 1 (position × grade) | McKay et al. 2020 | **Not yet implemented** — grade subdivision deferred (code comment: "Grade-specific subdivision not yet available") |
| 2 (position aggregate) | McKay et al. 2020 | **Partially implemented** — OL/forty only (sd estimated, n=0). All other positions not yet populated |
| 3 (all-position aggregate) | Gillen et al. 2019 | **Fully implemented** — always available as fallback for all 5 BES-eligible drills |

In practice, for all positions except OL (forty drill only), the system uses Gillen 2019 aggregate norms. This accurately reflects the current state; the priority chain is designed to automatically promote to higher-quality norms as McKay data is populated.

## 6.3 Module: 4-Gate Validation Pipeline (`scoring/validation.ts`)

Gates run in strict priority order — the pipeline exits on the first failure.

| Gate | Name | Condition | Source Basis |
|---|---|---|---|
| 1 | `false_start` | reaction_ms < 120ms (sprint/agility drills only) | Pain & Hibbs 2007, PMID 17127583 |
| 2 | `below_physical_floor` | value < absolute biomechanical minimum | Framework v2 §2.2.4 |
| 3 | `above_max_threshold` | value > sensor-malfunction ceiling | Framework v2 §2.2.4 |
| 4 | `extraordinary_result` | value within valid range but below world-record floor | Framework v2 §2.2.4 |

Gate thresholds per drill (from `GATE_THRESHOLDS` in `scoring/constants.ts`):

| Drill | Physical Floor (Gate 2) | Max Threshold (Gate 3) | Extraordinary Floor (Gate 4) |
|---|---|---|---|
| 40-yard dash | < 3.50s → BLOCK | > 9.00s → BLOCK | < 4.21s → FLAG |
| 10-yard split | < 1.40s → BLOCK | > 3.00s → BLOCK | < 1.50s → FLAG |
| 5-10-5 shuttle | < 3.50s → BLOCK | > 8.00s → BLOCK | < 3.73s → FLAG |
| Vertical jump | < 5 in → BLOCK | > 65 in → BLOCK | > 46 in → FLAG |
| Broad jump | < 24 in → BLOCK | > 160 in → BLOCK | > 130 in → FLAG |

## 6.4 Module: Mechanical Disparity Detection (`scoring/disparity.ts`)

**Scientific basis:** Morin et al. 2015 (Frontiers in Physiology) — elite sprinters achieve a horizontal-to-total GRF ratio (Rₑ) of 0.40–0.50; non-elite: 0.25–0.35. Without force plates at a combine, `ten_split` percentile serves as the horizontal acceleration proxy; `vertical` percentile serves as the raw power output proxy.

**Detection threshold:** 20 percentile-point gap (`DISPARITY_THRESHOLD_PCT_POINTS = 20` in `constants.ts`).

| Direction | Condition | Hypothesis | Coaching Cue |
|---|---|---|---|
| `power_exceeds_acceleration` | vertical_pct > ten_split_pct by >20pts | Suboptimal horizontal GRF orientation; Rₑ likely < 0.35 | Forward lean, shin angle, horizontal impulse, sled pulls, A-march progressions |
| `acceleration_exceeds_power` | ten_split_pct > vertical_pct by >20pts | Efficient drive-phase mechanics; limited power ceiling for top-end speed | Trap bar deadlifts, depth drops, reactive strength index training |

**Phase-based 40-yard decomposition** (Brown/Vescovi/VanHeest three-phase model, v2 §2.3.2):

| Phase | Distance | Tests |
|---|---|---|
| Initial Acceleration | 0–10 yd | GRF orientation, first-step mechanics, drive-phase posture |
| Middle Acceleration | 10–20 yd | Transition to upright, stride frequency stabilization |
| Metabolic-Stiffness | 20–40 yd | Contact time reduction, leg stiffness, neuromuscular RFD limits |

Metabolic-stiffness weakness flag: Phase 3 > 60% of total 40-yard time (elite threshold ~55%).

## 6.5 Module: BES Composite Formula (`scoring/bes.ts`)

```
BES = Σ(normalizedWeight × percentile) + (normalizedDisparityWeight × disparityPenalty)
```

**Raw weights** (from `BES_WEIGHTS` in `scoring/constants.ts`):

| Component | Weight |
|---|---|
| 40-yard dash | 0.30 |
| 10-yard split | 0.25 |
| Vertical jump | 0.20 |
| 5-10-5 shuttle | 0.15 |
| Disparity penalty | 0.10 |
| Broad jump | **0.00** — not in BES composite; available for standalone percentile only |

**Weight normalization:** Weights are re-normalized across the drills that are present and valid. BES is always on the 0–100 scale regardless of how many drills were recorded. Partial-data BES is valid and clearly labeled by `availableWeightSum`.

**Disparity penalty:** `−(gap − 20)` when gap > 20 percentile points, floored at −80.

**Output bands** (from `BES_BANDS` in `scoring/constants.ts`):

| Band | Score Range |
|---|---|
| Elite | 80–100 |
| Above Average | 65–79 |
| Average | 45–64 |
| Below Average | 30–44 |
| Needs Development | 0–29 |

Each BESResult includes a machine-generated one-sentence `interpretation` string incorporating the band, score, and disparity direction/percentile values — ready for display on a scout card.

---

# 7. Coach Portal & Leaderboard Intelligence

**Source:** `src/pages/CoachPortal.tsx`, `src/lib/analytics.ts`, `src/lib/b2b-exports.ts`

The Coach Portal is accessible at `/coach/:eventId` behind `RouteGuard` (staff-level auth). It is the primary scout interface for evaluating and comparing athletes at a live event.

**Features:**
- **Leaderboard:** All athletes sorted by composite `avgPct` (average percentile across completed drills). Columns are sortable. All drills in `DRILL_CATALOG` have columns.
- **Position filter:** Multi-select filter across all 16 positions (ATH listed first). Enables position-scoped talent evaluation.
- **Hardware provenance badges:** Per-result badges — `LASER`, `HAND` (hand-timed), `WATCH` (stopwatch), `MAN` (manual entry) — sourced from `meta.hardware_type` on each result row. Scouts can assess data quality at a glance.
- **Radar chart comparison:** Multi-athlete overlay using Recharts `RadarChart` + `PolarGrid`. Enables simultaneous cross-athlete comparison across all drill dimensions.
- **Grade badges:** Computed via `gradeFromPercentile()` from `src/lib/analytics.ts` — Elite (≥95th), Above Average (≥75th), Average (≥50th), Below Average (≥25th), Developmental.
- **B2B CSV export:** `generateArmsCSV()` in `src/lib/b2b-exports.ts` produces an ARMS-format export (college recruiting pipeline standard) with RFC 4180-compliant CSV escaping.

The `analytics.ts` module runs an independent implementation of the normalCDF and `AGGREGATE_NORMS` table (Gillen et al. 2019) used specifically by the Coach Portal leaderboard, separate from the full `src/lib/scoring/` engine. Both implementations use the same normative data source and the same A&S 26.2.17 approximation.

---

# 8. Native BLE Timing Package

**Source:** `packages/native-ble/`

A cross-platform C++ / Kotlin / Objective-C++ React Native module for sub-millisecond BLE timing gate integration.

## 8.1 C++ Layer

**`packages/native-ble/cpp/BLETimingBuffer.h` + `BLETimingBuffer.cpp`**

`TimingEvent` struct (112 bytes — one cache-line pair, trivially copyable):

| Field | Type | Purpose |
|---|---|---|
| `monotonic_ns` | `uint64_t` | Hardware monotonic timestamp (iOS: `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)`, Android: `SystemClock.uptimeNanos()` via JNI). Never `Date.now()` — JS clocks have GC-scheduling jitter |
| `raw_bytes[64]` | `uint8_t[]` | Raw BLE characteristic value, zero-padded. Decoding deferred to JS layer |
| `byte_count` | `size_t` | Actual bytes received in this notification |
| `chip_id[32]` | `char[]` | Null-terminated peripheral identifier (e.g., "FREELAP_A1B2C3") |

**Static assertions** verify `sizeof(TimingEvent) <= 128` and total buffer footprint `<= 128 KB`.

`BLETimingBuffer` is non-copyable, non-movable (owns `std::mutex` and `std::queue`). Thread-safety contract:
- `enqueue()` — called exclusively from the BLE native thread (CoreBluetooth dispatch queue / Gatt callback thread). Never blocks; returns `false` on overflow-drop.
- `flush()` — called exclusively from the JS thread via `CallInvoker::invokeAsync()` (iOS) / `ReactContext.runOnJSQueueThread()` (Android). Drains the queue atomically.

**Overflow-drop semantics:** `kMaxQueueDepth = 1000`. At combine scale (0.2 Hz per station), filling 1,000 slots takes ~5,000 seconds — physically unreachable. The ceiling exists only as a hard memory guard against pathological code paths. A blocked BLE delegate thread causes missed gate crossings, which is worse than a dropped event.

## 8.2 Platform Bridges

- **iOS:** `packages/native-ble/ios/CoreEliteBLEModule.mm` — Objective-C++ `CBCentralManager` integration
- **Android:** `packages/native-ble/android/src/main/java/com/coreelite/ble/BLETimingModule.kt` — `BluetoothGatt` API
- **TypeScript:** `packages/native-ble/src/NativeBLETimingModule.ts` — TurboModule spec (`TurboModuleRegistry.getEnforcing`); exposes `startScan()`, `stopScan()`, and `onTimingEvent()` event via the JSI bridge (no async bridge serialization overhead for timing-critical paths)
- **Podspec:** `packages/native-ble/CoreEliteBLE.podspec` — iOS CocoaPods integration

---

# 9. Enterprise & League Admin Portal

**Source:** `src/pages/enterprise/`, `src/pages/league-admin/`, `src/layouts/EnterpriseLayout.tsx`, `src/layouts/LeagueAdminLayout.tsx`

## 9.1 Enterprise Portal (`/enterprise/*`)

Unauthenticated marketing/sales surface for league commissioners and B2B buyers. Nested under `EnterpriseLayout` (React Router `<Outlet>`).

- `CommissionerOverview.tsx` — 4-stat grid (50+ simultaneous events, 10,000+ athletes, 4-gate validation, 100% data ownership), feature comparison matrix (offline-first, hierarchical governance, automated integrity)
- `TrustCenter.tsx` — compliance posture, data residency, security posture

## 9.2 League Admin Portal (`/league-admin/*`)

Full operational command center behind `RouteGuard(requireAdmin)`. Uses a fixed-sidebar `LeagueAdminLayout`.

| Route | Component | Purpose |
|---|---|---|
| `/league-admin/` | `LeagueDashboard.tsx` | Cross-event KPI summary |
| `/league-admin/events` | `EventHub.tsx` | Multi-event lifecycle management |
| `/league-admin/staff-access` | `StaffAccessManagement.tsx` | Role-gated staff provisioning |
| `/league-admin/compliance` | `ComplianceAuditViewer.tsx` | Read surface for `audit_log` with event and entity-type filters |
| `/league-admin/exports` | `B2BExports.tsx` | ARMS-format CSV export — queries `athletes` + `results`, builds best-attempt map per athlete per drill |

The ARMS export logic in `src/lib/b2b-exports.ts` (`generateArmsCSV()`) handles RFC 4180-compliant escaping (values containing commas, quotes, or newlines are double-quoted with internal quotes doubled).

---

# 10. Security & Compliance Layer

## 10.1 Row-Level Security

Migrations `010_security_hardening.sql` + `011_rate_limiting.sql` + `012_organizations.sql` establish least-privilege RLS on all core tables. Permissive legacy policies were dropped and replaced with explicit role-scoped policies. Staff can write results but cannot read arbitrary athlete rows across events.

## 10.2 Rate Limiting

`register_athlete_secure` enforces 5 registrations/`(event_id, parent_email)`/hour at the Postgres function layer — no client-side bypass possible. `claim_band_atomic` carries an explicit token expiry guard.

## 10.3 Input Sanitization (`feat(phase4)`)

PII fields in `StationMode.tsx` and `Register.tsx` strip HTML characters and trim whitespace before processing. Email is lowercased at normalization time in both client and RPC. Strict numeric guard in `StationMode.tsx` prevents non-numeric drill values from entering the outbox.

## 10.4 Audit Trail Immutability

As described in Pillar 6: `audit_log` rows are populated only by Postgres triggers. No client INSERT policy exists. The write surface is zero for application code.

## 10.5 AdminDiagnostics

`src/pages/AdminDiagnostics.tsx` (behind `RouteGuard(requireAdmin)`) provides:
- Critical column presence checks (`hlc_timestamp`, `attempt_number`, `voided` on results table)
- RPC existence validation (`submit_result_secure`, `register_athlete_secure`)
- Security Posture section with RLS policy enumeration

## 10.6 Duplicate Guard Migrations

- `migrations/014_duplicate_athlete_guard.sql` — initial DOB-based uniqueness guard
- `migrations/015_composite_uniqueness_guard.sql` — composite uniqueness on `(event_id, lower(first_name), lower(last_name), date_of_birth)`
- `migrations/016_tier1_data_hardening.sql` — adds functional unique index on email+name, DB-level CHECK constraints (defense-in-depth)

---

# 11. White-Label Theming

**Source:** `src/components/ThemeProvider.tsx`, `src/hooks/useOrganization.ts`, `src/lib/brand.ts`

`ThemeProvider` wraps the entire application (mounted at the root of `src/App.tsx`). It reads organization configuration via `useOrganization` and injects CSS custom properties onto `document.documentElement` — e.g., `--brand-primary`, `--brand-logo-url`. Organization logo is rendered on `Home.tsx`, `Register.tsx`, and `ParentPortal.tsx`. This enables complete event-day brand isolation for multi-tenant deployments without a rebuild or redeploy. Brand system constants (colors, logo, shield mark) are defined in `src/lib/brand.ts`.

---

# 12. System Integration Summary

```
Browser / PWA
│
├── React Router v7 (5 portal trees, lazy-loaded via React.lazy())
│     ├── RouteGuard (staff / requireAdmin role enforcement)
│     └── ThemeProvider (org-scoped CSS custom property injection)
│
├── useOfflineSync (src/hooks/useOfflineSync.ts)
│     ├── hlc.ts        — Kulkarni-Demirbas 2014, lexicographic sort format
│     ├── lww.ts        — add-biased LWW, deviceStatus strict LWW
│     └── offline.ts    — IndexedDB v4: outbox, cache, station_config, event_config
│
├── Scoring Engine (src/lib/scoring/)
│     ├── percentile.ts — A&S 26.2.17 normalCDF, direction-aware Z-score, norm lookup
│     ├── bes.ts        — weighted composite, normalization, BES bands, interpretation
│     ├── disparity.ts  — Morin 2015 GRF proxy, phase decomposition (Brown/Vescovi)
│     ├── validation.ts — 4-gate pipeline (false_start, physical_floor, max_threshold, extraordinary)
│     └── constants.ts  — Gillen 2019, McKay 2020 (OL stub), Pain & Hibbs 2007, Morin 2015
│
├── Supabase Client (src/lib/supabase.ts)
│     ├── submit_result_secure RPC — 2-gate pipeline, HLC meta, SUSPICIOUS_DUPLICATE
│     ├── register_athlete_secure v4 — 5-gate pipeline, COPPA-compliant errors
│     └── claim_band_atomic RPC — atomic wristband assignment with expiry guard
│
└── Native BLE Package (packages/native-ble/)
      ├── C++: BLETimingBuffer — mutex-guarded queue, 112-byte TimingEvent, overflow-drop
      ├── iOS: CoreEliteBLEModule.mm — CBCentralManager integration
      └── Android: BLETimingModule.kt — BluetoothGatt API

Supabase Postgres (source of truth)
│
├── 16 migrations (migrations/002–016 + add_override_pin_to_events.sql)
├── Postgres triggers: trg_result_audit, trg_result_void_audit (SECURITY DEFINER)
├── RLS: least-privilege on all core tables, org-scoped isolation
├── organizations table → multi-tenant row isolation
└── audit_log: admin-only SELECT, trigger-write-only

Future Sprint — PowerSync Service
└── WASM SQLite (OPFS) → bidirectional sync → service-worker upload queue
    ├── CoreEliteConnector (Sprint B)
    ├── event_data bucket (event_id-scoped, station tablets)
    └── admin_data bucket (org_id-scoped, coaches + admins)
```

---

## Architecture Documentation Index

| Document | Location |
|---|---|
| God Tier Framework (full spec) | `docs/architecture/Core_Elite_God_Tier_Framework.md.pdf` |
| God Tier Framework (markdown summary) | `docs/architecture/Core_Elite_God_Tier_Framework.md` |
| PowerSync migration spec | `docs/architecture/tech-spec-powersync.md` (also at repo root: `tech-spec-powersync.md`) |
| Tier-2 Engineering Corpus (BLE, normative data) | `docs/architecture/Core Elite — Tier-2 Deep Engineering Knowledge Corpus.md` |
| Tier-3 Execution Corpus (RF physics, C++ memory, Byzantine SQLite) | `docs/architecture/Core Elite — Tier-3 Execution Corpus  RF Physics, C++ Memory Limits & Byzantine SQLite.md` |
| AI Engineering Knowledge Corpus | `docs/architecture/Core Elite Football Combine App — AI Engineering Knowledge Corpus.md` |
| Legal & Compliance Spec | `docs/legal-compliance-spec.md` |
| 5-Phase Execution Prompts | `Core_Elite_5_Phase_Execution_Prompts.md` (repo root) |
| This audit document | `docs/architecture/Core_Elite_Combine_Technical_Audit_2026-04-09.md` |

---

*Code baseline: commit `57d26e8` — `feat: production sprint — B2B portal, compliance layer, ops hardening` — represents the final state of all five execution phases. This audit document was added in a subsequent documentation commit; see `git log --oneline docs/architecture/Core_Elite_Combine_Technical_Audit_2026-04-09.md` for the docs commit hash.*

*Repository: `https://github.com/DigitalBlueprint239/Core-Elite.git` | Branch: `main`*
