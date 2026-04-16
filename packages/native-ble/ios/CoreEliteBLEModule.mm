// =============================================================================
// CoreEliteBLEModule.mm
// Core Elite — Phase 2: RF Adaptation + Inter-Device Clock Sync
//
// TIMING ACCURACY CONTRACT (all timing-critical paths):
//   clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) MUST be the FIRST statement
//   in EVERY CoreBluetooth delegate callback that touches a timestamp.
//   This includes the new sync PONG receive path.
//
// PHY LIMITATION (iOS):
//   CoreBluetooth does not expose a mid-connection PHY switch API for the
//   Central role in any public iOS SDK (iOS 13–17). PHY "downgrade" is
//   implemented as: disconnect → reconnect (which triggers extended advertising
//   discovery on Coded PHY if the peripheral advertises on it).
//   Effect: ~200–400ms timing gap during PHY transition. This is acceptable
//   because PHY transitions only occur at RSSI < -85dBm, well below the
//   threshold where timing chips are still reliable.
//
// MULTI-ROLE OPERATION:
//   CBCentralManager  — scans for and connects to timing chips (existing)
//   CBPeripheralManager — advertises CoreElite Sync Service to peer devices
//   Both run concurrently on separate queues.
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
// GATT UUID constants
// ---------------------------------------------------------------------------
NSString * const kCESyncServiceUUID    = @"CE515000-0001-4000-B000-000000000001";
NSString * const kCESyncCharWriteUUID  = @"CE515000-0001-4000-B000-000000000002";
NSString * const kCESyncCharNotifyUUID = @"CE515000-0001-4000-B000-000000000003";

// ---------------------------------------------------------------------------
// Freelap / Dashr timing chip UUIDs
// Replace with vendor-confirmed values. Passing nil discovers all services.
// DO NOT pass placeholder strings to CBUUID UUIDWithString — X is not valid hex.
// ---------------------------------------------------------------------------
static NSString * const kTimingNamePrefixFreelap = @"FREELAP";
static NSString * const kTimingNamePrefixDashr   = @"DASHR";

// ---------------------------------------------------------------------------
// Operational constants
// ---------------------------------------------------------------------------
static const NSInteger     kMaxReconnectAttempts  = 5;
static const NSTimeInterval kReconnectDelayBase   = 2.0;   // seconds; doubles each attempt
static const NSTimeInterval kRSSIPollInterval     = 1.0;   // seconds
static const NSTimeInterval kSyncPingInterval     = 30.0;  // seconds (target)
static const NSTimeInterval kSyncPingTimeout      = 5.0;   // seconds to wait for PONG
static const NSTimeInterval kPHYTransitionTimeout = 10.0;  // seconds; fallback if no reconnect

// JS event names — Phase 1
static NSString * const kEventTimingEvent        = @"onTimingEvent";
static NSString * const kEventBLEStateChange     = @"onBLEStateChange";
static NSString * const kEventDeviceConnected    = @"onDeviceConnected";
static NSString * const kEventDeviceDisconnected = @"onDeviceDisconnected";
static NSString * const kEventScanError          = @"onScanError";

// JS event names — Phase 2
static NSString * const kEventRSSIUpdate         = @"onRSSIUpdate";
static NSString * const kEventRFAdaptation       = @"onRFAdaptation";
static NSString * const kEventClockSyncUpdate    = @"onClockSyncUpdate";
static NSString * const kEventSignalDegraded     = @"onSignalDegraded";
static NSString * const kEventFallbackRequired   = @"onFallbackRequired";
static NSString * const kEventFallbackCleared    = @"onFallbackCleared";

// ---------------------------------------------------------------------------
// Private interface extension
// ---------------------------------------------------------------------------

@interface CoreEliteBLEModule () {
#ifdef __cplusplus
    std::shared_ptr<CoreElite::BLETimingBuffer>   _buffer;
    std::shared_ptr<facebook::react::CallInvoker> _callInvoker;
    std::shared_ptr<CoreElite::ClockSyncEngine>   _clockSync;
    std::shared_ptr<CoreElite::RSSIMonitor>       _rssiMonitor;
#endif

    // CBCentralManager queue — all CBCentral/CBPeripheral delegate callbacks fire here
    dispatch_queue_t _bleQueue;

    // CBPeripheralManager queue — separate from central queue to avoid deadlock
    dispatch_queue_t _pmQueue;

    // RSSI polling timer — fires on _bleQueue every kRSSIPollInterval seconds
    dispatch_source_t _rssiTimer;

    // Clock sync ping timer — fires on _bleQueue every kSyncPingInterval seconds
    dispatch_source_t _syncTimer;

    // PHY transition watchdog — if no reconnect within kPHYTransitionTimeout, trigger fallback
    dispatch_source_t _phyWatchdogTimer;

    // Whether this device is acting as sync master (lowest nodeId)
    BOOL _isSyncMaster;

    // This device's nodeId (from startSyncService:)
    NSString * _nodeId;

    // Flag: PHY transition in progress — suppress normal reconnect logic
    BOOL _phyTransitionInProgress;

    // Flag: fallback mode active — suppress BLE timing path
    BOOL _fallbackActive;
}

@property (nonatomic, strong) CBCentralManager         *centralManager;
@property (nonatomic, strong) CBPeripheralManager      *peripheralManager;
@property (nonatomic, strong) NSMutableArray<CBPeripheral *> *connectedTimingChips;
@property (nonatomic, strong) NSMutableArray<CBPeripheral *> *connectedSyncPeers;
@property (nonatomic, strong) NSMutableDictionary<NSString *, CBPeripheral *> *syncPeersByUUID;
@property (nonatomic, copy,   nullable) NSString       *scanNamePrefix;
@property (nonatomic, assign) NSInteger                reconnectAttempts;
@property (nonatomic, assign) BOOL                     hasListeners;

