# Tech Spec: PowerSync Offline-First Architecture & QR/NFC Zero-Touch Check-in
## Core Elite Combine 2026 — Engineering Sprint Reference

**Status:** Draft v1.0  
**Author:** Systems Architecture  
**Audience:** Lead engineers, infra team  
**Scope:** Web (Vite/React) primary target; React Native mobile path documented for future sprint

---

## 1. Executive Context

The current offline layer (`src/lib/offline.ts` + `src/hooks/useOfflineSync.ts`) is a hand-rolled IndexedDB outbox with exponential backoff and HLC-stamped conflict resolution. It works, but it carries three operational risks:

1. **No bidirectional sync.** The outbox is write-only. Live athlete data from other stations cannot be read while offline.
2. **Sync logic is coupled to React.** `useOfflineSync` is a hook — sync only runs when the component is mounted. A background tab or PWA crash loses the retry loop.
3. **No schema versioning guarantee.** `DB_VERSION` bumps in `offline.ts` are manual. Missing a migration in production causes silent data loss on upgrade.

PowerSync solves all three. It replaces the outbox with a persistent, bidirectional sync layer backed by a local SQLite database. Sync runs as a service worker, independent of component lifecycle.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Browser / PWA                       │
│                                                      │
│  React Components                                    │
│       │  usePowerSync() hook                         │
│       ▼                                              │
│  PowerSync Web Client (@powersync/web)               │
│       │  SQL queries (SELECT / INSERT / UPDATE)      │
│       ▼                                              │
│  WASM SQLite (wa-sqlite, persistent via OPFS)        │
│       │                                              │
│  ┌────┴──────────────────────────────────────────┐   │
│  │  Upload Queue (FIFO, durable, service-worker) │   │
│  │  Download Queue (streaming replication)       │   │
│  └────┬──────────────────────────────────────────┘   │
│       │  WebSocket (sync stream) + REST (upload)     │
└───────┼─────────────────────────────────────────────┘
        │
┌───────┼─────────────────────────────────────────────┐
│       ▼  PowerSync Service (self-hosted or cloud)    │
│  Sync Rules Engine                                   │
│       │  reads from Supabase Postgres (logical rep.) │
│       ▼                                              │
│  Supabase Postgres                                   │
│  (source of truth — RLS enforced)                    │
└─────────────────────────────────────────────────────┘
```

### Key packages

| Package | Role |
|---|---|
| `@powersync/web` | Web client — WASM SQLite, upload queue, sync stream |
| `@powersync/react` | `usePowerSync()`, `PowerSyncContext`, `useQuery()` hooks |
| `@powersync/supabase-connector` | Auth token bridge + upload connector for Supabase |
| `@journeyapps/wa-sqlite` | WASM SQLite engine (peer dep of `@powersync/web`) |

For a future **React Native** path, swap `@powersync/web` for `@powersync/react-native` + `@powersync/op-sqlite` (OP-SQLite is the native SQLite driver). The sync rules and schema are identical across platforms.

---

## 3. PowerSync Sync Rules

Sync rules are defined in `powersync.yaml` at the PowerSync Service layer. They control which rows are streamed to which authenticated client. The `token_parameters` object is populated from the Supabase JWT.

```yaml
# powersync.yaml
bucket_definitions:

  # Each event is its own sync bucket.
  # A station tablet only syncs rows for its assigned event.
  event_data:
    parameters:
      - name: event_id
        token_parameter: event_id   # claim injected into JWT by get_powersync_token RPC

    data:
      - table: events
        where: id = event_id

      - table: athletes
        where: event_id = event_id

      - table: bands
        where: event_id = event_id

      - table: results
        where: event_id = event_id
        # Only sync non-voided results to reduce payload
        # Voided rows are audit-only and do not need to reach station tablets
        # (coaches/admin portal gets a separate bucket — see admin_data below)

      - table: device_status
        where: event_id = event_id

  # Admin / Coach portal bucket — broader read access
  admin_data:
    parameters:
      - name: org_id
        token_parameter: org_id

    data:
      - table: organizations
        where: id = org_id

      - table: events
        where: org_id = org_id

      - table: athletes
        where: event_id IN (SELECT id FROM events WHERE org_id = org_id)

      - table: results
        # Admins see all results including voided
        where: event_id IN (SELECT id FROM events WHERE org_id = org_id)

      - table: audit_log
        where: event_id IN (SELECT id FROM events WHERE org_id = org_id)
