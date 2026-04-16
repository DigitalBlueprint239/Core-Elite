# Legacy JS Timing — Removal Plan

This document specifies every location where JS-layer timing must be removed
or replaced when migrating from the web app to the React Native client.
Leaving any of these in place violates the zero-JS-timing constraint.

---

## What "legacy JS timing" means

Any use of `Date.now()` or `performance.now()` as a **precision event timestamp**
in the timing capture path. This includes:

- Using `Date.now()` to timestamp BLE packet receipt
- Using `Date.now()` in `parseTimingPacket()` or equivalent
- Using `Date.now()` as the `updated_at` / conflict-resolution timestamp on
  timing result records

`Date.now()` is **correct** for:
- Elapsed-time / backoff math on the outbox (measuring duration, not ordering events)
- Display strings ("result captured at 2:34 PM") — use `received_at` (ISO string)

---

## Removal checklist

### 1. `parseTimingPacket()` — DELETE IN FULL

If a function named `parseTimingPacket` exists anywhere in the React Native
app's source that calls `Date.now()` or `performance.now()` to timestamp a
BLE packet, **delete it entirely**.

Replace with: `bleTimingService.onTimingResult()` from `@core-elite/native-ble`.
The native layer handles all timestamp capture. The `TimingResult` you receive
already contains `monotonic_ns` (nanosecond hardware clock) and `time_seconds`
(decoded elapsed time). There is nothing left for JS to timestamp.

Search pattern:
```
grep -rn "parseTimingPacket" src/
grep -rn "Date.now()" src/ | grep -i "timing\|ble\|packet\|result"
grep -rn "performance.now()" src/
```

### 2. `onValueChange` / BLE characteristic callback — NO TIMESTAMPS

If any code subscribes to a raw BLE characteristic notification (via
`react-native-ble-plx`, `@capacitor-community/bluetooth-le`, or any other
library) and timestamps the callback with `Date.now()`, **that entire code path
is replaced** by `@core-elite/native-ble`.

The correct subscription is:
```typescript
import { useBLETiming } from '@core-elite/native-ble';

const { lastResult } = useBLETiming({
  stationId, eventId, athleteId, drillId,
  hlcTick,      // from your app's HLC module
  outboxWrite,  // your WatermelonDB write function
});
```

### 3. `updated_at: Date.now()` on timing_results — REPLACE WITH HLC

Any schema or sync-engine code that writes `updated_at: Date.now()` on a
`timing_results` row must be replaced with `hlc_timestamp: hlcTick()`.

Migration:
- Schema: `updated_at: number` → `hlc_timestamp: string`
- Conflict resolution: `max(updated_at)` → `compareHlc(a, b) > 0`
- See `src/lib/hlc.ts` for the HLC implementation (v2 §3.1.3).

`updated_at` may be retained as a **secondary display column** (set to
`Date.now()` at write time for UI "last modified" display), but it must
never be the source of truth for LWW conflict resolution.

### 4. Outbox `timestamp` field — CORRECT, NO CHANGE REQUIRED

The outbox `timestamp: Date.now()` field in `src/lib/offline.ts` is
**intentionally** using `Date.now()`. It measures elapsed time for backoff
math and is explicitly not a conflict-resolution timestamp (see the inline
comment in `offline.ts`). Do not change this.

---

## Verification

After completing the migration, run:

```bash
# Should return zero results in the timing capture path
grep -rn "Date.now()" src/ \
  | grep -v "offline.ts" \
  | grep -v "display\|received_at\|heartbeat\|backoff\|elapsed\|timestamp.*display"

# Should return zero results — no raw BLE subscriptions outside the native module
grep -rn "onValueChange\|didUpdateValue\|characteristicchanged" src/
```

Zero output from both commands = legacy timing fully removed.

---

## What the native module guarantees

| Property | Guarantee |
|---|---|
| Timestamp capture point | CoreBluetooth delegate / BluetoothGattCallback — before any JS |
| Clock source (iOS) | `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)` — nanosecond, not NTP-adjusted |
| Clock source (Android) | `SystemClock.uptimeNanos()` — nanosecond, not NTP-adjusted |
| GC jitter immunity | C++ buffer enqueues before any JS execution; flush via CallInvoker |
| Thread safety | `std::mutex` (iOS) / `ConcurrentLinkedQueue` (Android) |
| Overflow behavior | Overflow-drop at 1,000 events; unreachable at combine scale (0.2 Hz) |
| Crash safety | Buffer survives JS thread death; events flushed on next `invokeAsync` |