// Sync service GATT objects (used when acting as master Peripheral)
@property (nonatomic, strong, nullable) CBMutableCharacteristic *syncWriteChar;
@property (nonatomic, strong, nullable) CBMutableCharacteristic *syncNotifyChar;
@property (nonatomic, strong, nullable) CBMutableService        *syncService;

// Sync write/notify characteristics found on a connected master (when acting as slave Central)
@property (nonatomic, strong, nullable) CBCharacteristic *peerSyncWriteChar;
@property (nonatomic, strong, nullable) CBCharacteristic *peerSyncNotifyChar;

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

    // Inject clock function — captures CLOCK_MONOTONIC_RAW
    auto clockFn = []() -> uint64_t {
        return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
    };
    _clockSync   = std::make_shared<CoreElite::ClockSyncEngine>(clockFn);
    _rssiMonitor = std::make_shared<CoreElite::RSSIMonitor>();
#endif

    _connectedTimingChips = [NSMutableArray array];
    _connectedSyncPeers   = [NSMutableArray array];
    _syncPeersByUUID      = [NSMutableDictionary dictionary];
    _reconnectAttempts    = 0;
    _hasListeners         = NO;
    _isSyncMaster         = NO;
    _phyTransitionInProgress = NO;
    _fallbackActive       = NO;

    // CBCentralManager: dedicated serial queue for timing chip connections
    _bleQueue = dispatch_queue_create("com.coreelite.ble.central", DISPATCH_QUEUE_SERIAL);
    _centralManager = [[CBCentralManager alloc]
        initWithDelegate:self
                   queue:_bleQueue
                 options:@{ CBCentralManagerOptionShowPowerAlertKey: @YES }];

    // CBPeripheralManager: separate queue — avoids deadlock if both fire simultaneously
    _pmQueue = dispatch_queue_create("com.coreelite.ble.peripheral", DISPATCH_QUEUE_SERIAL);
    _peripheralManager = [[CBPeripheralManager alloc]
        initWithDelegate:self
                   queue:_pmQueue
                 options:nil];
}

// ---------------------------------------------------------------------------
// RCTEventEmitter — required overrides
// ---------------------------------------------------------------------------

- (NSArray<NSString *> *)supportedEvents {
    return @[
        // Phase 1
        kEventTimingEvent,
        kEventBLEStateChange,
        kEventDeviceConnected,
        kEventDeviceDisconnected,
        kEventScanError,
        // Phase 2
        kEventRSSIUpdate,
        kEventRFAdaptation,
        kEventClockSyncUpdate,
        kEventSignalDegraded,
        kEventFallbackRequired,
        kEventFallbackCleared,
    ];
}

- (void)startObserving { _hasListeners = YES;  }
- (void)stopObserving  {
    _hasListeners = NO;
    [self _stopRSSITimer];
    [self _stopSyncTimer];
}

// ---------------------------------------------------------------------------
// JS-exported methods — Phase 1 (unchanged behaviour)
// ---------------------------------------------------------------------------

RCT_EXPORT_METHOD(startScan:(NSString *)namePrefix) {
    _scanNamePrefix    = namePrefix;
    _reconnectAttempts = 0;
    [self _startScanInternal];
}

RCT_EXPORT_METHOD(stopScan) {
    [_centralManager stopScan];
}

RCT_EXPORT_METHOD(disconnectAll) {
    [_centralManager stopScan];
    [self _stopRSSITimer];
    for (CBPeripheral *p in _connectedTimingChips) {
        [_centralManager cancelPeripheralConnection:p];
    }
    [_connectedTimingChips removeAllObjects];
}

RCT_EXPORT_METHOD(flushBuffer) {
    [self _scheduleFlushToJS];
}

// ---------------------------------------------------------------------------
// JS-exported methods — Phase 2
// ---------------------------------------------------------------------------

RCT_EXPORT_METHOD(startSyncService:(NSString *)nodeId) {
    _nodeId = [nodeId copy];
    // Sync service setup is deferred until peripheralManagerDidUpdateState:
    // fires with CBManagerStatePoweredOn.
    if (_peripheralManager.state == CBManagerStatePoweredOn) {
        [self _setupSyncServiceIfNeeded];
    }
}

RCT_EXPORT_METHOD(stopSyncService) {
    dispatch_async(_pmQueue, ^{
        [self->_peripheralManager stopAdvertising];
        [self->_peripheralManager removeAllServices];
        self->_syncService     = nil;
        self->_syncWriteChar   = nil;
        self->_syncNotifyChar  = nil;
    });
    [self _stopSyncTimer];
}

RCT_EXPORT_METHOD(triggerClockSync) {
    dispatch_async(_bleQueue, ^{
        [self _sendSyncPingToAllPeers];
    });
}

RCT_EXPORT_METHOD(resetFallback) {
    dispatch_async(_bleQueue, ^{
        self->_fallbackActive = NO;
#ifdef __cplusplus
        self->_rssiMonitor->reset();
        // Do not reset _clockSync — existing samples are still valid
#endif
        if (self->_hasListeners) {
            [self sendEventWithName:kEventFallbackCleared
                               body:@{ @"reason": @"operator_reset" }];
        }
        [self _startScanInternal];
    });
}

