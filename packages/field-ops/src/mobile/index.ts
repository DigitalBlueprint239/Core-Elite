/**
 * @core-elite/field-ops/mobile — baseline React Native client entry
 *
 * Exports the minimum surface a mobile app shell needs to boot the laser-
 * trip pipeline against the mock BLE path. Once RN + TurboModule are wired,
 * swap the listener import from '@core-elite/native-ble/src/stub' to the
 * production bleTimingService singleton and this entry stays unchanged.
 */

export {
  startLaserTripPipeline,
  MemoryOutbox,
} from './useLaserTrip';
export type {
  OutboxEntry,
  OutboxSink,
  LaserTripPipeline,
  LaserTripPipelineOptions,
} from './useLaserTrip';

// Re-export the mock listener factory for app-shell convenience.
export { initializeBLEListener } from '@core-elite/native-ble/src/stub';
export type {
  MockBLEListener,
  MockTimingResult,
  PushRawHexOptions,
  PushRawHexResult,
} from '@core-elite/native-ble/src/stub';

// Mission W: Dashr sentinel + debug-button trigger.
export {
  MOCK_DASHR_TRIP_HEX,
  MOCK_DASHR_TRIP_SECONDS,
  MOCK_DASHR_CHIP_ID,
} from '@core-elite/native-ble/src/stub';
export { simulateDashrTrip } from './debugTrip';

// Mission Y: QR Identity Matrix.
export {
  QR_PREFIX,
  QR_VERSION,
  isUUID,
  encodeAthleteQRPayload,
  parseAthleteQR,
  MemoryAthleteCache,
  MemoryArmedAthleteSink,
  armFromScan,
  ScanDebouncer,
} from './qrIdentity';
export type {
  ArmedAthlete,
  AthleteCache,
  ArmedAthleteSink,
  ArmResult,
  ArmFailureReason,
  ParseResult,
  ParseFailureReason,
} from './qrIdentity';

// Re-export HLC + init so an app shell only needs @core-elite/field-ops.
export {
  HLCClock,
  initMobilePowerSync,
  AsyncStorageHLCAdapter,
} from '@core-elite/powersync';
export type {
  MobilePowerSyncInit,
  InitMobilePowerSyncOptions,
  HLCStorageAdapter,
} from '@core-elite/powersync';
