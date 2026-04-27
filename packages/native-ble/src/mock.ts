/**
 * mock.ts
 * Core Elite — Mission U: Mock BLE laser-trip simulator
 *
 * The production BLE path (index.ts / NativeBLETimingModule.ts) binds to
 * the iOS / Android TurboModule and requires the hardware. This module is
 * the development-time counterpart — a pure-TypeScript event emitter that
 * produces TimingResult-shaped events so the field-ops client can be
 * built, tested, and demoed without a Freelap gate in the room.
 *
 * Design goals:
 *   - Zero react-native runtime imports → works in Node, Metro, and tests.
 *   - Same emitted shape as the real bleTimingService.onTimingResult path
 *     so a swap-in is invisible to consumers.
 *   - Manual trip (simulateLaserTrip) and auto-cadence (startAutoLoop) for
 *     stress-testing outbox + HLC sequencing.
 *
 * Consumers:
 *   const listener = initializeBLEListener();
 *   const unsub = listener.onTimingResult(evt => console.log(evt));
 *   listener.simulateLaserTrip({ chipId: 'FREELAP-MOCK-1', timeSeconds: 4.42 });
 */

import {
  MOCK_DASHR_TRIP_HEX,
  MOCK_DASHR_TRIP_SECONDS,
  MOCK_DASHR_CHIP_ID,
} from './constants';

// ---------------------------------------------------------------------------
// Shared shape — intentionally duplicated from index.ts so this file has no
// dependency on the react-native-bound module. When the mock and production
// paths converge we'll hoist this to a shared types.ts.
// ---------------------------------------------------------------------------

export type MockValidationFailureReason =
  | 'false_start'
  | 'below_physical_floor'
  | 'above_max_threshold'
  | 'extraordinary_result'
  | 'decode_error';

export type MockValidationResult =
  | { valid: true }
  | { valid: false; reason: MockValidationFailureReason; flagged_value: number };

export interface MockTimingResult {
  id:            string;
  monotonic_ns:  bigint;
  time_seconds:  number;
  chip_id:       string;
  received_at:   string;
  raw_hex:       string;
  validation:    MockValidationResult;
}

// ---------------------------------------------------------------------------
// Validation gates — match the real path (index.ts §VALIDATION_GATES).
// Kept in sync manually; a test asserts equality across both files.
// ---------------------------------------------------------------------------

const VALIDATION_GATES = {
  FORTY_YARD_PHYSICAL_FLOOR: 3.70,
  FORTY_YARD_MAX_THRESHOLD:  9.00,
  FORTY_YARD_WORLD_RECORD:   4.21,
} as const;

