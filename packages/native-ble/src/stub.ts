/**
 * stub.ts
 * Core Elite — @core-elite/native-ble public mobile-init surface
 *
 * The package has two consumption paths:
 *
 *   index.ts  — production. Binds to the RN TurboModule, requires the
 *               react-native runtime + hardware, and exports the real
 *               bleTimingService singleton.
 *
 *   stub.ts   — mobile baseline (this file). Exports only the mock
 *               laser-trip simulator and its typed surface, with zero
 *               react-native imports. Resolvable without the RN toolchain
 *               installed so the monorepo workspace link is immediately
 *               usable for tests, storybook, and dev menus.
 *
 * The field-ops package imports from this stub during development. Once
 * react-native and the TurboModule are wired, consumers can swap their
 * import from '@core-elite/native-ble/src/stub' to '@core-elite/native-ble'
 * and the event shapes match one-to-one.
 */

export { initializeBLEListener } from './mock';
export type {
  MockBLEListener,
  MockTimingResult,
  MockValidationResult,
  MockValidationFailureReason,
  SimulateLaserTripOptions,
  PushRawHexOptions,
  PushRawHexResult,
} from './mock';

export {
  MOCK_DASHR_TRIP_HEX,
  MOCK_DASHR_TRIP_SECONDS,
  MOCK_DASHR_CHIP_ID,
} from './constants';
