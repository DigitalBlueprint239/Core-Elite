# PowerSync Migration Plan
Core Elite Combine — Sync Engine Replacement
Architect: Kevin Jones | 2026-04-10

---

## 1. Verdict First

PowerSync CAN meet all requirements. A **hybrid model is required** for three
specific subsystems that PowerSync does not model natively. The hybrid is not a
workaround — it is an intentional partition of responsibilities.

**What is hybrid:**

| Subsystem | Owner | Why not pure PowerSync |
|---|---|---|
| HLC timestamp generation | Our code (`useSyncedWrite`) | PowerSync has no clock model |
| Suspicious duplicate / `pending_review` state | Our `outbox_meta` table | PowerSync retry = binary (retry / complete), not 3-state |
| Dead-letter queue | Our `outbox_meta` table | Same reason; PowerSync retries indefinitely |

Everything else moves cleanly to PowerSync with no capability gap.

---

## 2. Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  DEVICE (browser / React Native)                                             ║
║                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────┐   ║
║  │  React UI Layer                                                       │   ║
║  │                                                                       │   ║
║  │  StationMode.tsx / StationCapture.tsx                                 │   ║
║  │    ↓ calls                                                            │   ║
║  │  useSyncedWrite.writeResult()          ← tick() called HERE, once    │   ║
║  │    │                                                                  │   ║
║  │    ├─ INSERT INTO results (hlc_timestamp=tick())                      │   ║
║  │    └─ INSERT INTO outbox_meta (status='pending')                      │   ║
║  │                                                                       │   ║
║  │  useSync()  ← replaces useOfflineSync()                               │   ║
║  │    ├─ isOnline ← PowerSync status.connected                           │   ║
║  │    ├─ pendingCount ← SELECT COUNT(*) FROM outbox_meta                 │   ║
║  │    ├─ forceSync() → UPDATE outbox_meta SET status='pending'           │   ║
║  │    └─ resolveDuplicateChallenge() → UPDATE/DELETE local rows          │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║                │                                                             ║
║                ▼                                                             ║
║  ┌──────────────────────────────────────────────────────────────────────┐   ║
║  │  PowerSync SDK                                                        │   ║
║  │                                                                       │   ║
║  │  PowerSyncDatabase (SQLite)                                           │   ║
║  │  ┌──────────────┬──────────────┬──────────────┬────────────────────┐ │   ║
║  │  │ results      │ athletes     │ device_status│ outbox_meta (LOCAL) │ │   ║
║  │  │ bands        │ stations     │ audit_log    │ event_config (LOCAL)│ │   ║
║  │  └──────────────┴──────────────┴──────────────┴────────────────────┘ │   ║
║  │                                                                       │   ║
║  │  ps_crud (internal)  ← INSERT/UPDATE ops queued here automatically   │   ║
║  │                                                                       │   ║
║  │  UPLOAD PATH                          DOWNLOAD PATH                  │   ║
║  │  ps_crud → connector.uploadData()     sync stream → local SQLite     │   ║
║  │               │                                                       │   ║
║  │               ▼                                                       │   ║
║  │  CoreElitePowerSyncConnector                                          │   ║
║  │    ├─ results       → submit_result_secure()                         │   ║
║  │    ├─ device_status → upsert_device_status_hlc()                     │   ║
║  │    └─ audit_log     → supabase.from('audit_log').insert()            │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║                │                              ↑                             ║
║                │  WebSocket / HTTP            │  HTTP streaming             ║
╚══════════════════════════════════════════════════════════════════════════════╝
                 │                              │
                 ▼                              │
╔══════════════════════════════════════════════════════════════════════════════╗
║  PowerSync Service (hosted)                                                  ║
║                                                                              ║
║  Receives JWT from fetchCredentials()                                        ║
║  Validates against Supabase                                                  ║
║  Evaluates sync-rules.yaml → scopes data per event_id / role                ║
║  Streams changes to device via WebSocket                                     ║
╚══════════════════════════════════════════════════════════════════════════════╝
                 │                              │
                 ▼                              │
