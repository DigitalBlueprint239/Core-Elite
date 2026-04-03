// =============================================================================
// CoreEliteBLEModule.mm
// Core Elite — Phase 1: Silicon-to-Software Optimization
//
// CoreBluetooth delegate → C++ BLETimingBuffer → CallInvoker::invokeAsync → JS
//
// Critical timing path (v3 §1.4.3):
//   1. clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) — FIRST statement in delegate
//   2. Non-blocking enqueue into std::queue<TimingEvent> under std::mutex
//   3. Flush to JS via CallInvoker::invokeAsync() (lambda runs on JS thread)
//
// What this avoids (v3 §1.4.1–1.4.2):
//   - Hermes GC pauses clustering timestamps to ~0 ms delta
//   - EXC_BAD_ACCESS from calling jsi::Function::call() off the JS thread
//   - NTP clock adjustments corrupting sub-millisecond deltas
// =============================================================================

#import "CoreEliteBLEModule.h"

#include <time.h>
#include <memory>
#include <string>

#import <React/RCTLog.h>

#ifdef RCT_NEW_ARCH_ENABLED
#import <ReactCommon/CallInvoker.h>
#endif

// ---------------------------------------------------------------------------
// Freelap / Dashr GATT UUIDs
// These are placeholder UUIDs — replace with vendor-confirmed values when
// available. Dashr has no public SDK (v1 Appendix A Known Unknown); Freelap
// UUIDs are reverse-engineered from BLE sniff captures.
// ---------------------------------------------------------------------------
static NSString * const kFreelap_ServiceUUID  = @"XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";
static NSString * const kFreelap_TimingCharUUID = @"XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX";
static NSString * const kDashr_ServiceUUID    = @"YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY";
static NSString * const kDashr_TimingCharUUID = @"YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY";

// Reconnect constants (v1 §1.3.5)
static const NSInteger kMaxReconnectAttempts = 5;
static const NSTimeInterval kReconnectDelaySeconds = 2.0;

// JS event names
static NSString * const kEventTimingEvent        = @"onTimingEvent";
static NSString * const kEventBLEStateChange     = @"onBLEStateChange";
static NSString * const kEventDeviceConnected    = @"onDeviceConnected";
static NSString * const kEventDeviceDisconnected = @"onDeviceDisconnected";
static NSString * const kEventScanError          = @"onScanError";

// ---------------------------------------------------------------------------

@interface CoreEliteBLEModule () {
#ifdef __cplusplus
    std::shared_ptr<CoreElite::BLETimingBuffer>        _buffer;
    std::shared_ptr<facebook::react::CallInvoker>      _callInvoker;
#endif
}

@property (nonatomic, strong) CBCentralManager  *centralManager;
@property (nonatomic, strong) NSMutableArray<CBPeripheral *> *connectedPeripherals;
@property (nonatomic, copy,   nullable) NSString *scanNamePrefix;
@property (nonatomic, assign) NSInteger reconnectAttempts;
@property (nonatomic, assign) BOOL hasListeners;

@end

@implementation CoreEliteBLEModule

// ---------------------------------------------------------------------------
// RCTBridgeModule registration
// ---------------------------------------------------------------------------
RCT_EXPORT_MODULE(CoreEliteBLE)

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

- (instancetype)init {
    if (self = [super init]) {
        [self _commonInit];
    }
    return self;
}

#ifdef __cplusplus
- (instancetype)initWithCallInvoker:
        (std::shared_ptr<facebook::react::CallInvoker>)callInvoker {
    if (self = [super init]) {
        _callInvoker = callInvoker;
        [self _commonInit];
    }
    return self;
}

- (CoreElite::BLETimingBuffer *)timingBuffer {
    return _buffer.get();
}
#endif

- (void)_commonInit {
#ifdef __cplusplus
    _buffer = std::make_shared<CoreElite::BLETimingBuffer>();
#endif
    _connectedPeripherals = [NSMutableArray array];
    _reconnectAttempts    = 0;
    _hasListeners         = NO;

    // CBCentralManager MUST be created on a thread that has a run loop.
    // Main queue is the safe default; the delegate callbacks fire on this queue.
    dispatch_queue_t bleQueue = dispatch_queue_create(
        "com.coreelite.ble.central", DISPATCH_QUEUE_SERIAL);
    _centralManager = [[CBCentralManager alloc] initWithDelegate:self
                                                           queue:bleQueue
                                                         options:@{
        CBCentralManagerOptionShowPowerAlertKey: @YES
    }];
}