function validateTime(seconds: number): MockValidationResult {
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

// ---------------------------------------------------------------------------
// ID generator — matches the real path but maintains its own counter so a
// mock-mode session can coexist with the production module without shared
// mutable state between them.
// ---------------------------------------------------------------------------

let _mockIdCounter = 0;

function generateId(): string {
  _mockIdCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `mock_${_mockIdCounter}_${rand}`;
}

// ---------------------------------------------------------------------------
// Monotonic clock — process.hrtime.bigint() in Node, performance.now() in RN
// (converted to ns as a bigint). No Date.now() here; the real hardware sends
// a monotonic nanosecond counter, and we mirror that.
// ---------------------------------------------------------------------------

function monotonicNs(): bigint {
  const g: any = globalThis as any;
  if (g.process?.hrtime?.bigint) {
    return g.process.hrtime.bigint();
  }
  if (g.performance?.now) {
    return BigInt(Math.floor(g.performance.now() * 1_000_000));
  }
  return BigInt(Date.now()) * 1_000_000n;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map(b => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

// Encode a time in seconds back into a Freelap-style 4-byte little-endian
// centiseconds packet. Lets round-tripping decoders verify their work.
function encodeFreelap(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  return bytesToHex([
    cs & 0xff,
    (cs >> 8) & 0xff,
    (cs >> 16) & 0xff,
    (cs >> 24) & 0xff,
  ]);
}

// ---------------------------------------------------------------------------
// Emitter — tiny synchronous implementation. Avoids node:events so this
// file stays portable to bare React Native + Hermes with zero polyfills.
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;
type TimingHandler = (result: MockTimingResult) => void;

class MockEmitter {
  private handlers = new Set<TimingHandler>();

  subscribe(handler: TimingHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  emit(result: MockTimingResult): void {
    // Snapshot before iterating so handlers may unsubscribe themselves.
    const snapshot = Array.from(this.handlers);
    for (const h of snapshot) {
      try { h(result); } catch (err) {
        // A broken handler should not take down the emitter.
        // In dev, surface to console; in prod (minified) this is still safe.
        if (typeof console !== 'undefined') console.error('[native-ble/mock] handler threw', err);
      }
    }
  }

  get listenerCount(): number {
    return this.handlers.size;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SimulateLaserTripOptions {
  chipId?:      string;
  /** Elapsed seconds to encode + emit. Default 4.42 — a plausible 40yd. */
  timeSeconds?: number;
  /** Override received_at for deterministic tests. */
  receivedAt?:  string;
}

export interface PushRawHexOptions {
  /** Override decoded seconds for the synthetic trip. Default 4.42. */
  timeSeconds?: number;
  /** Override chip id stamped on the emitted result. */
  chipId?:      string;
  /** Override received_at timestamp — deterministic tests. */
  receivedAt?:  string;
}

export interface PushRawHexResult {
  /** True when the hex was recognised and a trip was emitted. */
  recognised: boolean;
  /** The event emitted to subscribers (null when hex was unrecognised). */
  emitted:    MockTimingResult | null;
}

export interface MockBLEListener {
  /** Subscribe to simulated timing events. Returns an unsubscribe fn. */
  onTimingResult(handler: TimingHandler): Unsubscribe;

  /**
   * Fire a single simulated laser trip synchronously. Returns the emitted
   * TimingResult so tests can assert on it without round-tripping through
   * a subscription.
   */
  simulateLaserTrip(opts?: SimulateLaserTripOptions): MockTimingResult;

  /**
   * Push a raw hex string directly into the listener stream — mirrors how
   * the production TurboModule delivers bytes from `peripheral.didUpdateValueForCharacteristic`.
   *
   * Mission W contract:
   *   - If `rawHex === MOCK_DASHR_TRIP_HEX`, emit a synthetic TimingResult
   *     (chip_id = MOCK_DASHR_CHIP_ID, time_seconds = 4.42).
   *   - Any other string is forwarded to the existing Freelap decoder as
   *     a best-effort fallback. Unknown packets return `{ recognised: false }`
   *     without emitting so test harnesses can distinguish noise from trips.
   */
  pushRawHex(rawHex: string, opts?: PushRawHexOptions): PushRawHexResult;

  /**
   * Fire a trip every `intervalMs` ms with a small random jitter on the
   * time_seconds value. Useful for UI burn-in. Call the returned stop()
   * to halt the loop.
   */
  startAutoLoop(opts?: {
    intervalMs?:  number;
    baseSeconds?: number;
    jitter?:      number;
    chipId?:      string;
  }): () => void;

  /** Drop all subscribers. Idempotent. */
  removeAllListeners(): void;

  /** Number of active subscribers — exposed for tests. */
  readonly listenerCount: number;
}

/**
 * initializeBLEListener — construct a fresh mock BLE listener.
 *
 * Each call returns an independent instance. The production path exports
 * a singleton (bleTimingService) to mirror CBCentralManager's process-wide
 * constraint; the mock has no such constraint, so we let callers own the
 * lifecycle.
 */
export function initializeBLEListener(): MockBLEListener {
  const emitter = new MockEmitter();
  let autoTimer: ReturnType<typeof setInterval> | null = null;

  function simulateLaserTrip(opts: SimulateLaserTripOptions = {}): MockTimingResult {
    const chipId       = opts.chipId      ?? 'FREELAP-MOCK-1';
    const timeSeconds  = opts.timeSeconds ?? 4.42;
    const receivedAt   = opts.receivedAt  ?? new Date().toISOString();

    const rawHex = encodeFreelap(timeSeconds);
    const result: MockTimingResult = {
      id:           generateId(),
      monotonic_ns: monotonicNs(),
      time_seconds: timeSeconds,
      chip_id:      chipId,
      received_at:  receivedAt,
      raw_hex:      rawHex,
      validation:   validateTime(timeSeconds),
    };

    emitter.emit(result);
    return result;
  }

  function pushRawHex(rawHex: string, opts: PushRawHexOptions = {}): PushRawHexResult {
    // Sentinel: the Mission W arbitrary hex. Exact-match only — no case
    // folding, no whitespace tolerance. If a developer typo'd the string
    // we want them to see `recognised: false`, not a silent trip.
    if (rawHex === MOCK_DASHR_TRIP_HEX) {
      const chipId      = opts.chipId      ?? MOCK_DASHR_CHIP_ID;
      const timeSeconds = opts.timeSeconds ?? MOCK_DASHR_TRIP_SECONDS;
      const receivedAt  = opts.receivedAt  ?? new Date().toISOString();

      const result: MockTimingResult = {
        id:           generateId(),
        monotonic_ns: monotonicNs(),
        time_seconds: timeSeconds,
        chip_id:      chipId,
        received_at:  receivedAt,
        // Preserve the sentinel on the emitted result so the outbox entry's
        // raw_hex field carries the exact string that triggered the trip —
        // useful when reading failed_rpc_logs or debug dumps.
        raw_hex:      MOCK_DASHR_TRIP_HEX,
        validation:   validateTime(timeSeconds),
      };
      emitter.emit(result);
      return { recognised: true, emitted: result };
    }

    // Fallback: attempt to parse as a real Freelap-format hex packet so the
    // same entry-point can be used by the production bridge once hardware
    // arrives. Unknown/garbage input returns { recognised: false } without
    // emitting — callers can distinguish noise from trips.
    const bytesLooksHex = /^[0-9a-fA-F]+$/.test(rawHex) && rawHex.length >= 8;
    if (!bytesLooksHex) return { recognised: false, emitted: null };

    // Inline Freelap decode — duplicates the production path so we don't
    // expose decodePacket through the mock's public surface.
    const b0 = parseInt(rawHex.slice(0, 2), 16);
    const b1 = parseInt(rawHex.slice(2, 4), 16);
    const b2 = parseInt(rawHex.slice(4, 6), 16);
    const b3 = parseInt(rawHex.slice(6, 8), 16);
    const centiseconds = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    const timeSeconds = centiseconds / 100;

    const result: MockTimingResult = {
      id:           generateId(),
      monotonic_ns: monotonicNs(),
      time_seconds: timeSeconds,
      chip_id:      opts.chipId     ?? 'FREELAP-RAW-1',
      received_at:  opts.receivedAt ?? new Date().toISOString(),
      raw_hex:      rawHex,
      validation:   validateTime(timeSeconds),
    };
    emitter.emit(result);
    return { recognised: true, emitted: result };
  }

  return {
    onTimingResult(handler) {
      return emitter.subscribe(handler);
    },

    simulateLaserTrip,

    pushRawHex,

    startAutoLoop(autoOpts = {}) {
      const intervalMs  = autoOpts.intervalMs  ?? 2_000;
      const baseSeconds = autoOpts.baseSeconds ?? 4.65;
      const jitter      = autoOpts.jitter      ?? 0.35;
      const chipId      = autoOpts.chipId      ?? 'FREELAP-MOCK-AUTO';

      if (autoTimer) clearInterval(autoTimer);
      autoTimer = setInterval(() => {
        const delta = (Math.random() * 2 - 1) * jitter;
        simulateLaserTrip({ chipId, timeSeconds: +(baseSeconds + delta).toFixed(3) });
      }, intervalMs);

      return () => {
        if (autoTimer) {
          clearInterval(autoTimer);
          autoTimer = null;
        }
      };
    },

    removeAllListeners() {
      // Reconstruct the handler set — matches production removeAllListeners.
      (emitter as any).handlers = new Set<TimingHandler>();
    },

    get listenerCount() {
      return emitter.listenerCount;
    },
  };
}