// ---------------------------------------------------------------------------
// Internal scan
// ---------------------------------------------------------------------------

- (void)_startScanInternal {
    if (_centralManager.state != CBManagerStatePoweredOn) return;
    if (_fallbackActive) return;

    // Scan with AllowDuplicates:NO — we only need one connection per chip.
    // When PHY transition is in progress, restart scan to capture any
    // coded-PHY advertisements the chip may broadcast.
    NSDictionary *options = @{ CBCentralManagerScanOptionAllowDuplicatesKey: @NO };
    [_centralManager scanForPeripheralsWithServices:nil options:options];
    RCTLogInfo(@"[CoreEliteBLE] Scan started. Prefix: %@", _scanNamePrefix ?: @"any");
}

// ---------------------------------------------------------------------------
// RSSI polling timer — fires every kRSSIPollInterval seconds on _bleQueue
// ---------------------------------------------------------------------------

- (void)_startRSSITimer {
    if (_rssiTimer) return;  // already running

    _rssiTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _bleQueue);
    dispatch_source_set_timer(
        _rssiTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRSSIPollInterval * NSEC_PER_SEC)),
        (uint64_t)(kRSSIPollInterval * NSEC_PER_SEC),
        (uint64_t)(100 * NSEC_PER_MSEC)  // 100ms leeway — non-critical timing
    );
    dispatch_source_set_event_handler(_rssiTimer, ^{
        for (CBPeripheral *p in self->_connectedTimingChips) {
            [p readRSSI];
        }
    });
    dispatch_resume(_rssiTimer);
}

- (void)_stopRSSITimer {
    if (_rssiTimer) {
        dispatch_source_cancel(_rssiTimer);
        _rssiTimer = nil;
    }
}

// ---------------------------------------------------------------------------
// Clock sync ping timer — fires every kSyncPingInterval seconds on _bleQueue
// ---------------------------------------------------------------------------

- (void)_startSyncTimer {
    if (_syncTimer) return;

    // Add ±5s jitter to avoid all devices pinging simultaneously in a mesh.
    // arc4random_uniform is safe to call from any queue.
    const int32_t jitterSec = (int32_t)(arc4random_uniform(10)) - 5;
    const NSTimeInterval interval = kSyncPingInterval + jitterSec;

    _syncTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _bleQueue);
    dispatch_source_set_timer(
        _syncTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(interval * NSEC_PER_SEC)),
        (uint64_t)(interval * NSEC_PER_SEC),
        (uint64_t)(500 * NSEC_PER_MSEC)  // 500ms leeway — sync timing is not sub-ms critical
    );
    dispatch_source_set_event_handler(_syncTimer, ^{
        [self _sendSyncPingToAllPeers];
    });
    dispatch_resume(_syncTimer);
}

- (void)_stopSyncTimer {
    if (_syncTimer) {
        dispatch_source_cancel(_syncTimer);
        _syncTimer = nil;
    }
}

// ---------------------------------------------------------------------------
// CBCentralManagerDelegate
// ---------------------------------------------------------------------------

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
    NSString *stateStr;
    switch (central.state) {
        case CBManagerStatePoweredOn:   stateStr = @"poweredOn";     break;
        case CBManagerStatePoweredOff:  stateStr = @"poweredOff";    break;
        case CBManagerStateResetting:   stateStr = @"resetting";     break;
        case CBManagerStateUnauthorized:stateStr = @"unauthorized";  break;
        case CBManagerStateUnsupported: stateStr = @"unsupported";   break;
        default:                        stateStr = @"unknown";       break;
    }
    if (_hasListeners) {
        [self sendEventWithName:kEventBLEStateChange body:@{ @"state": stateStr }];
    }
    if (central.state == CBManagerStatePoweredOn && _scanNamePrefix) {
        [self _startScanInternal];
    }
}

- (void)centralManager:(CBCentralManager *)central
 didDiscoverPeripheral:(CBPeripheral *)peripheral
     advertisementData:(NSDictionary<NSString *,id> *)advertisementData
                  RSSI:(NSNumber *)RSSI {

    NSString *name = peripheral.name
        ?: advertisementData[CBAdvertisementDataLocalNameKey];
    if (!name) return;

    // Route: Is this a sync peer (advertising the CoreElite Sync Service)?
    NSArray *serviceUUIDs = advertisementData[CBAdvertisementDataServiceUUIDsKey];
    CBUUID *syncUUID = [CBUUID UUIDWithString:kCESyncServiceUUID];
    BOOL isSyncPeer  = NO;
    for (CBUUID *uuid in serviceUUIDs) {
        if ([uuid isEqual:syncUUID]) { isSyncPeer = YES; break; }
    }

    if (isSyncPeer) {
        // Connect to this peer for clock sync (avoid duplicate connections)
        NSString *uuidStr = peripheral.identifier.UUIDString;
        if (!_syncPeersByUUID[uuidStr]) {
            _syncPeersByUUID[uuidStr] = peripheral;
            peripheral.delegate = self;
            [central connectPeripheral:peripheral options:nil];
            RCTLogInfo(@"[CoreEliteBLE] Sync peer found: %@", name);
        }
        return;
    }

    // Otherwise: timing chip — filter by prefix
    if (_scanNamePrefix && ![name hasPrefix:_scanNamePrefix]) return;

    RCTLogInfo(@"[CoreEliteBLE] Timing chip found: %@ RSSI: %@", name, RSSI);
    [central stopScan];
    peripheral.delegate = self;
    [_connectedTimingChips addObject:peripheral];
    [central connectPeripheral:peripheral options:nil];
}

