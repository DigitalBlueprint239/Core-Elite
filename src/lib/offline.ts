import { openDB, IDBPDatabase } from 'idb';
import { tick } from './hlc';
import type { SourceType } from './types';

export const DB_NAME = 'core_elite_combine_db';
// v5: adds compound `by_status_timestamp` index for FIFO sync polling.
//     Lets getSyncableOutboxItems() walk a bounded key range instead of
//     pulling every status partition into JS for an in-memory sort. Critical
//     when 3+ tablets reconnect simultaneously and the outbox holds 200+
//     items per device. Mission "Sync Lock Hardening".
export const DB_VERSION = 5;

// ── Sync batch sizing (Mission "Sync Lock Hardening") ──────────────────────
//
// Cap on items processed per outer batch in the sync loop. Three forces set
// this value:
//   - Supabase RPC timeout: ~30s → at ~150ms per RPC round-trip we have
//     ~200 calls of headroom; 50 keeps us at <8s per batch with a
//     comfortable margin.
//   - IndexedDB transaction lock: long-running syncs were holding the
//     outbox store open and blocking concurrent addToOutbox writes from
//     the StationMode capture path. 50-item chunks let the store breathe
//     between batches.
//   - Memory: 200+ outbox items × full payload + meta easily crosses 1MB
//     of resident JS heap on iPad mini. Chunking lets older arrays be
//     GC'd before the next batch is loaded.
export const OUTBOX_BATCH_SIZE = 50;

/**
 * chunkOutboxItems — pure split helper.
 *
 * Splits an item array into fixed-size chunks for the syncOutbox loop.
 * Generic over T so the caller can pass OutboxItem[] or any other
 * homogeneous array. Returns [] for an empty input. A `size <= 0`
 * argument falls back to a single chunk containing every item — defensive,
 * not silently misbehaving.
 *
 * Pure + framework-agnostic so the 200-item stress test can exercise it
 * directly without spinning up IndexedDB.
 */
