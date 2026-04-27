/**
 * native-init.ts
 * Core Elite — Mission U: React Native PowerSync initialization
 *
 * Initializes the local-first SQLite database on the React Native client.
 * This is the mobile counterpart to the web IndexedDB outbox — same HLC
 * format, same client_result_id UNIQUE contract, so a result captured on
 * iPad offline and re-uploaded later merges cleanly with the web outbox.
 *
 * Runtime dependencies (injected, not required at package-install time):
 *   - @powersync/react-native   → PowerSyncDatabase constructor
 *   - react-native-quick-sqlite → SQLite backend for PowerSync
 *   - @react-native-async-storage/async-storage → HLC persistence
 *
 * We type those via structural interfaces so this file compiles standalone;
 * the real constructors are resolved at runtime inside initMobilePowerSync().
 */

import {
  HLCClock,
  HLCStorageAdapter,
  HLCState,
  MemoryStorageAdapter,
} from './hlc';

// ---------------------------------------------------------------------------
// Structural types — match the subset of upstream APIs we use.
// This lets the file compile without @powersync/react-native installed.
// When those packages land, swap to real imports + delete the structural types.
// ---------------------------------------------------------------------------

export interface PowerSyncDatabaseLike {
  init(): Promise<void>;
  close(): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getAll<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface PowerSyncFactory {
  /** Construct a PowerSyncDatabase. The real factory comes from
   *  @powersync/react-native at runtime. */
  (opts: {
    schema:   unknown;
    database: { dbFilename: string };
  }): PowerSyncDatabaseLike;
}

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AsyncStorage-backed HLC adapter
//
// HLC tick() is called on the write hot-path and must be synchronous.
// AsyncStorage is async, so we hydrate once on boot and write-through in
// the background. Worst-case on a crash between tick() and the queued
// write is that the logical counter resets — the physical time still
// advances, so no HLC strings are ever duplicated.
// ---------------------------------------------------------------------------

const HLC_STORAGE_KEY = 'core_elite_hlc_state';

export class AsyncStorageHLCAdapter implements HLCStorageAdapter {
  private cache: HLCState | null = null;
  private storage: AsyncStorageLike;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storage: AsyncStorageLike) {
    this.storage = storage;
  }

  /**
   * Hydrate the in-memory cache from AsyncStorage.
   * Call once at app boot, before any HLC tick().
   */
  async hydrate(): Promise<void> {
    try {
      const raw = await this.storage.getItem(HLC_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<HLCState>;
      const pt = Number(parsed.pt);
      const l  = Number(parsed.l);
      if (Number.isFinite(pt) && Number.isFinite(l)) {
        this.cache = { pt, l };
      }
    } catch {
      // AsyncStorage unavailable or JSON corrupt — start fresh.
    }
  }

  get(): HLCState | null {
    return this.cache;
  }

  set(state: HLCState): void {
    this.cache = state;
    // Serialize writes so a burst of tick()s can't race. Failures are
    // swallowed — the in-memory state is authoritative within a session.
    this.writeQueue = this.writeQueue.then(() =>
      this.storage.setItem(HLC_STORAGE_KEY, JSON.stringify(state)).catch(() => {}),
    );
  }
}

// ---------------------------------------------------------------------------
// Public init API
// ---------------------------------------------------------------------------

export interface MobilePowerSyncInit {
  /** Local SQLite database handle. */
  db:   PowerSyncDatabaseLike;
  /** HLC clock wired to AsyncStorage persistence (shared format with web). */
  hlc:  HLCClock;
}

export interface InitMobilePowerSyncOptions {
  nodeId:        string;
  schema:        unknown;
  powerSync:     PowerSyncFactory;
  asyncStorage?: AsyncStorageLike;
  /** SQLite filename on disk — default matches web IDB database name. */
  dbFilename?:   string;
}

/**
 * initMobilePowerSync — bootstrap the mobile offline database.
 *
 * 1. Construct PowerSync SQLite with the shared schema.
 * 2. Hydrate the HLC from AsyncStorage (or start at 0/0 if unavailable).
 * 3. Return { db, hlc } — the two handles every write-path needs.
 *
 * The caller is responsible for wiring a PowerSyncBackendConnector
 * (see connector.ts) that uses this hlc instance to stamp outgoing CRUDs.
 */
export async function initMobilePowerSync(
  opts: InitMobilePowerSyncOptions,
): Promise<MobilePowerSyncInit> {
  const db = opts.powerSync({
    schema:   opts.schema,
    database: { dbFilename: opts.dbFilename ?? 'core-elite.db' },
  });
  await db.init();

  let hlcStorage: HLCStorageAdapter = new MemoryStorageAdapter();
  if (opts.asyncStorage) {
    const adapter = new AsyncStorageHLCAdapter(opts.asyncStorage);
    await adapter.hydrate();
    hlcStorage = adapter;
  }

  const hlc = new HLCClock({
    nodeId:  opts.nodeId,
    storage: hlcStorage,
  });

  return { db, hlc };
}
