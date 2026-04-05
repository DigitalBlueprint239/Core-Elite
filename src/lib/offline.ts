import { openDB, IDBPDatabase } from 'idb';
import { tick } from './hlc';

const DB_NAME = 'core_elite_combine_db';
const DB_VERSION = 3; // v3: adds by_status index to outbox (idx_outbox_pending, v2 §3.3.3)

export interface OutboxItem {
  id: string; // client_result_id
  type: 'result' | 'device_status';
  payload: any;
  // Internal elapsed-time fields — used for backoff math only, NOT conflict resolution.
  // Date.now() is correct here: we are measuring duration, not ordering events.
  timestamp: number;
  attempts: number;
  retry_count: number;
  last_attempt_at?: number;
  error_message?: string;
  status: 'pending' | 'retrying' | 'dead_letter';
  // HLC timestamp for deterministic conflict resolution (v2 §3.1.3, v3 §3.1.2).
  // Format: "{pt:016d}_{l:010d}_{nodeId}" — lexicographically sortable.
  // Generated once at write time via tick(). Passed to the server in meta
  // so the server can apply add-biased LWW if the same record arrives from
  // multiple devices after an offline period.
  hlc_timestamp: string;
}

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
      // Allows syncOutbox to use db.getAllFromIndex('outbox', 'by_status', ...)
      // instead of a full-store scan filtered in JS.
      if (oldVersion < 3) {
        const outboxStore = transaction.objectStore('outbox');
        outboxStore.createIndex('by_status', 'status', { unique: false });
      }
    },
  });
}

export async function addToOutbox(item: Partial<OutboxItem> & Pick<OutboxItem, 'id' | 'type' | 'payload'>) {
  const db = await initDB();
  const fullItem: OutboxItem = {
    timestamp: Date.now(),   // Internal only — elapsed-time / ordering within this device
    attempts: 0,
    retry_count: 0,
    status: 'pending',
    // Generate HLC at enqueue time if the caller did not supply one.
    // tick() advances the logical counter, so the caller should generate the HLC once
    // and pass it in item.hlc_timestamp to avoid unnecessary counter increments.
    hlc_timestamp: tick(),
    ...item,
  };
  await db.put('outbox', fullItem);
}

export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  return db.getAll('outbox');
}

/**
 * Return only syncable (pending + retrying) outbox items using the by_status
 * index added in DB version 3 (idx_outbox_pending, v2 §3.3.3).
 * Avoids the full-store scan + in-JS filter that syncOutbox was doing.
 */
export async function getSyncableOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  const [pending, retrying] = await Promise.all([
    db.getAllFromIndex('outbox', 'by_status', 'pending'),
    db.getAllFromIndex('outbox', 'by_status', 'retrying'),
  ]);
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
