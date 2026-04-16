/**
 * index.ts
 * Core Elite — @core-elite/native-ble public API
 *
 * This module is the single entry point for the JS/TS application layer.
 * It wraps the native TurboModule in a typed EventEmitter and exposes
 * decoded TimingResult objects (centiseconds → seconds) to consumers.
 *
 * Architecture boundary:
 *   Native layer  → emits raw NativeTimingEvent (hex bytes, monotonic_ns string)
 *   This layer    → decodes, validates, and emits typed TimingResult
 *   Application   → consumes TimingResult, never touches raw BLE bytes
 */

import { NativeEventEmitter, Platform } from 'react-native';
import NativeBLETimingModule from './NativeBLETimingModule';
import type {
  NativeTimingEvent,
  BLEStateChangeEvent,
  DeviceConnectionEvent,
  DeviceDisconnectionEvent,
  ScanErrorEvent,
  RFAdaptationState,
  RSSIUpdateEvent,
  RFAdaptationEvent,
  ClockSyncUpdateEvent,
  SignalDegradedEvent,
  FallbackRequiredEvent,
} from './NativeBLETimingModule';

export type { NativeTimingEvent };
export type {
  RFAdaptationState,
  RSSIUpdateEvent,
  RFAdaptationEvent,
  ClockSyncUpdateEvent,
  SignalDegradedEvent,
  FallbackRequiredEvent,
};

// ---------------------------------------------------------------------------
// Decoded TimingResult
//
// This is what the application layer works with. The raw monotonic_ns and
// hex bytes are preserved alongside the decoded values for debugging and
// for HLC timestamp generation (Phase 2).
// ---------------------------------------------------------------------------
export type TimingResult = {
  /** Application-layer unique ID (generated here, not from native). */
  id: string;

  /** Hardware monotonic timestamp as BigInt (nanoseconds).
   *  Use for relative elapsed time comparisons within a session only.
   *  Do NOT use directly as updated_at — that requires HLC (Phase 2, v3 §3.1.2). */
  monotonic_ns: bigint;

  /** Elapsed time in seconds, decoded from the BLE packet.
   *  Freelap: raw UInt32LE centiseconds / 100
   *  Dashr: proprietary — decoded via parseDashrPacket() when UUIDs confirmed */
  time_seconds: number;

  /** Source peripheral identifier. */
  chip_id: string;

  /** ISO-8601 wall-clock timestamp at callback receipt (for display only).
   *  NOT used for conflict resolution — see monotonic_ns + HLC in Phase 2. */
  received_at: string;

  /** Raw BLE bytes preserved for debugging / re-decoding. */
  raw_hex: string;

  /** Validation status from the four-gate pipeline (v2 §2.2.4). */
  validation: ValidationResult;
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: ValidationFailureReason; flagged_value: number };

export type ValidationFailureReason =
  | 'false_start'          // reaction time < 120ms floor (Pain & Hibbs 2007)
  | 'below_physical_floor' // 40yd < 3.70s — impossible
  | 'above_max_threshold'  // 40yd > 9.00s — sensor malfunction
  | 'extraordinary_result' // 40yd < 4.21s — below world-record, manual review
  | 'decode_error';        // raw bytes could not be decoded

// ---------------------------------------------------------------------------
// Validation gates (v2 §2.2.4)
// Thresholds are for the 40-yard dash. Drill-specific overrides are applied
// by the consumer when calling validateTimingResult().
// ---------------------------------------------------------------------------
const VALIDATION_GATES = {
  FALSE_START_FLOOR_MS:     120,   // Pain & Hibbs 2007, PMID 17127583
  FORTY_YARD_PHYSICAL_FLOOR: 3.70, // Absolute biomechanical impossibility
  FORTY_YARD_MAX_THRESHOLD:  9.00, // Sensor malfunction above this
  FORTY_YARD_WORLD_RECORD:   4.21, // Below this → manual review flag
} as const;