```

### JWT claim injection

The Supabase `get_powersync_token` RPC (new — to be written in migration 016) reads the authenticated user's linked event and org from the `device_status` or `staff_assignments` table and injects claims:

```sql
CREATE OR REPLACE FUNCTION get_powersync_token()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_event_id UUID;
  v_org_id   UUID;
BEGIN
  SELECT s.event_id, e.org_id
  INTO   v_event_id, v_org_id
  FROM   device_status s
  JOIN   events e ON e.id = s.event_id
  WHERE  s.staff_id = auth.uid()
  LIMIT  1;

  RETURN jsonb_build_object(
    'event_id', v_event_id,
    'org_id',   v_org_id
  );
END;
$$;
```

---

## 4. Client-Side SQLite Schema

PowerSync maintains a local SQLite replica. The schema is declared in TypeScript and must mirror the Supabase tables (subset — only columns needed client-side).

```typescript
// src/lib/powersync-schema.ts
import { column, Schema, Table } from '@powersync/web';

const athletes = new Table({
  event_id:        column.text,
  first_name:      column.text,
  last_name:       column.text,
  position:        column.text,
  date_of_birth:   column.text,
  band_id:         column.text,   // FK — denormalized for fast QR lookup
  waiver_signed:   column.integer, // 0 | 1
  high_school:     column.text,
  grad_year:       column.text,
  height:          column.text,
  weight:          column.text,
});

const bands = new Table({
  event_id:        column.text,
  band_number:     column.integer,
  athlete_id:      column.text,
  status:          column.text,   // 'available' | 'assigned' | 'void'
});

const results = new Table({
  client_result_id: column.text,  // mirrors UUID — UNIQUE via PowerSync upload dedup
  event_id:         column.text,
  athlete_id:       column.text,
  band_id:          column.text,
  station_id:       column.text,
  drill_type:       column.text,
  value_num:        column.real,
  attempt_number:   column.integer,
  validation_status: column.text,
  voided:           column.integer, // 0 | 1
  recorded_at:      column.text,
  hlc_timestamp:    column.text,
  meta:             column.text,   // JSON string
});

const device_status = new Table({
  event_id:         column.text,
  station_id:       column.text,
  staff_id:         column.text,
  status:           column.text,
  pending_queue_count: column.integer,
  last_heartbeat:   column.text,
});

export const AppSchema = new Schema({
  athletes,
  bands,
  results,
  device_status,
});

export type Database = (typeof AppSchema)['types'];
```

---

## 5. Migration Path: Current Outbox → PowerSync Upload Queue

The current `src/lib/offline.ts` outbox will be **deprecated in phases**, not replaced in one cut. This allows us to ship PowerSync incrementally without a risky big-bang migration.

### Phase A — Parallel operation (Sprint 1)
- Install `@powersync/web`, `@powersync/react`, `@powersync/supabase-connector`
- Initialize `PowerSyncDatabase` in `src/lib/powersync.ts`
- Wire sync for **reads only**: athlete lookup on QR scan hits local SQLite instead of `supabase.from('athletes')`
- Outbox (`useOfflineSync`) continues to handle all writes unchanged
- Result: QR check-in speed improves immediately (local query vs network round-trip)

### Phase B — Write migration (Sprint 2)
- Implement `CoreEliteConnector` (extends `PowerSyncBackendConnector`)
- Override `uploadData(database)` to call `submit_result_secure` RPC with the same payload shape as the current outbox
- New result writes go to PowerSync's upload queue instead of the `idb` outbox
- Remove `addToOutbox`, `syncOutbox` for result writes
- Keep `audit_log` writes in the old outbox temporarily (audit_log has different RLS surface)

### Phase C — Full cutover (Sprint 3)
- Remove `src/lib/offline.ts` outbox entirely
- Remove `useOfflineSync` hook — replace with `usePowerSync()` + `useQuery()`
- Migrate `DuplicateChallenge` logic into the PowerSync connector's conflict handler
- Remove IndexedDB entirely — OPFS-backed SQLite is the sole local store

### Connector implementation skeleton

```typescript
// src/lib/powersync-connector.ts
import {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  CrudEntry,
  UpdateType,
} from '@powersync/web';
import { supabase } from './supabase';