- (void)centralManager:(CBCentralManager *)central
  didConnectPeripheral:(CBPeripheral *)peripheral {

    const BOOL isSyncPeer = (_syncPeersByUUID[peripheral.identifier.UUIDString] != nil);

    if (isSyncPeer) {
        RCTLogInfo(@"[CoreEliteBLE] Sync peer connected: %@", peripheral.name);
        [_connectedSyncPeers addObject:peripheral];
        [peripheral discoverServices:@[
            [CBUUID UUIDWithString:kCESyncServiceUUID]
        ]];
        // Start sync timer on first peer connection
        [self _startSyncTimer];
        return;
    }

    // Timing chip
    _reconnectAttempts = 0;
    _phyTransitionInProgress = NO;
    [self _cancelPHYWatchdog];

#ifdef __cplusplus
    // If PHY transition was pending, notify the monitor that we're now on
    // whichever PHY the connection negotiated.
    _rssiMonitor->notifyPHYDowngraded();  // May be 1M or Coded depending on chip support
#endif

    RCTLogInfo(@"[CoreEliteBLE] Timing chip connected: %@", peripheral.name);
    if (_hasListeners) {
        [self sendEventWithName:kEventDeviceConnected body:@{
            @"uuid": peripheral.identifier.UUIDString,
            @"name": peripheral.name ?: @"unknown",
        }];
    }

    [peripheral discoverServices:nil];
    [self _startRSSITimer];
}

- (void)centralManager:(CBCentralManager *)central
didFailToConnectPeripheral:(CBPeripheral *)peripheral
                 error:(NSError *)error {
    RCTLogError(@"[CoreEliteBLE] Failed to connect %@: %@", peripheral.name, error);
    [self _handleDisconnectForPeripheral:peripheral];
}

- (void)centralManager:(CBCentralManager *)central
didDisconnectPeripheral:(CBPeripheral *)peripheral
                  error:(NSError *)error {
    RCTLogWarn(@"[CoreEliteBLE] Disconnected: %@ error: %@", peripheral.name, error);

    const BOOL isSyncPeer = (_syncPeersByUUID[peripheral.identifier.UUIDString] != nil);
    if (isSyncPeer) {
        [_connectedSyncPeers removeObject:peripheral];
        [_syncPeersByUUID removeObjectForKey:peripheral.identifier.UUIDString];
        // Attempt to rediscover sync peers via scan
        [self _startScanInternal];
        return;
    }

    [_connectedTimingChips removeObject:peripheral];
    if (_hasListeners) {
        [self sendEventWithName:kEventDeviceDisconnected body:@{
            @"uuid": peripheral.identifier.UUIDString,
            @"name": peripheral.name ?: @"unknown",
            @"error": error.localizedDescription ?: @"",
        }];
    }

    // Mark clock as desynced — timestamps from this chip are unreliable until resync
#ifdef __cplusplus
    _clockSync->markDesynced();
#endif

    [self _handleDisconnectForPeripheral:peripheral];
}

// Shared disconnect handler for timing chips (not sync peers)
- (void)_handleDisconnectForPeripheral:(CBPeripheral *)peripheral {
    if (_phyTransitionInProgress) {
        // Intentional disconnect as part of PHY downgrade — reconnect immediately,
        // allowing the new scan to discover coded-PHY advertisements.
        RCTLogInfo(@"[CoreEliteBLE] PHY transition disconnect — restarting scan");
        [self _startScanInternal];
        return;
    }

    [self _scheduleReconnectForPeripheral:peripheral];
}

- (void)_scheduleReconnectForPeripheral:(CBPeripheral *)peripheral {
    if (_reconnectAttempts >= kMaxReconnectAttempts) {
        RCTLogError(@"[CoreEliteBLE] Max reconnect attempts for %@. Triggering fallback.",
                    peripheral.name);
        [self _triggerFallback:@"max_reconnect_exceeded"];
        return;
    }

    _reconnectAttempts++;
    const NSTimeInterval delay = kReconnectDelayBase * pow(2.0, _reconnectAttempts - 1);
    RCTLogInfo(@"[CoreEliteBLE] Reconnect attempt %ld in %.1fs",
               (long)_reconnectAttempts, delay);

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)),
        _bleQueue,
        ^{ [self->_centralManager connectPeripheral:peripheral options:nil]; }
    );
}

// ---------------------------------------------------------------------------
// CBPeripheralDelegate — timing chip characteristics
// ---------------------------------------------------------------------------

- (void)peripheral:(CBPeripheral *)peripheral
  didDiscoverServices:(NSError *)error {
    if (error) {
        RCTLogError(@"[CoreEliteBLE] Service discovery error: %@", error);
        return;
    }
    for (CBService *service in peripheral.services) {
        // If this is a sync peer, only discover sync characteristics
        if ([service.UUID isEqual:[CBUUID UUIDWithString:kCESyncServiceUUID]]) {
            [peripheral discoverCharacteristics:@[
                [CBUUID UUIDWithString:kCESyncCharWriteUUID],
                [CBUUID UUIDWithString:kCESyncCharNotifyUUID],
            ] forService:service];
        } else {
            // Timing chip — discover all characteristics until UUIDs are confirmed
            [peripheral discoverCharacteristics:nil forService:service];
        }
    }
}

