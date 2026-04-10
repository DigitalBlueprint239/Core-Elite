# Core Elite God Tier Framework
## Architecture Specification Summary

> **Document Class:** Systems Architecture Reference  
> **Audience:** Lead engineers, external technical auditors  
> **Status:** Production — reflects platform state as of Phase 5 completion  
> **Full specification:** [`docs/architecture/Core_Elite_God_Tier_Framework.md.pdf`](Core_Elite_God_Tier_Framework.md.pdf) (in this directory)

---

## Overview

The God Tier Framework is the internal engineering specification that governs the Core Elite Combine Platform's architecture across all five execution phases. It defines the seven foundational pillars that every engineering decision in the platform must satisfy.

This markdown document provides an auditor-accessible summary. The full specification — including BLE physics calculations, normative data sourcing methodology, Byzantine SQLite analysis, and RF timing constraints — is contained in the PDF alongside this file, as well as in the companion corpus documents:

- [`Core Elite — Tier-2 Deep Engineering Knowledge Corpus.md`](Core%20Elite%20%E2%80%94%20Tier-2%20Deep%20Engineering%20Knowledge%20Corpus.md)
- [`Core Elite — Tier-3 Execution Corpus  RF Physics, C++ Memory Limits & Byzantine SQLite.md`](<Core%20Elite%20%E2%80%94%20Tier-3%20Execution%20Corpus%20%20RF%20Physics%2C%20C%2B%2B%20Memory%20Limits%20%26%20Byzantine%20SQLite.md>)
- [`Core Elite Football Combine App — AI Engineering Knowledge Corpus.md`](Core%20Elite%20Football%20Combine%20App%20%E2%80%94%20AI%20Engineering%20Knowledge%20Corpus.md)

---

## The Seven Architecture Pillars

Each pillar maps directly to implemented source files. File paths are relative to the repository root.

---

### Pillar 1 — Offline-First Data Sovereignty

**Principle:** Zero data loss regardless of network state. Every timing result is durably persisted locally before any network I/O is attempted.

**Implementation:**
- `src/lib/offline.ts` — IndexedDB v4 schema (`core_elite_combine_db`)
  - Stores: `outbox`, `athlete_cache`, `station_config`, `event_config`
  - Versioned `upgrade()` callbacks for non-destructive schema migration
- `src/hooks/useOfflineSync.ts` — Outbox dispatch loop with exponential backoff, dead-letter handling, and suspicious-duplicate challenge protocol
- `src/components/SyncIndicator.tsx` — Real-time queue depth indicator overlaid on all portal routes

**Forward path:** `docs/architecture/tech-spec-powersync.md` — three-sprint migration to `@powersync/web` (WASM SQLite + OPFS + service-worker upload queue, bidirectional sync)

---

### Pillar 2 — Hybrid Logical Clock (HLC) Timestamping

**Principle:** Deterministic total order of events across distributed devices without a coordinator. Wall clock (`Date.now()`) is used only for elapsed-time math, never for event ordering.

**Implementation:**
- `src/lib/hlc.ts` — Kulkarni & Demirbas 2014 algorithm
  - `tick()` — generate a new HLC timestamp for a local write
  - `update(remoteHlcStr)` — advance local clock after receiving a remote HLC (receive-event rule)
  - Wire format: `{pt:016d}_{l:010d}_{nodeId}` — lexicographically sortable without a custom comparator
  - State persisted to `localStorage` — clock survives page reloads
- `migrations/007_phase2_hlc_timestamp.sql` — promotes `hlc_timestamp` to a first-class column on the `results` table
- `migrations/009_phase2_covering_indexes.sql` — composite covering indexes that include `hlc_timestamp` for ordered audit queries

---

### Pillar 3 — Add-Biased Last-Write-Wins (LWW) Conflict Resolution

**Principle:** When `max_t(add) >= max_t(remove)`, preserve the record. A tie resolves in favor of keeping data — never silently discard a timing result.

**Implementation:**
- `src/lib/lww.ts`
  - `addBiasedShouldKeep(addHlc, removeHlc)` — `>=` comparison; tie favors the add operation
  - `lwwShouldReplace(existingHlc, incomingHlc)` — strict `>` for mutable record replacement
  - `resolvePayloadConflict<T>()` — generic outbox-level conflict resolution
  - `deviceStatusShouldUpdate()` — strict `>` for `device_status` upserts (the only mutable domain record)
- Server alignment: `submit_result_secure` RPC treats duplicate `client_result_id` as success — add-biased at the Postgres layer

---

### Pillar 4 — Multi-Gate RPC Security Pipeline

**Principle:** All mutations to athlete data pass through a multi-gate validation pipeline at the database function layer. No client-side bypass is possible. `SQLERRM` is never returned to the caller.

**Implementation — Registration:**
- `migrations/016_tier1_data_hardening.sql` — `register_athlete_secure` v4 (5 gates)
  1. Input normalization + zero-DB-I/O validation (name, email regex, phone, DOB, position)
  2. Event status validation (`active` | `draft`)
  3. Age range gate (10–19 via `EXTRACT(YEAR FROM AGE(...))`)
  4. Rate limiting (5 registrations/email/hour)
  5. Duplicate athlete check (name + DOB exact match, COPPA-safe error message)