export class CoreEliteConnector implements PowerSyncBackendConnector {
  async fetchCredentials() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    // Exchange Supabase JWT for a PowerSync token
    const { data: tokenData } = await supabase.rpc('get_powersync_token');

    return {
      endpoint: import.meta.env.VITE_POWERSYNC_URL,
      token: session.access_token,
      expiresAt: new Date(session.expires_at! * 1000),
      userClaims: tokenData,
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const batch = await database.getCrudBatch(200);
    if (!batch) return;

    for (const entry of batch.crud) {
      await this.processEntry(entry);
    }

    await batch.complete();
  }

  private async processEntry(entry: CrudEntry) {
    const { table, op, opData, id } = entry;

    if (table === 'results' && op === UpdateType.PUT) {
      // Route through the same RPC as the old outbox
      const { error, data } = await supabase.rpc('submit_result_secure', {
        p_client_result_id: id,
        p_event_id:         opData!.event_id,
        p_athlete_id:       opData!.athlete_id,
        p_band_id:          opData!.band_id,
        p_station_id:       opData!.station_id,
        p_drill_type:       opData!.drill_type,
        p_value_num:        opData!.value_num,
        p_attempt_number:   opData!.attempt_number ?? 1,
        p_meta:             JSON.parse(opData!.meta ?? '{}'),
      });

      if (data?.code === 'SUSPICIOUS_DUPLICATE') {
        // Emit event for UI to pick up — PowerSync connector runs off main thread
        window.dispatchEvent(new CustomEvent('core-elite:suspicious-duplicate', {
          detail: { ...data, itemId: id },
        }));
        // Do NOT throw — this prevents infinite retry. The item stays in the
        // queue in a 'pending_review' state managed by a local SQLite flag.
        return;
      }

      if (error || !data?.success) {
        throw new Error(error?.message ?? data?.error ?? 'RPC error');
      }
    }

    if (table === 'device_status' && op === UpdateType.PUT) {
      const { error } = await supabase.from('device_status').upsert(opData!);
      if (error) throw new Error(error.message);
    }
  }
}
```

---

## 6. Conflict Resolution Strategy

### Immutable results (primary concern)

Results rows are **append-only**. Once written, they are never edited (only voided). This makes conflict resolution trivial for the write path: the `client_result_id` UUID is the idempotency key. The same row arriving from two devices is a no-op at the database layer (`results_client_result_id_unique` constraint).

The only conflict that requires resolution is **suspicious duplicates** — two different UUIDs for the same athlete/drill/timewindow/value. This is handled at the application layer by the `SUSPICIOUS_DUPLICATE` RPC response and the Duplicate Record Challenge modal (already implemented in Phase 3).

### Athlete profile updates (edge case)

If two staff members edit the same athlete's profile offline simultaneously (e.g., correcting a misspelled name), the PowerSync connector uses **last-write-wins (LWW) at the row level**, keyed on `updated_at`. The connector should:

1. Read `updated_at` from the local row before submitting an update
2. Submit an `UPDATE ... WHERE id = ? AND updated_at = ?` (optimistic concurrency)
3. If the WHERE clause matches 0 rows (i.e., another write won), re-fetch and present a merge dialog

This is deferred to Sprint 3. For Sprint 1, athlete profile edits are admin-only from an online context, so the conflict surface is near-zero.

### HLC ordering preserved

The existing `hlc_timestamp` field on results rows carries forward into the PowerSync schema. The connector sets `hlc_timestamp` in `meta` on every write. PowerSync's `uploadData` FIFO ordering ensures records are uploaded in the order they were created on-device. Across devices, the HLC total order resolves any ordering ambiguity in the audit log.

---

## 7. QR/NFC Zero-Touch Check-in

### Goal

An athlete walks up to a timing station. The operator scans the QR code on their wristband. The athlete's name, position, and attempt history load in **under 3 seconds**, with zero keyboard input.

### 7.1 QR Code Encoding (Registration → Wristband)

At registration completion, a QR code is generated encoding a compact JSON payload:

```typescript
// Generated in src/pages/Register.tsx after successful register_athlete_secure call
interface BandQRPayload {
  v:  1;             // schema version — allows future migration without breaking scanners
  b:  string;        // band_id (UUID v4) — primary lookup key
  e:  string;        // event_id (UUID v4) — scoping guard
}