- (void)peripheral:(CBPeripheral *)peripheral
didDiscoverCharacteristicsForService:(CBService *)service
             error:(NSError *)error {
    if (error) {
        RCTLogError(@"[CoreEliteBLE] Char discovery error: %@", error);
        return;
    }

    const BOOL isSyncService = [service.UUID isEqual:
        [CBUUID UUIDWithString:kCESyncServiceUUID]];

    for (CBCharacteristic *c in service.characteristics) {
        if (isSyncService) {
            if ([c.UUID isEqual:[CBUUID UUIDWithString:kCESyncCharWriteUUID]]) {
                _peerSyncWriteChar = c;
            } else if ([c.UUID isEqual:[CBUUID UUIDWithString:kCESyncCharNotifyUUID]]) {
                _peerSyncNotifyChar = c;
                [peripheral setNotifyValue:YES forCharacteristic:c];
            }
        } else if (c.properties & CBCharacteristicPropertyNotify) {
            [peripheral setNotifyValue:YES forCharacteristic:c];
        }
    }

    // Both sync chars discovered — trigger an immediate sync ping
    if (_peerSyncWriteChar && _peerSyncNotifyChar) {
        RCTLogInfo(@"[CoreEliteBLE] Sync service ready on %@", peripheral.name);
        [self _sendSyncPingToPeer:peripheral];
    }
}

// ---------------------------------------------------------------------------
// RSSI read callback
// ---------------------------------------------------------------------------

- (void)peripheral:(CBPeripheral *)peripheral
       didReadRSSI:(NSNumber *)RSSI
             error:(NSError *)error {
    // FIRST STATEMENT: timestamp (used if caller needs timing — not in this path,
    // but consistent with the module's timing discipline)
    const uint64_t mono_ns = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
    (void)mono_ns;  // RSSI path does not use the timestamp directly

    if (error) {
        // RSSI read errors are common during interference — log but do not alert
        RCTLogWarn(@"[CoreEliteBLE] RSSI read error: %@", error.localizedDescription);
        return;
    }

    const int8_t rssiDbm = (int8_t)[RSSI intValue];

#ifdef __cplusplus
    const CoreElite::RFAdaptationState prevState = _rssiMonitor->state();
    const CoreElite::RFAdaptationState newState  = _rssiMonitor->addReading(rssiDbm);
    const float smoothed = _rssiMonitor->smoothedRSSI();
#endif

    // Always emit RSSI update for dashboard monitoring
    if (_hasListeners) {
        [self sendEventWithName:kEventRSSIUpdate body:@{
            @"uuid":          peripheral.identifier.UUIDString,
            @"rssi":          @(rssiDbm),
            @"rssi_smoothed": @(smoothed),
        }];
    }

#ifdef __cplusplus
    // State changed — emit RF adaptation event
    if (newState != prevState) {
        [self _emitRFAdaptationState:newState peripheral:peripheral];
    }

    // PHY downgrade trigger
    if (_rssiMonitor->shouldDowngradePHY() && !_phyTransitionInProgress) {
        [self _initiatePHYDowngrade:peripheral];
    }

    // Fallback trigger
    if (_rssiMonitor->shouldTriggerFallback() && !_fallbackActive) {
        [self _triggerFallback:@"critical_rssi"];
    }
#endif
}

// ---------------------------------------------------------------------------
// PHY management (iOS — disconnect + reconnect strategy)
//
// iOS CoreBluetooth does not expose mid-connection PHY switching from the
// Central role. We disconnect and immediately re-scan. If the timing chip
// supports Coded PHY advertisements, the reconnection will negotiate it.
// If not (chip only advertises 1M), the reconnection is still 1M but the
// disconnect/reconnect gives the BLE stack a clean connection state.
//
// A PHY watchdog fires after kPHYTransitionTimeout seconds. If no reconnect
// occurred by then (chip went out of range during the gap), we trigger fallback.
// ---------------------------------------------------------------------------

- (void)_initiatePHYDowngrade:(CBPeripheral *)peripheral {
    _phyTransitionInProgress = YES;
    RCTLogInfo(@"[CoreEliteBLE] RSSI %.1f dBm — initiating PHY transition for %@",
               _rssiMonitor->smoothedRSSI(), peripheral.name);

    if (_hasListeners) {
        [self sendEventWithName:kEventSignalDegraded body:@{
            @"uuid":           peripheral.identifier.UUIDString,
            @"rssi_smoothed":  @(_rssiMonitor->smoothedRSSI()),
            @"action":         @"phy_transition_initiated",
            @"note":           @"iOS: disconnect+reconnect to negotiate Coded PHY if chip supports it",
        }];
    }

    // Start watchdog before disconnect in case disconnect callback is delayed
    [self _startPHYWatchdog:peripheral];

    // Disconnect — didDisconnectPeripheral will restart scan via _phyTransitionInProgress flag
    [_centralManager cancelPeripheralConnection:peripheral];
}

- (void)_startPHYWatchdog:(CBPeripheral *)peripheral {
    [self _cancelPHYWatchdog];

    _phyWatchdogTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _bleQueue);
    dispatch_source_set_timer(
        _phyWatchdogTimer,
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPHYTransitionTimeout * NSEC_PER_SEC)),
        DISPATCH_TIME_FOREVER,  // one-shot
        (uint64_t)(500 * NSEC_PER_MSEC)
    );
    dispatch_source_set_event_handler(_phyWatchdogTimer, ^{
        if (self->_phyTransitionInProgress) {
            RCTLogError(@"[CoreEliteBLE] PHY transition timeout — triggering fallback");
            [self _triggerFallback:@"phy_transition_timeout"];
        }
        dispatch_source_cancel(self->_phyWatchdogTimer);
        self->_phyWatchdogTimer = nil;
    });
    dispatch_resume(_phyWatchdogTimer);
}