- DB-layer safety net: `CHECK` constraints on `date_of_birth` and `parent_email`; functional unique index on `(event_id, lower(parent_email), lower(first_name), lower(last_name))`

**Implementation — Result submission:**
- `migrations/010_security_hardening.sql` — `submit_result_secure` RPC
  - Gate 1: `client_result_id` idempotency check
  - Gate 2: suspicious duplicate detection (same athlete/drill/timewindow/value from a different UUID)
  - Write phase: appends immutable result row with `attempt_number`, `hlc_timestamp`, `validation_status`

---

### Pillar 5 — Biomechanical Intelligence Engine (BES)

**Principle:** Synthesize drill measurements into a single 0–100 composite score using peer-reviewed normative data, direction-aware Z-score percentiles, and a mechanical disparity penalty grounded in ground reaction force physics.

**Implementation:**
- `src/lib/scoring/constants.ts` — all normative data with primary source citations (Gillen et al. 2019 PMC6355118, McKay et al. 2020 PMID 30418328, Pain & Hibbs 2007 PMID 17127583, Morin et al. 2015)
- `src/lib/scoring/percentile.ts` — Abramowitz & Stegun 26.2.17 normalCDF (max error ≤ 7.5 × 10⁻⁸), direction-aware Z-score, normative lookup priority chain
- `src/lib/scoring/disparity.ts` — mechanical disparity detection (Morin 2015 GRF ratio proxy), phase-based 40-yard decomposition (Brown/Vescovi/VanHeest three-phase model)
- `src/lib/scoring/bes.ts` — weighted composite formula, weight normalization for partial data, BES band classification, one-sentence coaching interpretation
- `src/lib/scoring/validation.ts` — 4-gate pipeline: `false_start` → `below_physical_floor` → `above_max_threshold` → `extraordinary_result`
- `src/lib/analytics.ts` — parallel implementation used by the Coach Portal leaderboard

---

### Pillar 6 — Immutable Audit Trail

**Principle:** Every mutation to a timing result is automatically logged by the database, not by the client. No application code can suppress an audit entry.

**Implementation:**
- `migrations/013_audit_log.sql`
  - `audit_log` table — append-only, admin-only SELECT via RLS
  - `trg_result_audit` — `AFTER INSERT ON results` trigger: auto-logs every result submission
  - `trg_result_void_audit` — `AFTER UPDATE ON results` trigger: fires when `voided` transitions to `true`
  - Both triggers run as `SECURITY DEFINER` — bypass client RLS; no direct INSERT policy exists
  - 3 covering indexes: `(event_id)`, `(entity_type, entity_id)`, `(user_id)`
- `src/pages/admin-ops/AuditTab.tsx` — admin-facing read surface
- `src/pages/league-admin/ComplianceAuditViewer.tsx` — league admin read surface with event and entity-type filters

---

### Pillar 7 — Multi-Tenant Organization Layer

**Principle:** Each organization's data is row-level isolated from every other organization. A station tablet for Organization A can never read Organization B's athletes, even if both are on the same network.

**Implementation:**
- `migrations/012_organizations.sql` — `organizations` table, org-scoped RLS policies on all core tables
- `src/hooks/useOrganization.ts` — React hook exposing the active org context
- `src/components/ThemeProvider.tsx` — reads org config and injects CSS custom properties for white-label event-day branding
- RLS policies on `athletes`, `bands`, `results`, `device_status`, `waivers`, `token_claims` all enforce `org_id` scoping

---

## Validation / 4-Gate Pipeline Detail

The BES validation pipeline in `src/lib/scoring/validation.ts` references the following gate thresholds (from `src/lib/scoring/constants.ts`):

| Drill | Physical Floor (Gate 2) | Max Threshold (Gate 3) | Extraordinary Floor (Gate 4) |
|---|---|---|---|
| 40-yard dash | < 3.50s | > 9.00s | < 4.21s |
| 10-yard split | < 1.40s | > 3.00s | < 1.50s |
| 5-10-5 shuttle | < 3.50s | > 8.00s | < 3.73s |
| Vertical jump | < 5 in | > 65 in | > 46 in |
| Broad jump | < 24 in | > 160 in | > 130 in |

Gate 1 (false start): reaction time < 120ms — Pain & Hibbs 2007 (PMID 17127583). Applies to timed sprint/agility drills only.

---

## Normative Data Status

| Source | Population | Scope | Implementation Status |
|---|---|---|---|
| Gillen et al. 2019 (PMC6355118) | n=7,214 | All-position aggregate | Fully implemented — always available as fallback |
| McKay et al. 2020 (PMID 30418328) | n=7,478 | Position × grade | Stub: OL/forty only (sd estimated). All other positions TODO. |

---

*This summary reflects the platform state as of the Phase 5 production sprint (commit `57d26e8`). The authoritative specification is the PDF in this directory.*