// ---------------------------------------------------------------------------
// Freelap packet decoder
//
// Freelap FxChip BLE notification format (reverse-engineered):
//   Bytes 0–3: UInt32LE raw centiseconds
//   Remaining bytes: chip metadata (not decoded in v1)
//
// This function will need updating when Freelap confirms their packet format.
// ---------------------------------------------------------------------------
function parseFreelap(rawHex: string): number | null {
  if (rawHex.length < 8) return null; // Need at least 4 bytes (8 hex chars)

  try {
    const b0 = parseInt(rawHex.slice(0, 2), 16);
    const b1 = parseInt(rawHex.slice(2, 4), 16);
    const b2 = parseInt(rawHex.slice(4, 6), 16);
    const b3 = parseInt(rawHex.slice(6, 8), 16);

    // Little-endian UInt32
    const centiseconds = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    return centiseconds / 100;
  } catch {
    return null;
  }
}

// Dashr packet decoder — UNKNOWN until vendor confirms protocol.
// Returns null; falls through to manual entry path.
function parseDashr(_rawHex: string): number | null {
  return null; // Known Unknown (v1 Appendix A)
}

function decodePacket(chipId: string, rawHex: string): number | null {
  const upper = chipId.toUpperCase();
  if (upper.startsWith('FREELAP')) return parseFreelap(rawHex);
  if (upper.startsWith('DASHR'))   return parseDashr(rawHex);

  // Attempt Freelap decode as default heuristic
  return parseFreelap(rawHex);
}

function validateTime(seconds: number): ValidationResult {
  if (seconds < VALIDATION_GATES.FORTY_YARD_PHYSICAL_FLOOR) {
    return { valid: false, reason: 'below_physical_floor', flagged_value: seconds };
  }
  if (seconds > VALIDATION_GATES.FORTY_YARD_MAX_THRESHOLD) {
    return { valid: false, reason: 'above_max_threshold', flagged_value: seconds };
  }
  if (seconds < VALIDATION_GATES.FORTY_YARD_WORLD_RECORD) {
    return { valid: false, reason: 'extraordinary_result', flagged_value: seconds };
  }
  return { valid: true };
}

// Session counter — incremented once per TimingResult to guarantee uniqueness
// within this JS process lifetime. Combined with a random suffix to prevent
// collisions across app restarts if the counter is ever reset.
// Date.now() is intentionally NOT used here — this ID is for application-layer
// deduplication only and must not carry any timing semantics.
let _idCounter = 0;

function generateId(): string {
  _idCounter += 1;
  // 6 random hex chars give 16^6 = 16,777,216 combinations per counter value.
  // Collision probability at combine scale (< 1,000 events) is negligible.
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `ce_${_idCounter}_${rand}`;
}

// ---------------------------------------------------------------------------
// BLETimingService — the public API consumed by the application
// ---------------------------------------------------------------------------
export type TimingEventHandler = (result: TimingResult) => void;
export type RawEventHandler = (event: NativeTimingEvent) => void;
export type StateChangeHandler = (event: BLEStateChangeEvent) => void;
export type ConnectionHandler = (event: DeviceConnectionEvent) => void;
export type DisconnectionHandler = (event: DeviceDisconnectionEvent) => void;
export type ErrorHandler = (event: ScanErrorEvent) => void;

class BLETimingService {
  private emitter: NativeEventEmitter;
  private subscriptions: ReturnType<NativeEventEmitter['addListener']>[] = [];