- (void)_cancelPHYWatchdog {
    if (_phyWatchdogTimer) {
        dispatch_source_cancel(_phyWatchdogTimer);
        _phyWatchdogTimer = nil;
    }
}

// ---------------------------------------------------------------------------
// Fallback trigger
// ---------------------------------------------------------------------------

- (void)_triggerFallback:(NSString *)reason {
    _fallbackActive = YES;
    [self _stopRSSITimer];
    [self _stopSyncTimer];
    [self _cancelPHYWatchdog];

#ifdef __cplusplus
    _rssiMonitor->notifyFallbackActive();
    _clockSync->markDesynced();
#endif

    RCTLogError(@"[CoreEliteBLE] FALLBACK REQUIRED — reason: %@. "
                @"Manual entry mode active. Call resetFallback when signal recovers.", reason);

    if (_hasListeners) {
        [self sendEventWithName:kEventFallbackRequired body:@{
            @"reason":       reason,
            @"rssi":         @(_rssiMonitor ? _rssiMonitor->smoothedRSSI() : 0.0f),
            @"synced":       @(_clockSync ? _clockSync->isSynced() : NO),
            @"description":  @"BLE timing path disabled. Use manual result entry until "
                              @"signal recovers and resetFallback() is called.",
        }];
    }
}

// ---------------------------------------------------------------------------
// RF adaptation state event emitter
// ---------------------------------------------------------------------------

- (void)_emitRFAdaptationState:(CoreElite::RFAdaptationState)state
                    peripheral:(CBPeripheral *)peripheral {
    NSString *stateStr;
    switch (state) {
        case CoreElite::RFAdaptationState::Normal:         stateStr = @"normal";          break;
        case CoreElite::RFAdaptationState::Degrading:      stateStr = @"degrading";       break;
        case CoreElite::RFAdaptationState::PHYDowngrading: stateStr = @"phy_downgrading"; break;
        case CoreElite::RFAdaptationState::PHYCoded:       stateStr = @"phy_coded";       break;
        case CoreElite::RFAdaptationState::CriticalSignal: stateStr = @"critical_signal"; break;
        case CoreElite::RFAdaptationState::FallbackActive: stateStr = @"fallback_active"; break;
    }
    if (_hasListeners) {
        [self sendEventWithName:kEventRFAdaptation body:@{
            @"uuid":          peripheral.identifier.UUIDString,
            @"state":         stateStr,
            @"rssi_smoothed": @(_rssiMonitor->smoothedRSSI()),
        }];
    }
}

// ---------------------------------------------------------------------------
// THE CRITICAL PATH — timing chip data received
// clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) MUST be the first statement.
// ---------------------------------------------------------------------------

- (void)peripheral:(CBPeripheral *)peripheral
didUpdateValueForCharacteristic:(CBCharacteristic *)characteristic
             error:(NSError *)error {

    // =========================================================
    // TIMESTAMP CAPTURE: FIRST STATEMENT — DO NOT REORDER
    // =========================================================
    const uint64_t monotonic_ns = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
    // =========================================================

    // Sync PONG path — handle before anything else
    if ([characteristic.UUID isEqual:[CBUUID UUIDWithString:kCESyncCharNotifyUUID]]) {
        // T4 is the monotonic_ns captured above — correct, this is the PONG arrival time
        [self _handleSyncPong:characteristic.value t4Ns:monotonic_ns];
        return;
    }

    if (error) {
        RCTLogError(@"[CoreEliteBLE] Characteristic update error: %@", error);
        return;
    }

    NSData *value = characteristic.value;
    if (!value || value.length == 0) return;

    // Fallback mode: discard all BLE timing data — operator must use manual entry
    if (_fallbackActive) return;

#ifdef __cplusplus
    // Apply clock sync offset to the raw timestamp
    const uint64_t corrected_ns = _clockSync->applyOffset(monotonic_ns);
    const bool isSynced         = _clockSync->isSynced();

    // Assemble extended timing event packet
    CoreElite::TimingEvent event{};
    event.monotonic_ns = corrected_ns;
    event.byte_count   = MIN(value.length, CoreElite::kRawBytesCapacity);
    memcpy(event.raw_bytes, value.bytes, event.byte_count);

    NSString *name = peripheral.name ?: peripheral.identifier.UUIDString;
    strncpy(event.chip_id, name.UTF8String, CoreElite::kChipIdCapacity - 1);
    event.chip_id[CoreElite::kChipIdCapacity - 1] = '\0';

    // Embed RSSI and sync state into raw_bytes[0..1] for the JS layer
    // (these override the first two bytes of the timing packet header)
    const int8_t rssiNow = (int8_t)_rssiMonitor->smoothedRSSI();
    const uint8_t phyByte = (_rssiMonitor->state() == CoreElite::RFAdaptationState::PHYCoded)
        ? 0x04 : 0x01;
    uint8_t flags = 0x00;
    if (isSynced)     flags |= 0x01;
    if (_fallbackActive) flags |= 0x02;
    if (_rssiMonitor->state() == CoreElite::RFAdaptationState::PHYCoded) flags |= 0x04;

    // The raw_bytes carry vendor packet data; we transmit rssi/phy/flags and
    // corrected_ns as separate fields in the JS event (see flush lambda below)
    // to avoid corrupting vendor packet bytes.

    const bool enqueued = _buffer->enqueue(event);
    if (!enqueued) {
        RCTLogWarn(@"[CoreEliteBLE] Buffer overflow — event dropped");
        return;
    }

    [self _scheduleFlushToJS];
#endif
}