╔══════════════════════════════════════════════════════════════════════════════╗
║  Supabase (PostgreSQL)                                                       ║
║                                                                              ║
║  SECURITY DEFINER RPCs (unchanged):                                          ║
║  ┌──────────────────────────────────────────────────────────────────────┐   ║
║  │ submit_result_secure()       Gate 0: auth check                      │   ║
║  │                              Gate 1: idempotency (client_result_id)  │   ║
║  │                              Gate 2: suspicious duplicate detection  │   ║
║  │                              Write:  INSERT with hlc_timestamp       │   ║
║  │                                                                       │   ║
║  │ upsert_device_status_hlc()   HLC guard: only write if incoming > cur │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║                                                                              ║
║  Tables (unchanged): results, athletes, bands, stations, device_status,      ║
║                       audit_log, events, profiles, waivers                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

**HLC flow (unchanged, different entry point):**

```
Before:  addToOutbox() calls tick() → stored in OutboxItem.hlc_timestamp
After:   useSyncedWrite.writeResult() calls tick() → stored in results.hlc_timestamp

Both:    connector/useOfflineSync reads hlc_timestamp → passes to RPC
         RPC receives it → stored in results.hlc_timestamp (Postgres)
         On sync success: updateHlc(hlc_timestamp) advances local clock
```

---

## 3. What Gets Replaced vs Retained

### REPLACED — delete these after migration is stable

| Old | Replacement | Notes |
|---|---|---|
| `src/lib/offline.ts` — `initDB`, `openDB` | PowerSync SQLite | Automatic setup |
| `OutboxItem` IndexedDB store | `ps_crud` (internal) + `outbox_meta` (ours) | `outbox_meta` only tracks extended states |
| `addToOutbox()` | `useSyncedWrite.writeResult()` | tick() still called here |
| `removeFromOutbox()` | Automatic on `tx.complete()` | PowerSync owns this |
| `updateOutboxItem()` | `db.execute('UPDATE outbox_meta ...')` | Only for status/retry tracking |
| `getSyncableOutboxItems()` | `connector.uploadData()` | PowerSync calls this automatically |
| `athlete_cache` IndexedDB store | `athletes` PowerSync SQLite table | Watch-query replaces cache lookup |
| `station_config` queue store | PowerSync SQLite `station_config` key | Local-only table |
| `useOfflineSync` hook | `useSync` hook | Same return shape |
| `setInterval(syncOutbox, 30000)` | PowerSync automatic reconnect | No polling needed |
| `window.addEventListener('online')` | PowerSync status events | Handled internally |
| Exponential backoff arithmetic | `backoffMs()` in connector | Same logic, different location |

### RETAINED — these do not change

| Component | Why retained |
|---|---|
| `src/lib/hlc.ts` | HLC is ours; PowerSync has no clock model |
| `src/lib/lww.ts` | Conflict resolution logic; called server-side |
| `submit_result_secure` RPC | All 4 gates stay intact; connector calls it identically |
| `upsert_device_status_hlc` RPC | HLC guard stays on Postgres; connector calls it identically |
| All migrations (001–017) | Schema is unchanged; PowerSync reads the same tables |
| `validateResult()` / `DRILL_CATALOG` | Client-side validation unchanged |
| `resolveDuplicateChallenge` flow | Operator workflow unchanged; new implementation in `useSync` |
| `event_config` store | Renamed to local-only PowerSync table (no API change) |
| Dead-letter + force-retry | Semantics identical; backed by `outbox_meta` instead of IndexedDB |

---

## 4. HLC Compatibility Analysis

### The Core Requirement
PowerSync must not break deterministic conflict resolution. This means:

1. HLC timestamps must be generated **before** the local write
2. The same timestamp must reach the server — no regeneration in the connector
3. On successful sync, the local clock must advance (receive-event rule)
4. On pull (download), received HLC values must advance the local clock

### How This Is Satisfied