// Encode
const payload: BandQRPayload = { v: 1, b: bandId, e: eventId };
const qrData = btoa(JSON.stringify(payload));  // base64 — stays within QR capacity
```

The wristband QR is rendered using the existing `qrcode` or `html5-qrcode` library at print time. Use error correction level **M** (15% recovery) — sufficient for wristband surface, more robust than L under scanner glare.

**QR size target:** 200×200px print minimum. At this size, a standard smartphone camera resolves it reliably at 15–30cm.

### 7.2 Scan Flow (Station Tablet)

```
Operator taps "Scan Wristband"
        │
        ▼
Html5QrCodeScanner opens (rear camera, continuous mode)
        │  onScanSuccess fires
        ▼
parseQRPayload(rawText: string): BandQRPayload | null
  └── try: JSON.parse(atob(rawText))
  └── validate: v === 1, b is UUID format, e matches station.event_id
  └── return null on any parse failure (silent — scanner keeps running)
        │  valid payload
        ▼
LOCAL SQLite query (PowerSync — no network):
  SELECT a.*, b.band_number, b.status
  FROM   athletes a
  JOIN   bands b ON b.athlete_id = a.id
  WHERE  b.id = ? AND b.event_id = ?
  LIMIT  1
        │  result in ~2ms (indexed, in-memory SQLite)
        ▼
If band.status === 'void':
  Show "VOID BAND — Issue replacement" alert (red)
  Return to scan state

If athlete found:
  Query existing attempts for this athlete/drill:
    SELECT attempt_number, value_num, validation_status
    FROM   results
    WHERE  athlete_id = ? AND drill_type = ? AND NOT voided
    ORDER  BY attempt_number ASC
  Set component state: { athlete, attempts, bandNumber }
  Close scanner
  Render "Ready to Record" state
        │
        ▼