export function chunkOutboxItems<T>(items: T[], size: number = OUTBOX_BATCH_SIZE): T[][] {
  if (items.length === 0) return [];
  if (size <= 0)          return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ── Outbox payload types ─────────────────────────────────────────────────────
//
// `OutboxItem` is a discriminated union by `type`. For `type: 'result'`, the
// payload mandates `source_type: SourceType` at compile time — there is no
// silent default inside addToOutbox(). Callers must supply it explicitly,
// per Mission "p_source_type" anti-pattern policy (no `any`, no defaults).

export interface ResultOutboxPayload {
  client_result_id: string;
  event_id:         string;
  athlete_id:       string;
  band_id:          string;
  station_id:       string;
  drill_type:       string;
  value_num:        number;
  attempt_number?:  number;
  meta?:            Record<string, unknown>;
  recorded_at?:     string;
  // Strict provenance discriminator. NOT optional. NEVER defaulted at the
  // outbox layer. Must be one of: 'manual' | 'live_ble' | 'imported_csv' | 'webhook'.
  source_type:      SourceType;
  // Forward compat — capture-flow extras (override metadata, scout-confirm
  // markers, etc.) flow through unchanged. Each field is unknown — caller
  // decides the cast.
  [extra: string]:  unknown;
}

// device_status / audit_log outbox payloads have no result-row source_type;
// they're typed structurally so useOfflineSync can pass them to their RPCs
// without unsafe casts. Provenance only applies to the 'result' variant.

export interface DeviceStatusOutboxPayload {
  event_id:             string;
  station_id:           string;
  device_label:         string;
  last_seen_at:         string;
  is_online:            boolean;
  pending_queue_count?: number;
  last_sync_at?:        string | null;
}

export interface AuditLogOutboxPayload {
  action:        string;
  entity_type:   string;
  entity_id:     string;
  event_id?:     string;
  // Audit log carries arbitrary before/after JSON snapshots — kept open as
  // unknown so callers don't need to widen every diff into a typed shape.
  old_value?:    unknown;
  new_value?:    unknown;
  // Forward-compat slot for additional structured fields.
  [extra: string]: unknown;
}

interface OutboxBase {
  id: string; // client_result_id or client_audit_id
  // Internal elapsed-time fields — used for backoff math only, NOT conflict resolution.
  // Date.now() is correct here: we are measuring duration, not ordering events.
  timestamp: number;
  attempts: number;
  retry_count: number;
  last_attempt_at?: number;
  error_message?: string;
  status: 'pending' | 'retrying' | 'dead_letter' | 'pending_review';
  // HLC timestamp for deterministic conflict resolution (v2 §3.1.3, v3 §3.1.2).
  // Format: "{pt:016d}_{l:010d}_{nodeId}" — lexicographically sortable.
  // Generated once at write time via tick(). Passed to the server in meta
  // so the server can apply add-biased LWW if the same record arrives from
  // multiple devices after an offline period.
  hlc_timestamp: string;
}

export type OutboxItem =
  | (OutboxBase & { type: 'result';        payload: ResultOutboxPayload        })
  | (OutboxBase & { type: 'device_status'; payload: DeviceStatusOutboxPayload  })
  | (OutboxBase & { type: 'audit_log';     payload: AuditLogOutboxPayload     });

export interface AthleteCache {
  band_id: string;
  athlete_id: string;
  display_number: number;
  name: string;
  position?: string;
}

export async function initDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // Version 1: initial stores
      if (oldVersion < 1) {
        db.createObjectStore('outbox', { keyPath: 'id' });
        db.createObjectStore('athlete_cache', { keyPath: 'band_id' });
        db.createObjectStore('station_config', { keyPath: 'id' });
      }
      // Version 2: add hlc_timestamp index to outbox for ordered sync queries
      if (oldVersion < 2) {
        const outboxStore = transaction.objectStore('outbox');
        outboxStore.createIndex('by_hlc', 'hlc_timestamp', { unique: false });
      }
      // Version 3: add status index for efficient pending/retrying queries
      // (idx_outbox_pending equivalent, v2 §3.3.3).
      if (oldVersion < 3) {
        const outboxStore = transaction.objectStore('outbox');
        outboxStore.createIndex('by_status', 'status', { unique: false });
      }
      // Version 4: add event_config store for offline-safe override PIN caching.
      // Keyed by a composite string: e.g. "override_pin:<event_id>".
      // All pin hash operations go through setEventConfig / getEventConfig below.
      if (oldVersion < 4) {
        db.createObjectStore('event_config', { keyPath: 'id' });
      }
      // Version 5: compound index on [status, timestamp] for FIFO polling.
      // The single-column by_status index returns every matching row at once;
      // the compound index lets us walk a bounded key range AND emerge in
      // timestamp order for free, eliminating the in-JS sort and the full
      // partition scan that broke under 3-tablet sync storms. Mission
      // "Sync Lock Hardening".
      if (oldVersion < 5) {
        const outboxStore = transaction.objectStore('outbox');
        outboxStore.createIndex('by_status_timestamp', ['status', 'timestamp'], { unique: false });
      }
    },
  });
}

// addToOutbox — discriminated by `type`. The TS compiler refuses to compile a
// 'result'-typed call without a `source_type` on the payload, so the caller
// MUST decide provenance explicitly (Mission "p_source_type" contract).
type AddToOutboxInput =
  | (Partial<OutboxBase> & { id: string; type: 'result';        payload: ResultOutboxPayload        })
  | (Partial<OutboxBase> & { id: string; type: 'device_status'; payload: DeviceStatusOutboxPayload  })
  | (Partial<OutboxBase> & { id: string; type: 'audit_log';     payload: AuditLogOutboxPayload     });

export async function addToOutbox(item: AddToOutboxInput): Promise<void> {
  const db = await initDB();
  const base = {
    timestamp: Date.now(),   // Internal only — elapsed-time / ordering within this device
    attempts: 0,
    retry_count: 0,
    status: 'pending' as const,
    // Generate HLC at enqueue time if the caller did not supply one.
    // tick() advances the logical counter, so the caller should generate the HLC once
    // and pass it in item.hlc_timestamp to avoid unnecessary counter increments.
    hlc_timestamp: tick(),
  };
  // Spread item LAST so caller-supplied values (especially hlc_timestamp)
  // override the synthesized defaults. The cast is safe — the union variant
  // is determined by `item.type`, which is preserved through the spread.
  const fullItem = { ...base, ...item } as OutboxItem;
  await db.put('outbox', fullItem);
}

