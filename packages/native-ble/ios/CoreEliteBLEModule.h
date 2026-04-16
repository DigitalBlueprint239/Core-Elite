#pragma once

// =============================================================================
// CoreEliteBLEModule.h
// Core Elite — Phase 2: RF Adaptation + Inter-Device Clock Sync
//
// Extensions over Phase 1:
//   1. Continuous RSSI monitoring (1s poll on _bleQueue)
//   2. RF adaptation state machine (Normal → Degrading → PHYCoded → Critical → Fallback)
//   3. PHY management: iOS CoreBluetooth does not expose mid-connection PHY
//      switching from the Central role (confirmed absent from public API, iOS 13–17).
//      Implementation: disconnect + reconnect with extended scan to maximise the
//      probability of negotiating Coded PHY if the peripheral supports it.
//   4. Inter-device clock sync: dual-role operation — this device acts as both:
//        a. CBCentralManager: scanning for timing chips (existing)
//        b. CBPeripheralManager: advertising the CoreElite Sync Service so
//           other station devices can connect and run two-way time exchange
//   5. Clock offset applied to all TimingEvent packets before JS emission
//   6. Fallback: when signal is unrecoverable, emits onFallbackRequired —
//      JS shows manual entry UI; BLE timing path is disabled until reset
//
// JS-visible events (additions to Phase 1):
//   "onRSSIUpdate"        — smoothed RSSI per connected peripheral
//   "onRFAdaptation"      — RF adaptation state change
//   "onClockSyncUpdate"   — new offset estimate + rtt + sampleCount
//   "onSignalDegraded"    — smoothed RSSI below threshold; PHY switch attempted
//   "onFallbackRequired"  — signal unrecoverable; JS must show manual entry
//   "onFallbackCleared"   — signal recovered; BLE timing re-enabled
// =============================================================================

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridgeModule.h>

#ifdef __cplusplus
#include <memory>
#include <functional>
#include "../cpp/BLETimingBuffer.h"
#include "../cpp/ClockSync.h"

namespace facebook::react {
    class CallInvoker;
}
#endif

NS_ASSUME_NONNULL_BEGIN

// ---------------------------------------------------------------------------
// CoreElite Sync GATT Service constants
//
// Custom 128-bit UUIDs registered to the Core Elite namespace.
// These are not assigned numbers — they are random UUIDs unique to this system.
//
// Service:         CE515000-0001-4000-B000-000000000001
// Sync Char (W):   CE515000-0001-4000-B000-000000000002  (Slave writes PING)
// Pong Char (N):   CE515000-0001-4000-B000-000000000003  (Master notifies PONG)
//
// Properties:
//   Sync Char: WriteWithoutResponse — minimises T1→T2 latency (no ACK round-trip)
//   Pong Char: Notify — master sends PONG asynchronously
// ---------------------------------------------------------------------------
extern NSString * const kCESyncServiceUUID;
extern NSString * const kCESyncCharWriteUUID;
extern NSString * const kCESyncCharNotifyUUID;

@interface CoreEliteBLEModule : RCTEventEmitter <
    RCTBridgeModule,
    CBCentralManagerDelegate,
    CBPeripheralDelegate,
    CBPeripheralManagerDelegate
>

#ifdef __cplusplus
- (instancetype)initWithCallInvoker:
    (std::shared_ptr<facebook::react::CallInvoker>)callInvoker;
- (CoreElite::BLETimingBuffer *)timingBuffer;
#endif

// ---------------------------------------------------------------------------
// JS-callable interface
// ---------------------------------------------------------------------------

// (Inherited from Phase 1)
- (void)startScan:(NSString *)namePrefix;
- (void)stopScan;
- (void)disconnectAll;
- (void)flushBuffer;

// Phase 2 additions:
// Start advertising the CoreElite Sync Service so other devices can connect.
// nodeId: this device's identifier (used for master election — lowest wins).
- (void)startSyncService:(NSString *)nodeId;

// Stop advertising the sync service.
- (void)stopSyncService;

// Force an immediate clock sync ping to all connected sync peers.
- (void)triggerClockSync;

// Reset fallback state and re-enable BLE timing.
// Call only after operator confirms signal quality is acceptable.
- (void)resetFallback;

@end

NS_ASSUME_NONNULL_END