// ---------------------------------------------------------------------------
// RCTEventEmitter — required overrides
// ---------------------------------------------------------------------------

- (NSArray<NSString *> *)supportedEvents {
    return @[
        kEventTimingEvent,
        kEventBLEStateChange,
        kEventDeviceConnected,
        kEventDeviceDisconnected,
        kEventScanError,
    ];
}

- (void)startObserving { _hasListeners = YES;  }
- (void)stopObserving  { _hasListeners = NO;   }

// ---------------------------------------------------------------------------
// JS-exported methods
// ---------------------------------------------------------------------------

RCT_EXPORT_METHOD(startScan:(NSString *)namePrefix) {
    _scanNamePrefix    = namePrefix;
    _reconnectAttempts = 0;
    [self _startScanInternal];
}

RCT_EXPORT_METHOD(stopScan) {
    [_centralManager stopScan];
    RCTLogInfo(@"[CoreEliteBLE] Scan stopped");
}

RCT_EXPORT_METHOD(disconnectAll) {
    [_centralManager stopScan];
    for (CBPeripheral *p in _connectedPeripherals) {
        [_centralManager cancelPeripheralConnection:p];
    }
    [_connectedPeripherals removeAllObjects];
}

RCT_EXPORT_METHOD(flushBuffer) {
    [self _flushBufferToJS];
}

// ---------------------------------------------------------------------------
// Internal scan helpers
// ---------------------------------------------------------------------------

- (void)_startScanInternal {
    if (_centralManager.state != CBManagerStatePoweredOn) {
        RCTLogWarn(@"[CoreEliteBLE] Cannot scan: CBManager not powered on");
        return;
    }
    NSDictionary *options = @{
        CBCentralManagerScanOptionAllowDuplicatesKey: @NO
    };
    [_centralManager scanForPeripheralsWithServices:nil options:options];
    RCTLogInfo(@"[CoreEliteBLE] Scanning for prefix: %@", _scanNamePrefix);
}

// ---------------------------------------------------------------------------
// CBCentralManagerDelegate
// ---------------------------------------------------------------------------

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    NSString *stateStr;
    switch (central.state) {
        case CBManagerStatePoweredOn:   stateStr = @"poweredOn";    break;
        case CBManagerStatePoweredOff:  stateStr = @"poweredOff";   break;
        case CBManagerStateResetting:   stateStr = @"resetting";    break;
        case CBManagerStateUnauthorized:stateStr = @"unauthorized"; break;
        case CBManagerStateUnsupported: stateStr = @"unsupported";  break;
        default:                        stateStr = @"unknown";      break;
    }

    if (_hasListeners) {
        [self sendEventWithName:kEventBLEStateChange
                           body:@{@"state": stateStr}];
    }

    if (central.state == CBManagerStatePoweredOn && _scanNamePrefix) {
        [self _startScanInternal];
    }
}

- (void)centralManager:(CBCentralManager *)central
 didDiscoverPeripheral:(CBPeripheral *)peripheral
     advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                  RSSI:(NSNumber *)RSSI {

    NSString *name = peripheral.name ?: advertisementData[CBAdvertisementDataLocalNameKey];
    if (!name || (_scanNamePrefix && ![name hasPrefix:_scanNamePrefix])) {
        return;
    }

    RCTLogInfo(@"[CoreEliteBLE] Found peripheral: %@ RSSI: %@", name, RSSI);
    [central stopScan];
    peripheral.delegate = self;
    [_connectedPeripherals addObject:peripheral];
    [central connectPeripheral:peripheral options:nil];
}

- (void)centralManager:(CBCentralManager *)central
  didConnectPeripheral:(CBPeripheral *)peripheral {

    _reconnectAttempts = 0;
    RCTLogInfo(@"[CoreEliteBLE] Connected: %@", peripheral.name);

    if (_hasListeners) {
        [self sendEventWithName:kEventDeviceConnected
                           body:@{
            @"uuid": peripheral.identifier.UUIDString,
            @"name": peripheral.name ?: @"unknown",
        }];
    }

    // Discover only the timing service to minimize discovery time.
    // Pass nil to discover all services if UUIDs are not yet confirmed.
    NSArray *serviceUUIDs = @[
        [CBUUID UUIDWithString:kFreelap_ServiceUUID],
        [CBUUID UUIDWithString:kDashr_ServiceUUID],
    ];
    [peripheral discoverServices:serviceUUIDs];
}