**Point 1 + 2:** `useSyncedWrite.writeResult()` calls `tick()` once, stores the result
in `results.hlc_timestamp` (local SQLite). The connector reads it back from
`opData.hlc_timestamp` — no second `tick()` call anywhere.

**Point 3:** Connector calls `updateHlc(opData.hlc_timestamp)` after confirmed
server write. Unchanged from current `useOfflineSync` behavior.

**Point 4 (new):** PowerSync streams results from other devices via the sync
rules. Each received result row contains `hlc_timestamp`. A `watchQuery` on
the `results` table can call `update(row.hlc_timestamp)` to advance the local
clock when receiving remote writes.

```typescript
// Add to useSyncedWrite or a dedicated usePullHLCSync hook:
db.watch('SELECT hlc_timestamp FROM results ORDER BY hlc_timestamp DESC LIMIT 1',
  [], { onResult: (rows) => {
    if (rows[0]?.hlc_timestamp) updateHlc(rows[0].hlc_timestamp);
  }}
);
```

This is the receive-event rule applied to the pull path — currently absent
in `useOfflineSync` because the pull path does not exist yet (web app is
push-only today). PowerSync makes this trivial to add.

---

## 5. Migration Procedure

### Phase 0 — Prerequisites (no code changes)
1. Deploy PowerSync service, configure Supabase connection
2. Upload `sync-rules.yaml` to PowerSync dashboard
3. Add `VITE_POWERSYNC_URL` to `.env`
4. Add `event_id` and `role` claims to Supabase JWT (auth hook or claims table)

### Phase 1 — Schema migration (additive only)
No new Postgres migrations needed. The PowerSync schema (`schema.ts`) maps to
existing tables. The `outbox_meta` and `event_config` tables are `localOnly`
— they live only in device SQLite.

### Phase 2 — Parallel run
Add PowerSync SDK but keep `useOfflineSync` active. Both write to Supabase.
Gate behind feature flag: `VITE_ENABLE_POWERSYNC=true`.

Verification checklist:
- [ ] `npx vitest run` — 91 tests still pass
- [ ] 4-hour offline simulation: write 100+ results, reconnect, verify all reach Supabase
- [ ] Multi-device: two devices offline, different results, reconnect simultaneously
- [ ] Stale heartbeat rejection: queue heartbeat at t=100, send fresh at t=200, drain queue, verify t=200 wins
- [ ] Crash recovery: write 10 results, `kill -9` browser process, reopen, verify all sync

### Phase 3 — Cutover
1. Replace `useOfflineSync` with `useSync` at all call sites
2. Replace `addToOutbox()` with `useSyncedWrite.writeResult()` at all call sites
3. Remove `src/lib/offline.ts` IndexedDB initialization
4. Remove `getCachedAthlete` / `cacheAthlete` — replace with `db.get('SELECT ... FROM athletes WHERE band_id = ?')`

### Phase 4 — Cleanup
Remove all IndexedDB code. The `idb` package can be dropped from dependencies.

---

## 6. Failure Mode Analysis

### FM-1: 4-Hour Offline Event

**Scenario:** All devices go offline at event start. 100+ results accumulated.
Network returns after 4 hours.

| Layer | Behavior |
|---|---|
| Local SQLite (PowerSync) | All results written to `results` table. All in `ps_crud`. Both are SQLite files — survive browser close, device sleep, battery death with graceful shutdown |
| HLC timestamps | Each result has a unique HLC. No collisions possible (logical counter increments within same millisecond) |
| On reconnect | PowerSync detects connection, calls `uploadData` with batches from `ps_crud` |
| Server | `submit_result_secure` Gate 1 deduplicates any re-delivered items. Gate 2 fires for suspicious duplicates |
| Multi-device collision | Two devices record the same athlete at the same second. Both have distinct `client_result_id` values. Both pass Gate 1. Gate 2 detects if values are within 10% window → operator challenge |

**Verdict: PASS.** PowerSync ps_crud is more durable than our current IndexedDB
outbox because SQLite WAL mode survives hard crashes where IndexedDB transactions
may not flush.

