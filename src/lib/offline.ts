import { openDB } from 'idb';

const DB_NAME = 'core_elite_combine_db';
// Bumped from 1 to 2 to add the 'status' index on the outbox store.
const DB_VERSION = 2;

// ---------------------------------------------------------------------------
// Retry governance constants
// ---------------------------------------------------------------------------
export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 5_000;   // 5 s
export const MAX_DELAY_MS = 300_000;  // 5 min

/**
 * Compute the timestamp (ms since epoch) at which the next retry should be
 * attempted, using capped exponential backoff.
 *
 *   delay = min(BASE_DELAY_MS * 2^retryCount, MAX_DELAY_MS)
 */
export function computeNextRetryAt(retryCount: number): number {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  return Date.now() + delay;
}

// ---------------------------------------------------------------------------
// OutboxItem -- extended schema (DB_VERSION 2)
// ---------------------------------------------------------------------------
export type OutboxStatus = 'pending' | 'retrying' | 'dead_letter' | 'synced';

export interface OutboxItem {
  /** Stable client-generated ID (client_result_id for results, station key for
   *  device_status).  Used as the IDB keyPath -- put() is therefore idempotent. */
  id: string;
  type: 'result' | 'device_status';
  payload: any;
  /** Unix ms timestamp when the item was first created. */
  timestamp: number;
  /** Total number of sync attempts made so far (including the current one). */
  retry_count: number;
  /** Unix ms timestamp of the most recent sync attempt, or null if never tried. */
  last_attempt_at: number | null;
  /** Unix ms timestamp before which the item must NOT be retried. */
  next_retry_at: number | null;
  /** Most recent error message from a failed attempt. Dev-only display. */
  error_message: string | null;
  /** Lifecycle status of this item. */
  status: OutboxStatus;
}

export interface AthleteCache {
  band_id: string;
  athlete_id: string;
  display_number: number;
  name: string;
  position?: string;
}

// ---------------------------------------------------------------------------
// IndexedDB initialisation
// ---------------------------------------------------------------------------
export async function initDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'id' });
        store.createIndex('by_status', 'status');
      } else if (oldVersion < 2) {
        const tx = db.transaction('outbox', 'readwrite');
        const existingStore = tx.objectStore('outbox');
        if (!existingStore.indexNames.contains('by_status')) {
          existingStore.createIndex('by_status', 'status');
        }
      }
      if (!db.objectStoreNames.contains('athlete_cache')) {
        db.createObjectStore('athlete_cache', { keyPath: 'band_id' });
      }
      if (!db.objectStoreNames.contains('station_config')) {
        db.createObjectStore('station_config', { keyPath: 'id' });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Outbox CRUD
// ---------------------------------------------------------------------------

/**
 * Add or replace an item in the outbox.  Uses db.put() so calling this with
 * the same id is safe -- it overwrites rather than duplicates.
 * New items are created with sensible defaults for all v2 fields.
 */
export async function addToOutbox(
  item: Omit<OutboxItem, 'retry_count' | 'last_attempt_at' | 'next_retry_at' | 'error_message' | 'status'>
    & Partial<Pick<OutboxItem, 'retry_count' | 'last_attempt_at' | 'next_retry_at' | 'error_message' | 'status'>>
): Promise<void> {
  const db = await initDB();
  const full: OutboxItem = {
    retry_count: 0,
    last_attempt_at: null,
    next_retry_at: null,
    error_message: null,
    status: 'pending',
    ...item,
  };
  await db.put('outbox', full);
}

/**
 * Retrieve all items eligible for a sync attempt right now:
 * status is 'pending' or 'retrying' AND next_retry_at is null or in the past.
 */
export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  const all: OutboxItem[] = await db.getAll('outbox');
  const now = Date.now();
  return all.filter(
    (item) =>
      (item.status === 'pending' || item.status === 'retrying') &&
      (item.next_retry_at === null || item.next_retry_at <= now),
  );
}

/**
 * Retrieve ALL items regardless of status -- used by diagnostics hooks.
 */
export async function getAllOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  return db.getAll('outbox');
}

/**
 * Partially update a queued item (e.g. after a failed attempt).
 */
export async function updateOutboxItem(
  id: string,
  updates: Partial<Omit<OutboxItem, 'id'>>,
): Promise<void> {
  const db = await initDB();
  const existing = await db.get('outbox', id);
  if (!existing) return;
  await db.put('outbox', { ...existing, ...updates });
}

export async function removeFromOutbox(id: string): Promise<void> {
  const db = await initDB();
  await db.delete('outbox', id);
}

/**
 * For device_status items: collapse any existing queued item for the same
 * station/device key into a single entry with the latest payload.
 * This prevents heartbeat spam from filling the outbox while offline.
 * Callers must use a stable key such as device_status:${stationId}.
 */
export async function upsertDeviceStatusItem(stationId: string, payload: any): Promise<void> {
  const id = `device_status:${stationId}`;
  const db = await initDB();
  const existing = await db.get('outbox', id);

  if (existing && (existing.status === 'pending' || existing.status === 'retrying')) {
    await db.put('outbox', {
      ...existing,
      payload,
      timestamp: Date.now(),
    });
  } else {
    await addToOutbox({
      id,
      type: 'device_status',
      payload,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Athlete cache helpers (unchanged)
// ---------------------------------------------------------------------------
export async function cacheAthlete(athlete: AthleteCache): Promise<void> {
  const db = await initDB();
  await db.put('athlete_cache', athlete);
}

export async function getCachedAthlete(bandId: string): Promise<AthleteCache | undefined> {
  const db = await initDB();
  return db.get('athlete_cache', bandId);
}

export async function clearAthleteCache(): Promise<void> {
  const db = await initDB();
  await db.clear('athlete_cache');
  }
