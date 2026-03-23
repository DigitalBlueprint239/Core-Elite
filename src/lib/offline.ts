import { openDB } from 'idb';

const DB_NAME = 'core_elite_combine_db';
const DB_VERSION = 1;

export interface OutboxItem {
  id: string; // client_result_id or heartbeat id
  type: 'result' | 'device_status';
  payload: any;
  timestamp: number;
  attempts: number;
  status?: 'pending' | 'failed';
  last_error?: string | null;
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
    upgrade(db) {
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
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

export async function addToOutbox(item: OutboxItem) {
  const db = await initDB();
  await db.put('outbox', {
    ...item,
    status: item.status || 'pending',
    last_error: item.last_error || null,
  });
}

export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  return db.getAll('outbox');
}

export async function getPendingOutboxItems(): Promise<OutboxItem[]> {
  const items = await getOutboxItems();
  return items.filter(item => item.status !== 'failed');
}

export async function getFailedOutboxItems(): Promise<OutboxItem[]> {
  const items = await getOutboxItems();
  return items.filter(item => item.status === 'failed');
}

export async function removeFromOutbox(id: string) {
  const db = await initDB();
  await db.delete('outbox', id);
}

export async function updateOutboxItem(id: string, updates: Partial<OutboxItem>) {
  const db = await initDB();
  const existing = await db.get('outbox', id);
  if (!existing) return;

  await db.put('outbox', {
    ...existing,
    ...updates,
  });
}

export async function resetFailedOutboxItems() {
  const db = await initDB();
  const items = await db.getAll('outbox');

  await Promise.all(
    items
      .filter(item => item.status === 'failed')
      .map(item => db.put('outbox', {
        ...item,
        status: 'pending',
        attempts: 0,
        last_error: null,
      }))
  );
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
