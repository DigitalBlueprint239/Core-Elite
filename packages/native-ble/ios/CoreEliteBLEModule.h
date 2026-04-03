#pragma once

// =============================================================================
// CoreEliteBLEModule.h
// Core Elite — Phase 1: Silicon-to-Software Optimization
//
// Objective-C++ header for the CoreBluetooth-to-C++ bridge.
// The .mm implementation file captures clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
// as the FIRST statement of every CoreBluetooth delegate callback, enqueues
// into BLETimingBuffer, and flushes to the JS thread via CallInvoker::invokeAsync().
// =============================================================================

#import <Foundation/Foundation.h>
#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridgeModule.h>

#ifdef __cplusplus
#include <memory>
#include <functional>
#include "../cpp/BLETimingBuffer.h"

namespace facebook::react {
    class CallInvoker;
}
#endif

NS_ASSUME_NONNULL_BEGIN

// ---------------------------------------------------------------------------
// CoreEliteBLEModule
//
// Implements RCTEventEmitter for compatibility with both Old Architecture
// (RCT bridge) and New Architecture (TurboModule via RCTCxxBridgeDelegate).
//
// JS-visible events emitted:
//   "onTimingEvent"  — one or more TimingEvent objects flushed from the buffer
//   "onBLEStateChange" — CBManagerState changes (poweredOn / poweredOff / etc.)
//   "onDeviceConnected"    — peripheral connected, UUID + name
//   "onDeviceDisconnected" — peripheral disconnected, UUID + error description
//   "onScanError"          — CBCentralManager scan error
// ---------------------------------------------------------------------------
@interface CoreEliteBLEModule : RCTEventEmitter <RCTBridgeModule,
                                                  CBCentralManagerDelegate,
                                                  CBPeripheralDelegate>

#ifdef __cplusplus
// Designated initializer for New Architecture / unit tests.
// Old Architecture uses the standard RCT init path (no-arg init is fine).
- (instancetype)initWithCallInvoker:
    (std::shared_ptr<facebook::react::CallInvoker>)callInvoker;

// Access the underlying C++ buffer for testing.
- (CoreElite::BLETimingBuffer *)timingBuffer;
#endif

// ---------------------------------------------------------------------------
// JS-callable interface (also exposed via TurboModule spec)
// ---------------------------------------------------------------------------

// Begin scanning for peripherals whose advertised name starts with `namePrefix`.
// Typical values: "FREELAP" for Freelap FxChip, "DASHR" for Dashr|Blue.
- (void)startScan:(NSString *)namePrefix;

// Stop active scan. Safe to call if no scan is running.
- (void)stopScan;

// Disconnect all connected peripherals and stop scan.
- (void)disconnectAll;

// Manually trigger a buffer flush to JS (test/debug hook).
// Under normal operation, flush is automatic after every enqueue.
- (void)flushBuffer;

@end

NS_ASSUME_NONNULL_END
