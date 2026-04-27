/**
 * constants.ts
 * Core Elite — @core-elite/native-ble shared constants
 *
 * Values that both the production TurboModule path and the mock stub
 * need to agree on. Keeping them in their own file (no react-native
 * imports) means the stub-only tsconfig can pull them in without
 * dragging the rest of the production surface into its compile graph.
 */

// ---------------------------------------------------------------------------
// MOCK_DASHR_TRIP_HEX — the sentinel "hex" string used while the physical
// Dashr gate is unavailable. Mission W spec: an **arbitrary** non-hex
// literal so it could never collide with a real packet from a Freelap
// or Dashr unit. If an actual Dashr byte sequence starting with 0xD5
// ever appeared on the wire, pushRawHex() would route it through the
// real Dashr decoder — this string fails every hex parser and is the
// only value the mock recognises as a "simulate a laser trip" signal.
//
// DO NOT change the string without also updating:
//   - packages/native-ble/src/mock.ts → pushRawHex()
//   - packages/field-ops/src/mobile/debugTrip.ts → simulateDashrTrip()
//   - The acceptance test in packages/field-ops/src/mobile/__tests__/
//     laserTrip.test.ts that asserts on the exact string value.
// ---------------------------------------------------------------------------

export const MOCK_DASHR_TRIP_HEX = '0xD5HR_TRIP' as const;

/**
 * Default decoded value applied when MOCK_DASHR_TRIP_HEX triggers a mock
 * trip. 4.42s is within the Freelap/Dashr 40yd validation gates (clean
 * result — passes all four validation gates in mock.ts) so pipelines
 * exercising the happy path never hit a validation_note branch.
 */
export const MOCK_DASHR_TRIP_SECONDS = 4.42 as const;

/**
 * Chip identifier stamped on every synthetic trip originating from the
 * MOCK_DASHR_TRIP_HEX sentinel. Downstream consumers (AdminDiagnostics,
 * failed_rpc_logs forensics) filter on this value to distinguish
 * simulated events from production hardware captures.
 */
export const MOCK_DASHR_CHIP_ID = 'DASHR-MOCK-1' as const;