- (void)centralManager:(CBCentralManager *)central
didFailToConnectPeripheral:(CBPeripheral *)peripheral
                 error:(NSError *)error {
    RCTLogError(@"[CoreEliteBLE] Failed to connect %@: %@", peripheral.name, error);
    [self _scheduleReconnectForPeripheral:peripheral];
}

- (void)centralManager:(CBCentralManager *)central
didDisconnectPeripheral:(CBPeripheral *)peripheral
                  error:(NSError *)error {
    RCTLogWarn(@"[CoreEliteBLE] Disconnected: %@ error: %@", peripheral.name, error);
    [_connectedPeripherals removeObject:peripheral];

    if (_hasListeners) {
        [self sendEventWithName:kEventDeviceDisconnected
                           body:@{
            @"uuid": peripheral.identifier.UUIDString,
            @"name": peripheral.name ?: @"unknown",
            @"error": error.localizedDescription ?: @"",
        }];
    }

    // Exponential backoff reconnect (v1 §1.3.5):
    //   MAX_RECONNECT_ATTEMPTS = 5, RECONNECT_DELAY_MS = 2000
    [self _scheduleReconnectForPeripheral:peripheral];
}

- (void)_scheduleReconnectForPeripheral:(CBPeripheral *)peripheral {
    if (_reconnectAttempts >= kMaxReconnectAttempts) {
        RCTLogError(@"[CoreEliteBLE] Max reconnect attempts reached for %@. "
                    @"Falling back to manual entry mode.", peripheral.name);
        return;
    }

    _reconnectAttempts++;
    NSTimeInterval delay = kReconnectDelaySeconds * pow(2.0, _reconnectAttempts - 1);
    RCTLogInfo(@"[CoreEliteBLE] Reconnect attempt %ld in %.1fs",
               (long)_reconnectAttempts, delay);

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
        dispatch_get_main_queue(),
        ^{
            [self->_centralManager connectPeripheral:peripheral options:nil];
        });
}

// ---------------------------------------------------------------------------
// CBPeripheralDelegate
// ---------------------------------------------------------------------------

- (void)peripheral:(CBPeripheral *)peripheral
  didDiscoverServices:(NSError *)error {

    if (error) {
        RCTLogError(@"[CoreEliteBLE] Service discovery error: %@", error);
        return;
    }

    for (CBService *service in peripheral.services) {
        NSArray *charUUIDs = nil;

        if ([service.UUID isEqual:[CBUUID UUIDWithString:kFreelap_ServiceUUID]]) {
            charUUIDs = @[[CBUUID UUIDWithString:kFreelap_TimingCharUUID]];
        } else if ([service.UUID isEqual:[CBUUID UUIDWithString:kDashr_ServiceUUID]]) {
            charUUIDs = @[[CBUUID UUIDWithString:kDashr_TimingCharUUID]];
        }

        if (charUUIDs) {
            [peripheral discoverCharacteristics:charUUIDs forService:service];
        }
    }
}

- (void)peripheral:(CBPeripheral *)peripheral
didDiscoverCharacteristicsForService:(CBService *)service
             error:(NSError *)error {

    if (error) {
        RCTLogError(@"[CoreEliteBLE] Characteristic discovery error: %@", error);
        return;
    }

    for (CBCharacteristic *characteristic in service.characteristics) {
        if (characteristic.properties & CBCharacteristicPropertyNotify) {
            [peripheral setNotifyValue:YES forCharacteristic:characteristic];
            RCTLogInfo(@"[CoreEliteBLE] Subscribed to characteristic: %@",
                       characteristic.UUID);
        }
    }
}

