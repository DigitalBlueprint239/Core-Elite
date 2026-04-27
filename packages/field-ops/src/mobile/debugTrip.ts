/**
 * debugTrip.ts
 * Core Elite — Mission W: Dashr mock trigger helper
 *
 * Framework-agnostic entry point for the [ SIMULATE DASHR LASER TRIP ]
 * debug button. This file has **zero React/React Native imports** so it
 * compiles under `npm run lint:mobile` alongside the rest of the
 * framework-agnostic mobile surface, and is directly unit-testable in
 * vitest without a DOM.
 *
 * The actual RN `Pressable` component lives in ../native/DebugLaserTripButton.tsx
 * and delegates its `onPress` to `simulateDashrTrip()` below. Splitting
 * view + controller this way keeps the mission's end-to-end flow
 * (button → sentinel → HLC → outbox) testable without an RN runtime.
 */

import type { MockBLEListener, PushRawHexResult } from '@core-elite/native-ble/src/stub';
import { MOCK_DASHR_TRIP_HEX } from '@core-elite/native-ble/src/stub';

/**
 * simulateDashrTrip — push the Mission W sentinel hex into a listener's
 * raw-bytes pipeline.
 *
 * By design, this function is exactly what the RN button's onPress fires.
 * It returns the `PushRawHexResult` so a test harness can assert that
 * the sentinel was recognised (sanity check against hex-string drift)
 * and so the button itself can show a micro-confirmation on screen.
 *
 * The listener's existing subscribers receive a `MockTimingResult` event
 * whose `raw_hex` is the literal MOCK_DASHR_TRIP_HEX string — that is
 * then fed into `startLaserTripPipeline()` which ticks the HLC clock and
 * enqueues the outbox entry. The button doesn't touch HLC or the outbox
 * directly; the pipeline wired up at app boot does.
 */
export function simulateDashrTrip(listener: MockBLEListener): PushRawHexResult {
  return listener.pushRawHex(MOCK_DASHR_TRIP_HEX);
}

export { MOCK_DASHR_TRIP_HEX };
