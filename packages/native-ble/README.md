# @core-elite/native-ble

> **Status: PLANNED — Not Yet Integrated**
>
> This package is scaffolded and fully authored but is **not imported anywhere
> in the production Vite/React web application.** It requires a React Native
> host with the New Architecture (TurboModules / JSI) enabled, plus a native
> iOS and Android build. It cannot run in a browser or in Vite's dev server.

---

## Purpose

`native-ble` is the **hardware timing bridge** between BLE timing gate hardware
(Freelap FxChip, Dashr|Blue) and the Core Elite data pipeline. It eliminates
JavaScript-layer timing precision loss by capturing the hardware timestamp in
C++ before any JS execution occurs.

### The Problem It Solves

Every millisecond of JS event-loop jitter pollutes a timing result. At combine
scale, drift of 30–80ms per result is routine with JS-layer BLE callbacks. This
package captures the timestamp at the CoreBluetooth delegate (iOS) or
`BluetoothGattCallback` (Android) using a monotonic nanosecond clock, buffers
it in a C++ lock-free queue, and delivers it to JS via `CallInvoker::invokeAsync`
— before GC, before React rendering, before any other JS work.

**Zero JS timing guarantee:** No `Date.now()` or `performance.now()` call exists
in the timing-capture path. See `LEGACY_REMOVAL.md` for the full checklist.

---

## Architecture

```
CoreBluetooth / BluetoothGattCallback  ← hardware interrupt
    ↓  clock_gettime_nsec_np (iOS) / SystemClock.uptimeNanos() (Android)
BLETimingBuffer::enqueue()             ← C++ lock-free queue (1,000 event cap)
    ↓  CallInvoker::invokeAsync()
bleTimingService.onTimingResult()      ← decoded TimingResult (TypeScript)
    ↓
useBLETiming({ hlcTick, outboxWrite }) ← WatermelonDB outbox write with HLC timestamp
    ↓
PowerSync → Supabase                   ← server sync (see packages/powersync)
```

---

## Contents

```
packages/native-ble/
├── package.json
├── tsconfig.json
├── LEGACY_REMOVAL.md          Checklist for removing JS-layer timing on RN migration
├── CoreEliteBLE.podspec       iOS CocoaPods spec
├── android/
│   ├── build.gradle
│   └── src/                   Kotlin BluetoothGatt implementation
├── cpp/
│   ├── BLETimingBuffer.h/.cpp C++ lock-free timing event queue (Phase 1)
│   └── ClockSync.h/.cpp       Inter-device BLE clock sync (Phase 2)
├── ios/
│   ├── CoreEliteBLEModule.h   Phase 2: RSSI monitoring + RF adaptation + clock sync
│   └── CoreEliteBLEModule.mm  Objective-C++ implementation
└── src/
    ├── NativeBLETimingModule.ts  TurboModule spec (JSI binding)
    ├── index.ts                  BLETimingService class + packet decoders
    ├── useBLETiming.ts           React hook: timing result → WatermelonDB outbox write
    └── useRFAdaptation.ts        React hook: RF signal state + clock sync UI
```

---

## Key Components

### `BLETimingBuffer` (C++)

Thread-safe circular buffer (capacity: 1,000 events). Enqueue is called on the
CoreBluetooth/BluetoothGatt thread; flush via `CallInvoker::invokeAsync` on the
JS thread. Buffer overflow drops oldest events (combine scale: ~0.2 Hz, so
overflow is unreachable in practice).

### `CoreEliteBLEModule` (iOS, Phase 2)

Extends Phase 1 with:
- Continuous RSSI monitoring (1-second poll)
- RF adaptation state machine: `Normal → Degrading → PHYCoded → Critical → Fallback`
- Inter-device clock sync (dual-role Central/Peripheral BLE operation)
- PHY management via disconnect+reconnect (iOS does not support mid-connection PHY switching from the Central role)

### `BLETimingService` (TypeScript)

Singleton class wrapping the TurboModule. Exposes typed event subscriptions:
- `onTimingResult(handler)` — decoded, validated `TimingResult`
- `onBLEStateChange(handler)` — adapter on/off/unauthorized
- `onDeviceConnected/Disconnected(handler)` — peripheral lifecycle
- `onError(handler)` — scan failures

Supports two hardware vendors:
| Vendor | Decode status |
|---|---|
| Freelap FxChip | Implemented — UInt32LE centiseconds from BLE notification bytes |
| Dashr\|Blue | **Known Unknown** — vendor protocol unconfirmed; returns `null` (falls through to manual entry) |

### `useBLETiming` (Hook)

The final stage of the timing pipeline. Injects:
- `hlcTick: () => string` — caller provides HLC tick (package has no HLC dependency)
- `outboxWrite: (record) => Promise<void>` — caller provides WatermelonDB write

This injection pattern keeps the package decoupled from the app's HLC module
and database instance.

### `useRFAdaptation` (Hook)

Exposes RF adaptation state and inter-device clock sync info to the station UI.
Shows signal quality, PHY mode, and clock offset for diagnostics.

---

## Supported Hardware

| Device | Protocol | Phase |
|---|---|---|
| Freelap FxChip (BLE) | Reverse-engineered UInt32LE centiseconds | Phase 1 |
| Dashr\|Blue | Pending vendor confirmation | Phase 2 target |

---

## Integration Prerequisites

1. React Native New Architecture (`newArchEnabled=true`)
2. iOS 14+ / Android 8+ (BLE 5.0 for Coded PHY adaptation)
3. `pod install` for iOS native module linkage
4. Bluetooth permission entitlements in `Info.plist` / `AndroidManifest.xml`
5. A WatermelonDB or PowerSync SQLite instance to inject into `useBLETiming`
6. `packages/powersync` for the server sync layer (optional — IndexedDB outbox also works)