export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  return db.getAll('outbox');
}

/**
 * Return only syncable (pending + retrying) outbox items, ordered FIFO
 * by timestamp within each status partition.
 *
 * Uses the v5 compound index `by_status_timestamp` ([status, timestamp]).
 * IDBKeyRange.bound walks a precise sub-tree — no full partition scan,
 * no JS-side sort required. Pending items come first (they have not been
 * tried yet); retrying items come second (they are paying backoff math
 * already). Within each status the order is timestamp-ASC, which matches
 * the FIFO contract the syncOutbox loop assumes.
 *
 * The Number.MAX_SAFE_INTEGER upper bound is safe because outbox.timestamp
 * is Date.now() — well below 2^53 for the next ~285,000 years.
 */
export async function getSyncableOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();

  const pendingRange  = IDBKeyRange.bound(['pending',  0], ['pending',  Number.MAX_SAFE_INTEGER]);
  const retryingRange = IDBKeyRange.bound(['retrying', 0], ['retrying', Number.MAX_SAFE_INTEGER]);

  const [pending, retrying] = await Promise.all([
    db.getAllFromIndex('outbox', 'by_status_timestamp', pendingRange),
    db.getAllFromIndex('outbox', 'by_status_timestamp', retryingRange),
  ]);

  // Pending first (never-tried), then retrying (already paying backoff).
  // Both sub-arrays arrive timestamp-ASC from the index.
  return [...pending, ...retrying];
}

export async function updateOutboxItem(item: OutboxItem) {
  const db = await initDB();
  await db.put('outbox', item);
}

export async function removeFromOutbox(id: string) {
  const db = await initDB();
  await db.delete('outbox', id);
}

export async function cacheAthlete(athlete: AthleteCache) {
  const db = await initDB();
  await db.put('athlete_cache', athlete);
}

export async function getCachedAthlete(bandId: string): Promise<AthleteCache | undefined> {
  const db = await initDB();
  return db.get('athlete_cache', bandId);
}

export async function clearAthleteCache() {
  const db = await initDB();
  await db.clear('athlete_cache');
}

export async function getDeadLetterItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  // Use the by_status index — no full-store scan needed
  return db.getAllFromIndex('outbox', 'by_status', 'dead_letter');
}

export async function resetDeadLetterItem(id: string) {
  const db = await initDB();
  const item = await db.get('outbox', id);
  if (!item) return;
  await db.put('outbox', {
    ...item,
    status: 'pending',
    retry_count: 0,
    attempts: 0,
    error_message: undefined,
    last_attempt_at: undefined
  });
}

// ---------------------------------------------------------------------------
// event_config store — generic key/value pairs scoped to an event.
// Primary use: caching the hashed admin override PIN for offline validation.
// ---------------------------------------------------------------------------

export interface EventConfigRecord {
  id: string;           // Composite key, e.g. "override_pin:<event_id>"
  [key: string]: unknown;
}

export async function setEventConfig(record: EventConfigRecord): Promise<void> {
  const db = await initDB();
  await db.put('event_config', record);
}

export async function getEventConfig(id: string): Promise<EventConfigRecord | undefined> {
  const db = await initDB();
  return db.get('event_config', id);
}

export async function deleteEventConfig(id: string): Promise<void> {
  const db = await initDB();
  await db.delete('event_config', id);
}

// ---------------------------------------------------------------------------
// station_config queue persistence — survive page refresh / browser crash.
// Keyed by "queue_<stationId>". The data field holds the raw queue array
// from StationMode state. Written on every queue mutation, read on mount.
// ---------------------------------------------------------------------------

export async function saveStationQueue(stationId: string, queue: unknown[]): Promise<void> {
  const db = await initDB();
  await db.put('station_config', { id: `queue_${stationId}`, data: queue });
}

export async function loadStationQueue(stationId: string): Promise<unknown[]> {
  const db = await initDB();
  const record = await db.get('station_config', `queue_${stationId}`);
  const data = (record?.data as unknown);
  return Array.isArray(data) ? data : [];
}