// ---------------------------------------------------------------------------
// THE CRITICAL PATH — v3 §1.4.3
//
// Rule: clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) MUST be the first statement.
// Any delay between the callback entering and the timestamp capture
// introduces scheduling jitter into the timing measurement.
//
// CLOCK_MONOTONIC_RAW properties:
//   - Nanosecond resolution
//   - Hardware-based, not adjusted by NTP or adjtime()
//   - Does not pause during device sleep
//   - Immune to wall-clock jumps from iCloud / carrier time sync
// ---------------------------------------------------------------------------
- (void)peripheral:(CBPeripheral *)peripheral
didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
             error:(NSError *)error {

    // =========================================================
    // TIMESTAMP CAPTURE: FIRST STATEMENT — DO NOT REORDER
    // =========================================================
    const uint64_t monotonic_ns = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
    // =========================================================

    if (error) {
        RCTLogError(@"[CoreEliteBLE] Characteristic update error: %@", error);
        return;
    }

    NSData *value = characteristic.value;
    if (!value || value.length == 0) {
        return;
    }

#ifdef __cplusplus
    // Build the TimingEvent on the stack — no heap allocation in the hot path.
    CoreElite::TimingEvent event{};
    event.monotonic_ns = monotonic_ns;
    event.byte_count   = MIN(value.length, CoreElite::kRawBytesCapacity);
    memcpy(event.raw_bytes, value.bytes, event.byte_count);

    // Copy peripheral name as chip_id (null-terminated, bounded).
    NSString *name = peripheral.name ?: peripheral.identifier.UUIDString;
    strncpy(event.chip_id, name.UTF8String, CoreElite::kChipIdCapacity - 1);
    event.chip_id[CoreElite::kChipIdCapacity - 1] = '\0';

    // Enqueue — non-blocking, O(1), mutex-protected.
    // Never touches JSI. Never blocks waiting for the JS thread.
    const bool enqueued = _buffer->enqueue(event);
    if (!enqueued) {
        RCTLogWarn(@"[CoreEliteBLE] BLETimingBuffer overflow — event dropped. "
                   @"Check flush frequency.");
        return;
    }

    // Schedule flush to JS thread.
    // invokeAsync() is safe to call from any thread — the lambda is guaranteed
    // to execute on the JS thread. Calling jsi::Function::call() directly from
    // here would cause EXC_BAD_ACCESS (v3 §1.4.2, Mode 3).
    [self _scheduleFlushToJS];
#endif
}

// ---------------------------------------------------------------------------
// Buffer flush — runs lambda on JS thread via CallInvoker
// ---------------------------------------------------------------------------

- (void)_scheduleFlushToJS {
#ifdef __cplusplus
    if (!_hasListeners) {
        return; // No JS subscriber — keep events in buffer until subscribed.
    }

    // Capture shared_ptr by value so buffer lifetime is guaranteed across
    // the async dispatch even if the module is torn down before the lambda runs.
    auto buffer      = _buffer;
    __weak CoreEliteBLEModule *weakSelf = self;

    auto flushLambda = [weakSelf, buffer]() {
        // This lambda runs on the JS thread.
        CoreEliteBLEModule *strongSelf = weakSelf;
        if (!strongSelf) { return; }

        std::vector<CoreElite::TimingEvent> events = buffer->flush();
        if (events.empty()) { return; }

        NSMutableArray *jsEvents = [NSMutableArray arrayWithCapacity:events.size()];
        for (const auto &evt : events) {
            // Convert raw_bytes to hex string for JS consumption.
            // Decoding centiseconds → seconds happens in the TS layer (index.ts).
            NSMutableString *hexStr = [NSMutableString
                stringWithCapacity:evt.byte_count * 2];
            for (size_t i = 0; i < evt.byte_count; i++) {
                [hexStr appendFormat:@"%02x", evt.raw_bytes[i]];
            }

            // monotonic_ns as string to avoid JS IEEE-754 precision loss
            // on uint64_t values > 2^53. The TS layer parses with BigInt.
            [jsEvents addObject:@{
                @"monotonic_ns": [NSString stringWithFormat:@"%llu",
                                  (unsigned long long)evt.monotonic_ns],
                @"raw_hex":      hexStr,
                @"byte_count":   @(evt.byte_count),
                @"chip_id":      [NSString stringWithUTF8String:evt.chip_id],
            }];
        }

        if (strongSelf->_hasListeners) {
            [strongSelf sendEventWithName:kEventTimingEvent
                                     body:@{@"events": jsEvents}];
        }
    };

    // New Architecture: use CallInvoker for JSI-safe cross-thread dispatch.
    // Old Architecture fallback: dispatch to the JS thread via React's bridge queue.
    if (_callInvoker) {
        _callInvoker->invokeAsync(std::move(flushLambda));
    } else {
        // Old Architecture fallback
        dispatch_async(dispatch_get_main_queue(), ^{
            flushLambda();
        });
    }
#endif
}

- (void)_flushBufferToJS {
    [self _scheduleFlushToJS];
}

// ---------------------------------------------------------------------------
// RCTEventEmitter — main queue requirement
// Return NO: our CBCentralManager runs on its own serial queue; we handle
// thread dispatch explicitly via CallInvoker / dispatch_async.
// ---------------------------------------------------------------------------
+ (BOOL)requiresMainQueueSetup {
    return NO;
}

@end
