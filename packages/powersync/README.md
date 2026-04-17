# @core-elite/powersync

> **Status: PLANNED — Not Yet Integrated**
>
> This package is scaffolded and fully authored but is **not imported anywhere
> in the production Vite/React web application.** Activating it requires
> deploying a PowerSync service instance, adding `VITE_POWERSYNC_URL` to `.env`,
> and executing a three-phase cutover (see `MIGRATION_PLAN.md`). The current
> production sync layer (`src/lib/offline.ts` + `src/hooks/useOfflineSync.ts`)
> remains active and unmodified.

---

## Purpose

`powersync` replaces the hand-rolled IndexedDB outbox (`src/lib/offline.ts`) with
the [PowerSync SDK](https://www.powersync.com/) — a production-grade, SQLite-backed
offline sync engine that provides:

- **Durability**: SQLite WAL survives hard crashes where IndexedDB transactions may not
- **Automatic retry**: PowerSync manages re-delivery scheduling; we only implement per-item logic
- **Pull sync**: devices receive results from other devices in real time (the current web app is push-only)
- **Crash recovery**: `client_result_id` idempotency on `submit_result_secure` makes re-delivery safe

### What Is Not Replaced

| Component | Why it stays |
|---|---|
| `src/lib/hlc.ts` | HLC is application logic; PowerSync has no clock model |
| `src/lib/lww.ts` | Conflict resolution is application logic |
| `submit_result_secure` RPC | All 4 gates unchanged; connector calls it identically |
| `upsert_device_status_hlc` RPC | HLC guard stays on Postgres |
| All migrations (001–023) | Postgres schema is unchanged |
| `validateResult()` / `DRILL_CATALOG` | Client-side gate logic unchanged |

---

## Architecture

```
React UI (StationMode.tsx / StationCapture.tsx)
    ↓  useSyncedWrite.writeResult()        ← tick() called ONCE here
    ↓  INSERT INTO results (local SQLite)
    ↓  INSERT INTO outbox_meta (local SQLite — extended states only)
         ↓
    PowerSync SDK (ps_crud internal queue)
         ↓  connector.uploadData()
    CoreElitePowerSyncConnector
         ├─ results        → submit_result_secure()
         ├─ device_status  → upsert_device_status_hlc()
         ├─ audit_log      → supabase.from('audit_log').insert()
         └─ capture_telemetry → upsert_capture_telemetry_lww()
                ↓
    Supabase (PostgreSQL)
```

The **hybrid model** is intentional: PowerSync handles delivery and retry;
`outbox_meta` handles the three states PowerSync cannot model natively:

| State | PowerSync | `outbox_meta` |
|---|---|---|
| Normal pending | `ps_crud` | — |
| Suspicious duplicate (operator decision required) | Cannot park | `pending_review` |
| Dead-letter (MAX_RETRIES exceeded) | Cannot surface | `dead_letter` |

---

## Contents

```
packages/powersync/
├── MIGRATION_PLAN.md    Full architecture diagram, FM analysis (6 failure modes), cutover steps
├── sync-rules.yaml      PowerSync data-scoping rules (event_id / role partitioning)
└── src/
    ├── connector.ts     CoreElitePowerSyncConnector (fetchCredentials + uploadData)
    ├── schema.ts        Local SQLite schema (synced + localOnly tables)
    ├── useSync.ts       Drop-in replacement for useOfflineSync (same return shape)
    └── useSyncState.ts  PowerSync connection state → isOnline / pendingCount
```

### `connector.ts`

Implements `PowerSyncBackendConnector`:
- `fetchCredentials()` — returns the Supabase session JWT for PowerSync authentication
- `uploadData()` — processes CRUD batches one item at a time (serial, not parallel) to preserve HLC causal ordering

Per-item logic: backoff, `pending_review` skip, dead-letter promotion, HLC clock advancement on confirmed write.

### `schema.ts`

Synced tables: `results`, `athletes`, `bands`, `stations`, `device_status`,
`audit_log`, `capture_telemetry`, `result_provenance`.

Local-only tables (never sent to Supabase):
- `outbox_meta` — extended delivery state (replaces `OutboxItem.status` in IndexedDB)
- `event_config` — device KV store (replaces `event_config` IndexedDB store; primary use: hashed override PIN cache)

### `sync-rules.yaml`

Scopes data per `event_id` and `role`:
- Staff devices receive only their event's athletes, bands, and stations
- Admin devices receive all tables for their event
- `capture_telemetry` and `result_provenance` are admin-only

---

## Migration Procedure Summary

See `MIGRATION_PLAN.md` for the full procedure including 6 failure mode analyses.

| Phase | Action | Risk |
|---|---|---|
| Phase 0 | Deploy PowerSync service, upload `sync-rules.yaml` | Infra only |
| Phase 1 | Add schema (additive — no Postgres migrations needed) | None |
| Phase 2 | Parallel run behind `VITE_ENABLE_POWERSYNC=true` flag | Zero user impact |
| Phase 3 | Replace `useOfflineSync` / `addToOutbox` call sites | Requires offline simulation testing |
| Phase 4 | Remove `src/lib/offline.ts` IndexedDB code, drop `idb` dependency | Cleanup |

---

## Dependency Changes (at cutover)

```diff
+ "@powersync/web": "^1.x"     (browser) or "@powersync/react-native": "^1.x" (RN)
+ "@powersync/react": "^1.x"
- "idb": "^8.0.3"              (remove after Phase 4)
```

No changes to `@supabase/supabase-js`, Vite config, or any migrations.

---

## Environment Variable Required

```env
VITE_POWERSYNC_URL=https://your-instance.powersync.journeyapps.com
```

Add to `.env` and `.env.example` before activating. The connector reads this
via `process.env.VITE_POWERSYNC_URL` in `fetchCredentials()`.