---

### FM-2: Crash Mid-Upload (100 items, crash after item 47)

**Sequence:**
1. `uploadData` called with batch of 100 CrudEntries
2. Items 1–46 successfully uploaded, `outbox_meta` rows deleted
3. Process killed (OOM, battery pull, browser force-quit)
4. App restarts

**Recovery:**
- PowerSync calls `uploadData` again with the full original batch from `ps_crud`
- Items 1–46 hit Gate 1 (`client_result_id` already exists) → `success/duplicate` → drained
- Items 47–100 upload normally
- `outbox_meta` rows for 1–46 were deleted before crash — recreated? No, they don't exist; connector deletes them only on success, which happened before crash. On restart `outbox_meta` rows 1–46 are already gone. PowerSync re-uploads them, server returns `duplicate`, connector deletes the non-existent `outbox_meta` row (no-op DELETE). Clean.

**Verdict: PASS.** Idempotency on `client_result_id` makes crash mid-upload fully safe.

---

### FM-3: Multi-Device Simultaneous Reconnect

**Scenario:** 3 devices (A, B, C) all offline for 2 hours. All reconnect
simultaneously. Each has ~30 results.

**For immutable results (timing records):**
- Each result has a unique `client_result_id` UUID
- Two devices recording the same athlete at the same drill → Gate 2 suspicious duplicate
- Gate 2 is advisory, not blocking — operator resolves via challenge modal
- HLC ordering is preserved: whichever HLC string is lexicographically greater
  is "later" — no coordinator needed

**For mutable device_status:**
- All 3 devices send heartbeats
- `upsert_device_status_hlc` enforces strict `>` — only the highest HLC wins
- Race condition: A arrives before B, B arrives before C, but C has the highest HLC
  → C's write wins regardless of arrival order
- Stale writes from A and B are rejected silently (`applied: false`), connector
  removes from queue → no ghost heartbeats

**Verdict: PASS.** This is the exact scenario HLC was designed for.

---

### FM-4: PowerSync Service Outage

**Scenario:** PowerSync cloud service is unreachable. Supabase is up.

**Impact:**
- Sync stream (DOWNLOAD) pauses — devices stop receiving new athlete registrations
  and results from other devices
- UPLOAD path is unaffected — connector calls Supabase RPCs directly, not through
  PowerSync service
- `status.connected` = false → `isOnline` = false in `useSync`
- Results continue to be captured locally; `ps_crud` accumulates
- When PowerSync service recovers, sync stream resumes; `uploadData` drains queue

**Verdict: PARTIAL PASS.** Upload (write) path is independent of PowerSync
service availability. Download (read) path pauses. For a combine event this is
acceptable: staff can still capture all results; the admin dashboard won't see
real-time updates until the service recovers. This is the same behavior as the
current system during a Supabase network outage.

---

### FM-5: 100+ Items in Dead-Letter

**Scenario:** Network is up but Supabase returns 500 errors for 30+ minutes.
All items exhaust retries (5 attempts each) and enter dead-letter.

**Current behavior (IndexedDB):** Dead-letter items are visible in the UI.
Operator can force-retry. On force-retry, `retry_count` resets to 0.

**PowerSync behavior:** `outbox_meta` rows in `dead_letter` state are skipped
by `connector.uploadData`. PowerSync continues calling `uploadData` on every
reconnect. The dead-letter items are always re-evaluatable:
- `forceSync()` resets `outbox_meta.status = 'pending'` and `retry_count = 0`
- On next `uploadData` call, items are retried
- `ps_crud` entries are never deleted by us — PowerSync owns that, and only
  deletes them when `tx.complete()` is called after ALL items in the batch
  complete

**Wait — a subtle problem here:**  
PowerSync's `getCrudBatch()` returns ALL pending ps_crud entries. If dead-letter
items block the batch from completing (because we return without throwing and
without completing), the batch never drains. This would prevent LATER items from
being processed.

