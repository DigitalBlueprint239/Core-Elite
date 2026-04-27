/**
 * useLaserTrip.ts
 * Core Elite — Mission U: React Native laser-trip integration
 *
 * Composes the three mobile workspace packages into the primary write path:
 *
 *   mock BLE listener  →  HLC tick  →  local outbox entry  →  (PowerSync flush)
 *
 * This hook is framework-agnostic at the algorithm level — it returns a
 * pure JS lifecycle object. The React wrapper lives in index.ts so a
 * test suite can drive the core without renderer overhead.
 *
 * Runtime contract:
 *   - Every emitted TimingResult produces exactly one outbox entry.
 *   - Each outbox entry carries a monotonically-increasing HLC timestamp.
 *   - Invalid readings (below_physical_floor / above_max_threshold) are
 *     dropped server-side by submit_result_secure, but we still log them
 *     to the outbox so the operator sees what the gate reported.
 */

import { HLCClock } from '@core-elite/powersync';
import type { MockBLEListener, MockTimingResult } from '@core-elite/native-ble/src/stub';

export interface OutboxEntry {
  client_result_id: string;     // = MockTimingResult.id
  chip_id:          string;
  value_num:        number;
  raw_hex:          string;
  monotonic_ns:     string;     // bigint serialized — SQLite has no bigint
  hlc_timestamp:    string;
  recorded_at:      string;
  validation_ok:    boolean;
  validation_note:  string | null;
}

export interface OutboxSink {
  /** Enqueue an entry for eventual PowerSync upload. */
  enqueue(entry: OutboxEntry): void | Promise<void>;
}

/** Default in-memory sink used when no persistent outbox is available yet. */
export class MemoryOutbox implements OutboxSink {
  readonly entries: OutboxEntry[] = [];
  enqueue(entry: OutboxEntry): void {
    this.entries.push(entry);
  }
}

export interface LaserTripPipelineOptions {
  listener: MockBLEListener;
  hlc:      HLCClock;
  sink:     OutboxSink;
  /** Invoked after each successful enqueue — useful for UI flash / haptics. */
  onTrip?:  (entry: OutboxEntry, raw: MockTimingResult) => void;
}

export interface LaserTripPipeline {
  /** Stop listening and release the BLE subscription. */
  dispose(): void;
  /** Count of trips processed since pipeline start (across attempts). */
  readonly tripCount: number;
}

/**
 * startLaserTripPipeline — subscribe to the BLE listener and pipe each trip
 * through the HLC + outbox. Returns a dispose handle.
 */
export function startLaserTripPipeline(
  opts: LaserTripPipelineOptions,
): LaserTripPipeline {
  let count = 0;

  const unsub = opts.listener.onTimingResult((raw) => {
    const hlcTs = opts.hlc.tick();
    const note  = raw.validation.valid
      ? null
      : `${raw.validation.reason}:${raw.validation.flagged_value}`;

    const entry: OutboxEntry = {
      client_result_id: raw.id,
      chip_id:          raw.chip_id,
      value_num:        raw.time_seconds,
      raw_hex:          raw.raw_hex,
      monotonic_ns:     raw.monotonic_ns.toString(),
      hlc_timestamp:    hlcTs,
      recorded_at:      raw.received_at,
      validation_ok:    raw.validation.valid,
      validation_note:  note,
    };

    const maybe = opts.sink.enqueue(entry);
    // Sinks may return a Promise; we don't await here to keep the hot path
    // non-blocking. Write failures surface via the sink's own retry policy.
    if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
      (maybe as Promise<void>).catch(err => {
        if (typeof console !== 'undefined') console.error('[field-ops] outbox enqueue failed', err);
      });
    }

    count += 1;
    opts.onTrip?.(entry, raw);
  });

  return {
    dispose() { unsub(); },
    get tripCount() { return count; },
  };
}
