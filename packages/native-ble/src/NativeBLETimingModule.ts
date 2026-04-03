/**
 * NativeBLETimingModule.ts
 * Core Elite — Phase 1: Silicon-to-Software Optimization
 *
 * TurboModule Codegen spec for the New Architecture.
 * Run `npx react-native codegen` to generate the C++ bridge stubs from this file.
 *
 * This spec is the contract between TypeScript and the native layer.
 * The native implementations (CoreEliteBLEModule.mm / BLETimingModule.kt)
 * must expose exactly the methods and event names declared here.
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

// ---------------------------------------------------------------------------
// TimingEvent
//
// monotonic_ns is delivered as a string to avoid IEEE-754 precision loss:
//   JavaScript's number type is a 64-bit float — it can only represent
//   integers exactly up to 2^53 (9,007,199,254,740,992).
//   SystemClock.uptimeNanos() on Android regularly exceeds 2^53 after ~104 days
//   of uptime. Use BigInt(event.monotonic_ns) in consumer code.
//
// raw_hex is the raw BLE characteristic bytes as a lowercase hex string.
// Decoding (centiseconds → seconds for Freelap, proprietary for Dashr)
// is deferred to the application layer (index.ts parseTimingPacket).
// ---------------------------------------------------------------------------
export type NativeTimingEvent = {
  /** Monotonic hardware clock at the moment the BLE notification was received.
   *  iOS: clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) — nanoseconds.
   *  Android: SystemClock.uptimeNanos() — nanoseconds.
   *  Delivered as string to preserve uint64_t precision. */
  monotonic_ns: string;

  /** Raw BLE characteristic value as lowercase hex (e.g. "a1b20304"). */
  raw_hex: string;

  /** Number of bytes in raw_hex / 2. */
  byte_count: number;

  /** Peripheral name or UUID (e.g. "FREELAP_A1B2", "DASHR_001"). */
  chip_id: string;
};

export type BLEStateChangeEvent = {
  /** 'poweredOn' | 'poweredOff' | 'resetting' | 'unauthorized' |
   *  'unsupported' | 'unknown' */
  state: string;
};

export type DeviceConnectionEvent = {
  /** iOS: CBPeripheral UUID string. Android: BluetoothDevice MAC address. */
  uuid?: string;
  address?: string;
  name: string;
};

export type DeviceDisconnectionEvent = DeviceConnectionEvent & {
  error?: string;
  status?: number; // Android GATT status code
};

export type ScanErrorEvent = {
  message: string;
  errorCode?: number;
  address?: string;
};

// ---------------------------------------------------------------------------
// TurboModule spec
// All methods must be present in both native implementations.
// ---------------------------------------------------------------------------
export interface Spec extends TurboModule {
  /**
   * Begin scanning for BLE peripherals whose advertised name starts with
   * `namePrefix`. Automatically connects on discovery and subscribes to the
   * timing characteristic.
   *
   * Typical values:
   *   "FREELAP" — Freelap FxChip transponders
   *   "DASHR"   — Dashr|Blue timing gates
   */
  startScan(namePrefix: string): void;

  /** Stop an active BLE scan. Safe to call when no scan is running. */
  stopScan(): void;

  /** Disconnect all connected peripherals and stop the scan. */
  disconnectAll(): void;

  /**
   * Manually trigger a buffer flush to JS.
   * Under normal operation, flush is automatic after every gate crossing.
   * Useful for testing and for draining the buffer on app resume.
   */
  flushBuffer(): void;

  // Required by RCTEventEmitter / New Architecture event system.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('CoreEliteBLE');