**Fix (already in connector.ts):** Dead-letter items do NOT throw and do NOT block
`tx.complete()`. The batch completes; `ps_crud` considers those items done from
its perspective. The `outbox_meta` row stays in `dead_letter` to surface the UI
alert. This is correct: PowerSync's job (persist and retry) is done; the
application's job (surface the failure and allow operator action) is done by
`outbox_meta`.

**Important nuance:** Because `tx.complete()` is called, PowerSync will NOT
re-attempt those specific `ps_crud` entries. The `outbox_meta` row is the only
persistent record of the failure. When the operator calls `forceSync()`, the
implementation must re-INSERT the local row (triggering a new ps_crud entry)
rather than just updating `outbox_meta`. This requires a small change to the
`forceSync` implementation:

```typescript
// In forceSync() — re-INSERT the result row to generate a new ps_crud entry:
const row = await db.getOptional('SELECT * FROM results WHERE id = ?', [id]);
if (row) {
  await db.execute('DELETE FROM results WHERE id = ?', [id]);
  await db.execute('INSERT INTO results ... VALUES ...', [...row values...]);
  // This DELETE+INSERT generates two ps_crud entries (DELETE, then PUT)
  // which is safe because submit_result_secure handles the duplicate client_result_id
}
```

This is the only non-trivial implementation change required for dead-letter recovery.

**Verdict: PASS with the re-INSERT pattern.** The standard UPDATE-only pattern
is insufficient for PowerSync dead-letter recovery.

---

### FM-6: Clock Skew Between Devices at Reconnect

**Scenario:** Device A's clock is 500ms behind real time. Device B's is accurate.
Both record the same athlete at drill "40-yard-dash". A's clock shows t=5000,
B's clock shows t=5500.

**HLC resolution (unchanged from current system):**
- B's result: HLC `0001750000005500_0000000000_device-b` 
- A's result: HLC `0001750000005000_0000000000_device-a`
- B's HLC is lexicographically greater → B's is "later"
- Both are immutable results with distinct `client_result_id` → both stored
- For display, the result with the higher HLC is sorted first
- `deviceStatusShouldUpdate` for device_status uses strict `>` → B's heartbeat wins

**After A receives B's result via PowerSync pull:**
- `update(B.hlc_timestamp)` advances A's local clock to t≥5500
- A's next write will have pt=5500 or higher, l=1+ — now causally after B
- The 500ms skew is healed after one sync cycle

**Verdict: PASS.** This is the documented behavior of HLC (v2 §3.1.2).

---

## 7. Dependency Changes

```diff
  package.json:
+ "@powersync/web": "^1.x"          (or @powersync/react-native for RN)
+ "@powersync/react": "^1.x"
- "idb": "^8.0.3"                   (remove after Phase 3 cutover)
```

No changes to Supabase dependencies. No changes to migrations. No RPC signature
changes.

---

## 8. Items NOT Deliverable via Pure PowerSync

For completeness — these require the hybrid approach documented above:

1. **HLC generation**: PowerSync has no clock model. `tick()` must be called
   in application code before every local write. This is by design and is
   actually safer than having a sync layer auto-stamp writes.

2. **`pending_review` (suspicious duplicate) state**: PowerSync's retry model
   is binary — either the upload succeeds or it retries. "Park and wait for
   human input" is not a concept PowerSync has. `outbox_meta` is the right
   place for this; it is a local-only SQLite table with no sync overhead.

3. **Dead-letter with re-INSERT recovery**: PowerSync considers a batch complete
   when `tx.complete()` is called. Re-queuing a failed item requires a DELETE +
   INSERT to generate a new `ps_crud` entry. This is a two-line pattern but it
   is not something PowerSync does for you.

4. **Per-item backoff**: PowerSync's retry schedule is configurable at the
   connector level but not per-item. Our `backoffMs()` function in the connector
   implements item-level backoff by checking `outbox_meta.last_attempt_at` and
   returning early. This is the correct approach.

These are all **solvable within PowerSync's model** — they just require code
in the connector and `outbox_meta`, not workarounds or external systems.
