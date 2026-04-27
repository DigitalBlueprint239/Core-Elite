/**
 * @core-elite/powersync — public API
 *
 * Entry point exposes the shared HLC core and the mobile initialization
 * helpers. The web path imports HLCClock directly; the mobile path goes
 * through initMobilePowerSync() to also set up local SQLite.
 *
 * Existing web code (src/lib/hlc.ts) remains unchanged — it has its own
 * localStorage persistence. Both platforms produce byte-identical HLC
 * strings because they run the same algorithm with the same format.
 */

export {
  HLCClock,
  MemoryStorageAdapter,
  formatHlc,
  parseHlc,
  compareHlc,
  maxHlc,
} from './hlc';
export type {
  HLCComponents,
  HLCState,
  HLCStorageAdapter,
  HLCClockOptions,
} from './hlc';

export {
  initMobilePowerSync,
  AsyncStorageHLCAdapter,
} from './native-init';
export type {
  PowerSyncDatabaseLike,
  PowerSyncFactory,
  AsyncStorageLike,
  MobilePowerSyncInit,
  InitMobilePowerSyncOptions,
} from './native-init';