// ---------------------------------------------------------------------------
// Clock sync — slave (initiator) side
// ---------------------------------------------------------------------------

- (void)_sendSyncPingToAllPeers {
    for (CBPeripheral *peer in _connectedSyncPeers) {
        [self _sendSyncPingToPeer:peer];
    }
}

- (void)_sendSyncPingToPeer:(CBPeripheral *)peer {
    if (!_peerSyncWriteChar) return;

#ifdef __cplusplus
    CoreElite::SyncPingPacket ping = _clockSync->buildPing();

    NSData *data = [NSData dataWithBytes:&ping length:sizeof(ping)];
    // WriteWithoutResponse: minimises T1→T2 gap by skipping ACK round-trip.
    // Trade-off: if the packet is lost, processPong will never be called for
    // this seq; recordMissedPing handles that via the ping timeout below.
    [peer writeValue:data
   forCharacteristic:_peerSyncWriteChar
                type:CBCharacteristicWriteWithoutResponse];

    // Start a timeout to record a missed ping if no PONG arrives in time
    const uint32_t seq = ping.seq;
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSyncPingTimeout * NSEC_PER_SEC)),
        _bleQueue,
        ^{
            // If this seq was already processed successfully, recordMissedPing
            // is not called (processPong sets the pending slot inactive).
            // We have no direct way to check here without tracking seq separately,
            // so we conservatively record a miss and let the median filter absorb
            // any false positives. Actual desync requires kMissedPingLimit consecutive misses.
            if (!self->_clockSync->isSynced() &&
                self->_clockSync->sampleCount() == 0) {
                self->_clockSync->recordMissedPing();
                if (self->_clockSync->isDesynced() && !self->_fallbackActive) {
                    [self _triggerFallback:@"clock_desync"];
                }
            }
        }
    );
#endif
}

// ---------------------------------------------------------------------------
// Clock sync — PONG received (slave side)
// t4_ns: captured at the TOP of didUpdateValueForCharacteristic
// ---------------------------------------------------------------------------

- (void)_handleSyncPong:(NSData *)data t4Ns:(uint64_t)t4_ns {
    if (!data || data.length < sizeof(CoreElite::SyncPongPacket)) {
        RCTLogWarn(@"[CoreEliteBLE] Received truncated PONG — %zu bytes, expected %zu",
                   data.length, sizeof(CoreElite::SyncPongPacket));
        return;
    }

#ifdef __cplusplus
    CoreElite::SyncPongPacket pong;
    memcpy(&pong, data.bytes, sizeof(pong));

    if (pong.type != 0x11) return;  // Not a PONG — malformed, discard

    // Master signals it is itself desynced — propagate the warning but still
    // process the sample (it may still improve our estimate)
    const bool masterDesynced = (pong.flags & 0x01) != 0;

    const bool updated = _clockSync->processPong(pong, t4_ns);
    if (!updated) return;  // Stale or duplicate

    _clockSync->resetMissedPings();

    const int64_t  offsetNs   = _clockSync->currentOffsetNs();
    const uint32_t sampleCnt  = (uint32_t)_clockSync->sampleCount();
    const bool     synced      = _clockSync->isSynced();

    if (_hasListeners) {
        [self sendEventWithName:kEventClockSyncUpdate body:@{
            @"offset_ns":      [NSString stringWithFormat:@"%lld", (long long)offsetNs],
            @"offset_ms":      @((double)offsetNs / 1e6),
            @"sample_count":   @(sampleCnt),
            @"synced":         @(synced),
            @"master_desynced":@(masterDesynced),
            @"within_budget":  @(synced),   // true iff |offset| ≤ 1.44ms
        }];
    }

    // If |offset| > kMaxDriftNs and we have ≥3 samples (filter has converged),
    // the clocks have drifted beyond budget — trigger immediate resync
    if (!synced && sampleCnt >= 3) {
        RCTLogWarn(@"[CoreEliteBLE] Clock drift %.3fms exceeds budget (±1.44ms) — resyncing",
                   (double)offsetNs / 1e6);
        [self _sendSyncPingToAllPeers];
    }
#endif
}

// ---------------------------------------------------------------------------
// CBPeripheralManagerDelegate — master (sync service) side
// ---------------------------------------------------------------------------

- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
    if (peripheral.state == CBManagerStatePoweredOn && _nodeId) {
        [self _setupSyncServiceIfNeeded];
    }
}

- (void)_setupSyncServiceIfNeeded {
    if (_syncService) return;  // Already set up

    // Write characteristic (slave → master): WriteWithoutResponse
    _syncWriteChar = [[CBMutableCharacteristic alloc]
        initWithType:[CBUUID UUIDWithString:kCESyncCharWriteUUID]
          properties:CBCharacteristicPropertyWriteWithoutResponse
               value:nil
         permissions:CBAttributePermissionsWriteable];

    // Notify characteristic (master → slave): Notify
    _syncNotifyChar = [[CBMutableCharacteristic alloc]
        initWithType:[CBUUID UUIDWithString:kCESyncCharNotifyUUID]
          properties:CBCharacteristicPropertyNotify
               value:nil
         permissions:CBAttributePermissionsReadable];

    _syncService = [[CBMutableService alloc]
        initWithType:[CBUUID UUIDWithString:kCESyncServiceUUID]
             primary:YES];
    _syncService.characteristics = @[ _syncWriteChar, _syncNotifyChar ];

    [_peripheralManager addService:_syncService];
    // Advertising begins in peripheralManager:didAddService:error:
}

