import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'core_elite_combine_db';
const DB_VERSION = 1;

export interface OutboxItem {
  id: string; // client_result_id
  type: 'result' | 'device_status';
  payload: any;
  timestamp: number;
  attempts: number;
  retry_count: number;
  last_attempt_at?: number;
  error_message?: string;
  status: 'pending' | 'retrying' | 'dead_letter';
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

export async function addToOutbox(item: Partial<OutboxItem> & Pick<OutboxItem, 'id' | 'type' | 'payload'>) {
  const db = await initDB();
  const fullItem: OutboxItem = {
    timestamp: Date.now(),
    attempts: 0,
    retry_count: 0,
    status: 'pending',
    ...item
  };
  await db.put('outbox', fullItem);
}

export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await initDB();
  return db.getAll('outbox');
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