Total time from scan to ready: < 300ms (local SQLite)
Perceived time including camera focus: 1.5–3s
```

### 7.3 Implementation — `parseQRPayload`

```typescript
// src/lib/qr.ts
export interface BandQRPayload {
  v: number;
  b: string;  // band_id
  e: string;  // event_id
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseQRPayload(raw: string, expectedEventId: string): BandQRPayload | null {
  try {
    const parsed = JSON.parse(atob(raw));
    if (
      parsed.v === 1 &&
      typeof parsed.b === 'string' && UUID_RE.test(parsed.b) &&
      typeof parsed.e === 'string' && UUID_RE.test(parsed.e) &&
      parsed.e === expectedEventId
    ) {
      return parsed as BandQRPayload;
    }
    return null;
  } catch {
    return null;
  }
}
```

### 7.4 Scanner Component Integration

`html5-qrcode` is already in `package.json`. The existing scan UI in `StationMode.tsx` calls `Html5QrcodeScanner`. The only change for PowerSync is replacing the `supabase.from('bands')` network call with a local SQLite query via `usePowerSync()`.

```typescript
// Current (network-dependent):
const { data } = await supabase.from('bands')
  .select('*, athletes(*)')
  .eq('id', bandId)
  .single();

// PowerSync replacement (local, offline-safe):
const db = usePowerSync();
const [{ athlete, band }] = await db.execute(`
  SELECT a.id, a.first_name, a.last_name, a.position,
         b.id AS band_id, b.band_number, b.status
  FROM   athletes a
  JOIN   bands b ON b.athlete_id = a.id
  WHERE  b.id = ? AND b.event_id = ?
`, [bandId, eventId]);
```

### 7.5 NFC Path (Future Sprint)

NFC wristbands encode the same `BandQRPayload` JSON in an **NDEF Text record**. The Web NFC API (`NDEFReader`) is available in Chrome on Android (no iOS support as of 2026). For iOS, a companion React Native app using the `react-native-nfc-manager` package is required.

```typescript
// Web NFC (Android Chrome only)
// src/lib/nfc.ts
export async function startNFCScan(
  onRead: (payload: BandQRPayload) => void,
  eventId: string,
) {
  if (!('NDEFReader' in window)) throw new Error('Web NFC not supported');

  const reader = new (window as any).NDEFReader();
  await reader.scan();

  reader.addEventListener('reading', ({ message }: any) => {
    for (const record of message.records) {
      if (record.recordType === 'text') {
        const decoder = new TextDecoder(record.encoding ?? 'utf-8');
        const text = decoder.decode(record.data);
        const payload = parseQRPayload(btoa(text), eventId);
        if (payload) onRead(payload);
      }
    }
  });

  return () => reader.abort?.();  // cleanup
}
```

**NFC vs QR decision:** QR is the primary check-in method for 2026. NFC is gated behind a hardware procurement decision (NFC wristbands cost ~$2.50/unit vs $0.15 for printed QR). The code path is identical once the payload is parsed.

---

## 8. Environment Variables

Add to `.env.local` (not `.env` — never commit tokens):

```bash
VITE_POWERSYNC_URL=https://your-instance.powersync.journeyapps.com
# For self-hosted: https://powersync.yourdomain.com
```

---

## 9. Performance Targets

| Operation | Current (network) | Target (PowerSync local) |
|---|---|---|
| QR scan → athlete loaded | 400–1200ms | < 100ms |
| Result submit (online) | 300–600ms | < 50ms (local write) + async upload |
| Result submit (offline) | Queued, no feedback lag | Identical — OPFS write is synchronous-feel |
| Full event resync after reconnect | N/A | < 5s for 500-athlete event |

---

## 10. Open Questions Before Sprint Start

1. **PowerSync hosting:** Cloud (journeyapps.com, $99/mo) vs self-hosted (Docker on Fly.io, ~$15/mo). Recommend cloud for 2026 event season; migrate to self-hosted post-Series A.
2. **OPFS availability:** Requires a cross-origin isolated context (`COOP: same-origin`, `COEP: require-corp` headers). Verify Vercel edge config supports these. Alternative: use `IndexedDB` as PowerSync storage backend (performance penalty ~3×, still acceptable).
3. **Migration 016:** The `get_powersync_token` RPC must be written and deployed before the connector can authenticate. Schedule alongside Sprint A.
4. **Legacy outbox drain:** On first PowerSync boot, any items still in the old IndexedDB outbox must be drained before the new upload queue takes over. Write a one-time `drainLegacyOutbox()` function that reads from IndexedDB and submits each item through the PowerSync connector.