- (void)peripheralManager:(CBPeripheralManager *)peripheral
            didAddService:(CBService *)service
                    error:(NSError *)error {
    if (error) {
        RCTLogError(@"[CoreEliteBLE] Failed to add sync service: %@", error);
        return;
    }
    [_peripheralManager startAdvertising:@{
        CBAdvertisementDataServiceUUIDsKey: @[ [CBUUID UUIDWithString:kCESyncServiceUUID] ],
        CBAdvertisementDataLocalNameKey:    [NSString stringWithFormat:@"CE_SYNC_%@", _nodeId],
    }];
    RCTLogInfo(@"[CoreEliteBLE] Sync service advertising as CE_SYNC_%@", _nodeId);
}

- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral
                                       error:(NSError *)error {
    if (error) {
        RCTLogError(@"[CoreEliteBLE] Advertising start error: %@", error);
    }
}

// Slave writes PING to us — we are the master
- (void)peripheralManager:(CBPeripheralManager *)peripheral
    didReceiveWriteRequests:(NSArray<CBATTRequest *> *)requests {

    for (CBATTRequest *request in requests) {
        // =====================================================================
        // TIMESTAMP CAPTURE: FIRST STATEMENT inside the loop — DO NOT REORDER
        // =====================================================================
        const uint64_t t2_ns = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
        // =====================================================================

        if (![request.characteristic.UUID isEqual:
              [CBUUID UUIDWithString:kCESyncCharWriteUUID]]) {
            [peripheral respondToRequest:request
                              withResult:CBATTErrorRequestNotSupported];
            continue;
        }

        NSData *data = request.value;
        if (!data || data.length < sizeof(CoreElite::SyncPingPacket)) {
            [peripheral respondToRequest:request withResult:CBATTErrorInvalidPdu];
            continue;
        }

#ifdef __cplusplus
        CoreElite::SyncPingPacket ping;
        memcpy(&ping, data.bytes, sizeof(ping));

        if (ping.type != 0x10) {
            [peripheral respondToRequest:request withResult:CBATTErrorInvalidPdu];
            continue;
        }

        // Build PONG — T3 captured inside buildPong() immediately before return
        CoreElite::SyncPongPacket pong = _clockSync->buildPong(ping, t2_ns);

        NSData *pongData = [NSData dataWithBytes:&pong length:sizeof(pong)];

        // Notify the requesting slave with the PONG
        // updateValue returns NO if the notify queue is full — we discard in that
        // case (the slave's missed-ping timeout will trigger a retry).
        BOOL sent = [self->_peripheralManager
            updateValue:pongData
      forCharacteristic:_syncNotifyChar
   onSubscribedCentrals:nil];  // nil = broadcast to all subscribed centrals

        if (!sent) {
            RCTLogWarn(@"[CoreEliteBLE] PONG notify queue full — slave will retry");
        }
#endif

        // WriteWithoutResponse does not require respondToRequest — but responding
        // is safe and provides flow control for the peripheral manager queue.
        if (request.characteristic.properties & CBCharacteristicPropertyWrite) {
            [peripheral respondToRequest:request withResult:CBATTErrorSuccess];
        }
    }
}

// ---------------------------------------------------------------------------
// Buffer flush — JS thread via CallInvoker
// ---------------------------------------------------------------------------

- (void)_scheduleFlushToJS {
#ifdef __cplusplus
    if (!_hasListeners) return;

    auto buffer    = _buffer;
    auto clockSync = _clockSync;
    auto rssiMon   = _rssiMonitor;
    __weak CoreEliteBLEModule *weakSelf = self;

    auto flushLambda = [weakSelf, buffer, clockSync, rssiMon]() {
        CoreEliteBLEModule *strongSelf = weakSelf;
        if (!strongSelf) return;

        std::vector<CoreElite::TimingEvent> events = buffer->flush();
        if (events.empty()) return;

        NSMutableArray *jsEvents = [NSMutableArray arrayWithCapacity:events.size()];
        for (const auto &evt : events) {
            NSMutableString *hexStr = [NSMutableString
                stringWithCapacity:evt.byte_count * 2];
            for (size_t i = 0; i < evt.byte_count; i++) {
                [hexStr appendFormat:@"%02x", evt.raw_bytes[i]];
            }
            [jsEvents addObject:@{
                // monotonic_ns is already clock-corrected (applyOffset applied above)
                @"corrected_ns": [NSString stringWithFormat:@"%llu",
                                  (unsigned long long)evt.monotonic_ns],
                @"raw_hex":      hexStr,
                @"byte_count":   @(evt.byte_count),
                @"chip_id":      [NSString stringWithUTF8String:evt.chip_id],
                @"synced":       @(clockSync->isSynced()),
                @"offset_ms":    @((double)clockSync->currentOffsetNs() / 1e6),
                @"rssi":         @((int)rssiMon->smoothedRSSI()),
                @"fallback":     @NO,  // fallbackActive prevents reaching this path
            }];
        }

        if (strongSelf->_hasListeners) {
            [strongSelf sendEventWithName:kEventTimingEvent
                                     body:@{ @"events": jsEvents }];
        }
    };

    if (_callInvoker) {
        _callInvoker->invokeAsync(std::move(flushLambda));
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{ flushLambda(); });
    }
#endif
}

- (void)_flushBufferToJS { [self _scheduleFlushToJS]; }

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