  constructor() {
    // NativeEventEmitter wraps the native RCTEventEmitter interface.
    // On New Architecture, this routes through the TurboModule JSI binding.
    this.emitter = new NativeEventEmitter(NativeBLETimingModule as any);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start scanning for timing gates with names matching `namePrefix`.
   * Subscribe to events before calling startScan to avoid missing the first event.
   */
  startScan(namePrefix: string = 'FREELAP'): void {
    NativeBLETimingModule.startScan(namePrefix);
  }

  stopScan(): void {
    NativeBLETimingModule.stopScan();
  }

  disconnectAll(): void {
    NativeBLETimingModule.disconnectAll();
  }

  /**
   * Release all JS-side event subscriptions.
   * Call in componentWillUnmount / useEffect cleanup.
   */
  removeAllListeners(): void {
    // Capture count BEFORE clearing — this.subscriptions.length is 0 after the
    // array is reassigned, so the native module would receive removeListeners(0)
    // if the count is read after the clear.
    const count = this.subscriptions.length;
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
    if (count > 0) {
      NativeBLETimingModule.removeListeners(count);
    }
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Primary subscription: decoded, validated TimingResult objects.
   * This is what StationMode.tsx will consume in the React Native port.
   */
  onTimingResult(handler: TimingEventHandler): () => void {
    const sub = this.emitter.addListener('onTimingEvent', (body: { events: NativeTimingEvent[] }) => {
      for (const nativeEvent of body.events) {
        const seconds = decodePacket(nativeEvent.chip_id, nativeEvent.raw_hex);

        if (seconds === null) {
          const result: TimingResult = {
            id:           generateId(),
            monotonic_ns: BigInt(nativeEvent.monotonic_ns),
            time_seconds: 0,
            chip_id:      nativeEvent.chip_id,
            received_at:  new Date().toISOString(),
            raw_hex:      nativeEvent.raw_hex,
            validation:   { valid: false, reason: 'decode_error', flagged_value: 0 },
          };
          handler(result);
          continue;
        }

        const result: TimingResult = {
          id:           generateId(),
          monotonic_ns: BigInt(nativeEvent.monotonic_ns),
          time_seconds: seconds,
          chip_id:      nativeEvent.chip_id,
          received_at:  new Date().toISOString(),
          raw_hex:      nativeEvent.raw_hex,
          validation:   validateTime(seconds),
        };
        handler(result);
      }
    });

    this.subscriptions.push(sub);
    NativeBLETimingModule.addListener('onTimingEvent');

    return () => {
      sub.remove();
      NativeBLETimingModule.removeListeners(1);
    };
  }

  onBLEStateChange(handler: StateChangeHandler): () => void {
    const sub = this.emitter.addListener('onBLEStateChange', handler);
    this.subscriptions.push(sub);
    NativeBLETimingModule.addListener('onBLEStateChange');
    return () => { sub.remove(); NativeBLETimingModule.removeListeners(1); };
  }

  onDeviceConnected(handler: ConnectionHandler): () => void {
    const sub = this.emitter.addListener('onDeviceConnected', handler);
    this.subscriptions.push(sub);
    NativeBLETimingModule.addListener('onDeviceConnected');
    return () => { sub.remove(); NativeBLETimingModule.removeListeners(1); };
  }

  onDeviceDisconnected(handler: DisconnectionHandler): () => void {
    const sub = this.emitter.addListener('onDeviceDisconnected', handler);
    this.subscriptions.push(sub);
    NativeBLETimingModule.addListener('onDeviceDisconnected');
    return () => { sub.remove(); NativeBLETimingModule.removeListeners(1); };
  }

  onError(handler: ErrorHandler): () => void {
    const sub = this.emitter.addListener('onScanError', handler);
    this.subscriptions.push(sub);
    NativeBLETimingModule.addListener('onScanError');
    return () => { sub.remove(); NativeBLETimingModule.removeListeners(1); };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Sync service lifecycle
  // ---------------------------------------------------------------------------

  startSyncService(nodeId: string): void {
    NativeBLETimingModule.startSyncService(nodeId);
  }

  stopSyncService(): void {
    NativeBLETimingModule.stopSyncService();
  }

  triggerClockSync(): void {
    NativeBLETimingModule.triggerClockSync();
  }

  resetFallback(): void {
    NativeBLETimingModule.resetFallback();
  }
}

// Singleton — one BLE manager per process (mirrors CBCentralManager constraint)
export const bleTimingService = new BLETimingService();

// Re-export raw module for advanced / testing use
export { NativeBLETimingModule };
export type { NativeTimingEvent as RawNativeTimingEvent };

// WatermelonDB write hook — the final stage of the timing pipeline
export { useBLETiming } from './useBLETiming';
export type {
  UseBLETimingOptions,
  UseBLETimingReturn,
  TimingOutboxRecord,
  OutboxWriteFn,
  HLCTickFn,
  BLEConnectionState,
} from './useBLETiming';

// Phase 2: RF adaptation state + clock sync
export { useRFAdaptation } from './useRFAdaptation';
export type {
  ClockSyncInfo,
  PerDeviceRFState,
  UseRFAdaptationReturn,
} from './useRFAdaptation';
