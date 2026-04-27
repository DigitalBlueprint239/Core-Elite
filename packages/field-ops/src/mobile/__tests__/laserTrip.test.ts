/**
 * laserTrip.test.ts
 * Mission U acceptance — field-ops listens to a simulated laser trip and
 * produces an HLC-stamped outbox entry.
 */

import { describe, it, expect } from 'vitest';
import { HLCClock, MemoryStorageAdapter } from '@core-elite/powersync';
import {
  initializeBLEListener,
  MOCK_DASHR_TRIP_HEX,
  MOCK_DASHR_CHIP_ID,
  MOCK_DASHR_TRIP_SECONDS,
} from '@core-elite/native-ble/src/stub';
import { startLaserTripPipeline, MemoryOutbox } from '../useLaserTrip';
import { simulateDashrTrip } from '../debugTrip';

describe('Mission U — laser trip pipeline', () => {
  it('turns a simulated laser trip into an HLC-stamped outbox entry', () => {
    const listener = initializeBLEListener();
    const hlc      = new HLCClock({ nodeId: 'device-test', storage: new MemoryStorageAdapter() });
    const sink     = new MemoryOutbox();

    const pipeline = startLaserTripPipeline({ listener, hlc, sink });

    const emitted = listener.simulateLaserTrip({
      chipId:      'FREELAP-MOCK-1',
      timeSeconds: 4.42,
    });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0].client_result_id).toBe(emitted.id);
    expect(sink.entries[0].value_num).toBe(4.42);
    expect(sink.entries[0].chip_id).toBe('FREELAP-MOCK-1');
    expect(sink.entries[0].validation_ok).toBe(true);
    expect(sink.entries[0].hlc_timestamp).toMatch(/^\d{16}_\d{10}_device-test$/);
    expect(pipeline.tripCount).toBe(1);

    pipeline.dispose();
  });

  it('assigns strictly-increasing HLC timestamps to rapid successive trips', () => {
    const listener = initializeBLEListener();
    const hlc      = new HLCClock({ nodeId: 'device-test', storage: new MemoryStorageAdapter() });
    const sink     = new MemoryOutbox();
    const pipeline = startLaserTripPipeline({ listener, hlc, sink });

    for (let i = 0; i < 5; i++) {
      listener.simulateLaserTrip({ chipId: 'FREELAP-MOCK-1', timeSeconds: 4.5 + i * 0.01 });
    }

    expect(sink.entries).toHaveLength(5);
    for (let i = 1; i < sink.entries.length; i++) {
      expect(sink.entries[i].hlc_timestamp > sink.entries[i - 1].hlc_timestamp).toBe(true);
    }
    pipeline.dispose();
  });

  it('still records invalid readings, tagged with the failure reason', () => {
    const listener = initializeBLEListener();
    const hlc      = new HLCClock({ nodeId: 'device-test', storage: new MemoryStorageAdapter() });
    const sink     = new MemoryOutbox();
    const pipeline = startLaserTripPipeline({ listener, hlc, sink });

    listener.simulateLaserTrip({ chipId: 'FREELAP-MOCK-1', timeSeconds: 9.5 });

    expect(sink.entries[0].validation_ok).toBe(false);
    expect(sink.entries[0].validation_note).toMatch(/above_max_threshold/);
    pipeline.dispose();
  });
});

describe('Mission W — MOCK_DASHR_TRIP_HEX sentinel', () => {
  it('exposes the literal Mission W sentinel value', () => {
    // Guard against accidental string drift — the RN button depends on
    // this exact value, and so does every test harness + doc reference.
    expect(MOCK_DASHR_TRIP_HEX).toBe('0xD5HR_TRIP');
  });

  it('pushRawHex(sentinel) emits a synthetic Dashr trip', () => {
    const listener = initializeBLEListener();
    const r = listener.pushRawHex(MOCK_DASHR_TRIP_HEX);

    expect(r.recognised).toBe(true);
    expect(r.emitted).not.toBeNull();
    expect(r.emitted!.chip_id).toBe(MOCK_DASHR_CHIP_ID);
    expect(r.emitted!.time_seconds).toBe(MOCK_DASHR_TRIP_SECONDS);
    // The raw_hex field on the emitted event MUST carry the literal
    // sentinel — the outbox row uses it for forensics / audit trail.
    expect(r.emitted!.raw_hex).toBe(MOCK_DASHR_TRIP_HEX);
  });

  it('pushRawHex rejects garbage input without emitting', () => {
    const listener = initializeBLEListener();
    let callCount = 0;
    listener.onTimingResult(() => { callCount += 1; });

    const r = listener.pushRawHex('this-is-not-hex-and-not-the-sentinel');

    expect(r.recognised).toBe(false);
    expect(r.emitted).toBeNull();
    expect(callCount).toBe(0);
  });

  it('simulateDashrTrip wires the sentinel end-to-end: HLC ticks + outbox enqueues', () => {
    const listener = initializeBLEListener();
    const hlc      = new HLCClock({ nodeId: 'device-test', storage: new MemoryStorageAdapter() });
    const sink     = new MemoryOutbox();
    const pipeline = startLaserTripPipeline({ listener, hlc, sink });

    // This is exactly what the RN button's onPress calls.
    const r = simulateDashrTrip(listener);

    expect(r.recognised).toBe(true);
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0].chip_id).toBe(MOCK_DASHR_CHIP_ID);
    expect(sink.entries[0].raw_hex).toBe(MOCK_DASHR_TRIP_HEX);
    expect(sink.entries[0].value_num).toBe(MOCK_DASHR_TRIP_SECONDS);
    expect(sink.entries[0].hlc_timestamp).toMatch(/^\d{16}_\d{10}_device-test$/);
    expect(sink.entries[0].validation_ok).toBe(true);
    expect(pipeline.tripCount).toBe(1);

    pipeline.dispose();
  });

  it('repeated button taps produce strictly-ordered HLC timestamps', () => {
    const listener = initializeBLEListener();
    const hlc      = new HLCClock({ nodeId: 'device-test', storage: new MemoryStorageAdapter() });
    const sink     = new MemoryOutbox();
    const pipeline = startLaserTripPipeline({ listener, hlc, sink });

    for (let i = 0; i < 4; i++) simulateDashrTrip(listener);

    expect(sink.entries).toHaveLength(4);
    for (let i = 1; i < sink.entries.length; i++) {
      expect(sink.entries[i].hlc_timestamp > sink.entries[i - 1].hlc_timestamp).toBe(true);
    }
    pipeline.dispose();
  });
});
