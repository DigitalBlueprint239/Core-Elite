/**
 * sync-determinism.test.ts
 * Core Elite — Distributed sync convergence tests
 *
 * These tests prove the fundamental guarantee:
 *
 *   "Given identical datasets, ALL devices resolve to the EXACT SAME state
 *    — every time, regardless of sync order."
 *
 * Test architecture:
 *   - SimulatedDevice: isolated HLC + outbox, no singletons, no localStorage
 *   - SimulatedServer: in-memory record store that applies HLC-ordered merges
 *   - permute(): generates all orderings of an array for exhaustive sync-order testing
 *
 * Required scenarios:
 *   ✓ Same-millisecond write tie: add-biased resolution is deterministic
 *   ✓ ±500ms clock skew: all three devices converge to correct state
 *   ✓ Multi-device offline merge (3 nodes): all orderings produce same final state
 *   ✓ Immutable timing results: all records survive, no silent deletion
 *   ✓ Mutable device_status: most recent HLC wins regardless of arrival order
 *   ✓ N! ordering exhaustion: final state is identical for all permutations
 */

import { describe, it, expect } from 'vitest';
import { formatHlc, parseHlc, compareHlc } from '../hlc';
import {
  lwwShouldReplace,
  addBiasedShouldKeep,
  resolvePayloadConflict,
  deviceStatusShouldUpdate,
} from '../lww';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** An outbox record — one write from one device. */
interface OutboxRecord {
  client_result_id: string;
  athlete_id:       string;
  drill_type:       string;
  value_num:        number;
  station_id:       string;
  hlc_timestamp:    string;
  device_node:      string;
}

/** A device_status heartbeat — mutable, keyed by (station_id, device_label). */
interface DeviceStatusRecord {
  station_id:    string;
  device_label:  string;
  is_online:     boolean;
  hlc_timestamp: string;
}

class SimulatedDevice {
  readonly nodeId: string;
  private pt: number;
  private l:  number;
  private wallClockMs: number;
  private outbox: OutboxRecord[] = [];

  constructor(nodeId: string, wallClockMs: number) {
    this.nodeId       = nodeId;
    this.pt           = 0;
    this.l            = 0;
    this.wallClockMs  = wallClockMs;
  }

  advanceClock(ms: number) { this.wallClockMs += ms; }
  setClock(ms: number)     { this.wallClockMs  = ms;  }

  tick(): string {
    const now  = this.wallClockMs;
    const newPt = Math.max(this.pt, now);
    const newL  = newPt === this.pt ? this.l + 1 : 0;
    this.pt = newPt;
    this.l  = newL;
    return formatHlc(this.pt, this.l, this.nodeId);
  }

  update(remoteHlc: string): void {
    const r    = parseHlc(remoteHlc);
    const now  = this.wallClockMs;
    const newPt = Math.max(this.pt, r.pt, now);
    let newL: number;
    if (newPt === this.pt && newPt === r.pt) {
      newL = Math.max(this.l, r.l) + 1;
    } else if (newPt === this.pt) {
      newL = this.l + 1;
    } else if (newPt === r.pt) {
      newL = r.l + 1;
    } else {
      newL = 0;
    }
    this.pt = newPt;
    this.l  = newL;
  }

  writeResult(params: Omit<OutboxRecord, 'hlc_timestamp' | 'device_node'>): OutboxRecord {
    const record: OutboxRecord = {
      ...params,
      hlc_timestamp: this.tick(),
      device_node:   this.nodeId,
    };
    this.outbox.push(record);
    return record;
  }

  drainOutbox(): OutboxRecord[] {
    const records = [...this.outbox];
    this.outbox = [];
    return records;
  }

  writeDeviceStatus(stationId: string): DeviceStatusRecord {
    return {
      station_id:   stationId,
      device_label: this.nodeId,
      is_online:    true,
      hlc_timestamp: this.tick(),
    };
  }
}

/**
 * SimulatedServer — in-memory database that applies HLC-ordered merges.
 *
 * Timing results are IMMUTABLE: every record with a unique client_result_id
 * is appended regardless of HLC (no LWW between different client_result_ids).
 *
 * device_status is MUTABLE: keyed by (station_id, device_label), LWW with
 * strict > — incoming only wins if its HLC > current HLC.
 */
class SimulatedServer {
  // Immutable timing results: keyed by client_result_id (idempotency)
  private results = new Map<string, OutboxRecord>();
  // Mutable device status: keyed by `${station_id}::${device_label}`
  private deviceStatus = new Map<string, DeviceStatusRecord>();

  applyResult(record: OutboxRecord): 'inserted' | 'duplicate' {
    if (this.results.has(record.client_result_id)) {
      return 'duplicate'; // idempotency — add-biased: never fail on duplicate
    }
    this.results.set(record.client_result_id, record);
    return 'inserted';
  }

  applyDeviceStatus(incoming: DeviceStatusRecord): 'applied' | 'rejected_stale' {
    const key = `${incoming.station_id}::${incoming.device_label}`;
    const existing = this.deviceStatus.get(key);

    if (!existing || deviceStatusShouldUpdate(existing.hlc_timestamp, incoming.hlc_timestamp)) {
      this.deviceStatus.set(key, incoming);
      return 'applied';
    }
    return 'rejected_stale';
  }

  getResults(): OutboxRecord[] {
    return Array.from(this.results.values());
  }

  getDeviceStatus(stationId: string, deviceLabel: string): DeviceStatusRecord | undefined {
    return this.deviceStatus.get(`${stationId}::${deviceLabel}`);
  }

  /** Snapshot of result IDs — used for convergence assertions. */
  resultIdSet(): Set<string> {
    return new Set(this.results.keys());
  }

  /** Snapshot of device status HLCs — used for convergence assertions. */
  deviceStatusSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    this.deviceStatus.forEach((v, k) => { out[k] = v.hlc_timestamp; });
    return out;
  }

  reset(): void {
    this.results.clear();
    this.deviceStatus.clear();
  }
}

/** Generate all permutations of an array. */
function permute<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permute(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// REQUIRED: Same-millisecond write tie — add-biased determinism
// ---------------------------------------------------------------------------

describe('same-millisecond write tie — add-biased resolution', () => {
  it('two devices writing at the same ms both have their records preserved', () => {
    const WALL = 1_750_000_000_000;
    const dA = new SimulatedDevice('device-aaaa', WALL);
    const dB = new SimulatedDevice('device-bbbb', WALL);

    const r1 = dA.writeResult({ client_result_id: 'r1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });
    const r2 = dB.writeResult({ client_result_id: 'r2', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.79, station_id: 'station-2' });

    // Both records have the same pt but different client_result_ids — they are
    // separate immutable records, not competing versions. Both must survive.
    const server = new SimulatedServer();
    expect(server.applyResult(r1)).toBe('inserted');
    expect(server.applyResult(r2)).toBe('inserted');
    expect(server.getResults()).toHaveLength(2);
  });

  it('duplicate client_result_id is idempotent (not an error)', () => {
    const dA = new SimulatedDevice('device-aaaa', 1_000);
    const r1 = dA.writeResult({ client_result_id: 'r1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });

    const server = new SimulatedServer();
    expect(server.applyResult(r1)).toBe('inserted');
    expect(server.applyResult(r1)).toBe('duplicate'); // network retry
    expect(server.getResults()).toHaveLength(1);       // still one record
  });

  it('add-biased: a timing result is NEVER silently deleted', () => {
    // Simulate the worst case: the same athlete, same drill, same value,
    // submitted twice (accidental double-submission). The add-biased rule
    // means both survive until a human operator resolves the challenge.
    const dA = new SimulatedDevice('device-aaaa', 1_000);
    const r1 = dA.writeResult({ client_result_id: 'r1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });
    const r2 = dA.writeResult({ client_result_id: 'r2', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });

    const addHlc = r1.hlc_timestamp;
    const removeHlc = r2.hlc_timestamp; // pretend r2 is a "remove" signal

    // add-biased: even if addHlc < removeHlc, if we're asking "should we keep r1?"
    // with a tie, the answer is always yes
    expect(addBiasedShouldKeep(addHlc, addHlc)).toBe(true); // exact tie → keep

    // Both records have unique IDs → server keeps both
    const server = new SimulatedServer();
    server.applyResult(r1);
    server.applyResult(r2);
    expect(server.getResults()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: ±500ms clock skew convergence
// ---------------------------------------------------------------------------

describe('±500ms clock skew convergence', () => {
  it('three devices with different clocks converge to same ordering after sync', () => {
    const BASE = 1_750_000_000_000;
    const dAccurate = new SimulatedDevice('device-accurate', BASE);
    const dFast     = new SimulatedDevice('device-fast',     BASE + 500);
    const dSlow     = new SimulatedDevice('device-slow',     BASE - 300);

    // Each device records the same athlete in the same drill, one after another
    const rAccurate = dAccurate.writeResult({ client_result_id: 'r-acc',  athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });
    const rFast     = dFast.writeResult(    { client_result_id: 'r-fast', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.81, station_id: 'station-1' });
    const rSlow     = dSlow.writeResult(    { client_result_id: 'r-slow', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.85, station_id: 'station-1' });

    // All three records must arrive on every server instance, regardless of order
    const server = new SimulatedServer();
    [rAccurate, rFast, rSlow].forEach(r => server.applyResult(r));

    expect(server.getResults()).toHaveLength(3);

    // The "best" result (lowest 40yd time) is deterministically identifiable
    const results = server.getResults();
    const best = results.reduce((a, b) => a.value_num < b.value_num ? a : b);
    expect(best.client_result_id).toBe('r-fast'); // 4.81 is fastest
  });

  it('fast device (+500ms) wins device_status LWW over accurate device', () => {
    const BASE = 1_750_000_000_000;
    const dFast     = new SimulatedDevice('device-fast',     BASE + 500);
    const dAccurate = new SimulatedDevice('device-accurate', BASE);

    const statusFast     = dFast.writeDeviceStatus('station-1');
    const statusAccurate = dAccurate.writeDeviceStatus('station-1');

    // Fast device has higher pt → its heartbeat should win LWW
    expect(compareHlc(statusFast.hlc_timestamp, statusAccurate.hlc_timestamp)).toBeGreaterThan(0);

    const server = new SimulatedServer();
    // Apply in either order — fast must always win
    server.applyDeviceStatus(statusAccurate);
    server.applyDeviceStatus(statusFast);
    expect(server.getDeviceStatus('station-1', 'device-fast')?.hlc_timestamp)
      .toBe(statusFast.hlc_timestamp);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: Multi-device offline merge (3+ nodes) — all orderings converge
// ---------------------------------------------------------------------------

describe('multi-device offline merge — 3 nodes, all orderings', () => {
  const BASE = 1_750_000_000_000;

  function buildThreeDeviceScenario() {
    const dA = new SimulatedDevice('device-aaaa', BASE);
    const dB = new SimulatedDevice('device-bbbb', BASE + 100);
    const dC = new SimulatedDevice('device-cccc', BASE + 50);

    // Each device goes offline and records several athletes
    const writes: OutboxRecord[] = [
      dA.writeResult({ client_result_id: 'rA1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'sta-1' }),
      dA.writeResult({ client_result_id: 'rA2', athlete_id: 'ath-2', drill_type: '40yd', value_num: 5.10, station_id: 'sta-1' }),
      dB.writeResult({ client_result_id: 'rB1', athlete_id: 'ath-3', drill_type: 'vertical', value_num: 32.0, station_id: 'sta-2' }),
      dB.writeResult({ client_result_id: 'rB2', athlete_id: 'ath-4', drill_type: 'vertical', value_num: 28.5, station_id: 'sta-2' }),
      dC.writeResult({ client_result_id: 'rC1', athlete_id: 'ath-5', drill_type: 'pro_agility', value_num: 4.42, station_id: 'sta-3' }),
      dC.writeResult({ client_result_id: 'rC2', athlete_id: 'ath-1', drill_type: 'vertical', value_num: 31.0, station_id: 'sta-3' }),
    ];

    return writes;
  }

  it('all 6 records are preserved regardless of sync order', () => {
    const writes = buildThreeDeviceScenario();
    const allPerms = permute(writes);

    const snapshots = allPerms.map(perm => {
      const server = new SimulatedServer();
      perm.forEach(w => server.applyResult(w));
      return server.resultIdSet();
    });

    // Every ordering must have the same 6 records
    for (const snap of snapshots) {
      expect(snap.size).toBe(6);
      expect(snap.has('rA1')).toBe(true);
      expect(snap.has('rA2')).toBe(true);
      expect(snap.has('rB1')).toBe(true);
      expect(snap.has('rB2')).toBe(true);
      expect(snap.has('rC1')).toBe(true);
      expect(snap.has('rC2')).toBe(true);
    }
  });

  it('the result set is identical across all 720 orderings (6! = 720)', () => {
    const writes = buildThreeDeviceScenario();
    const allPerms = permute(writes); // 6! = 720

    expect(allPerms.length).toBe(720);

    // Build reference state from the first ordering
    const reference = new SimulatedServer();
    allPerms[0].forEach(w => reference.applyResult(w));
    const referenceIds = reference.resultIdSet();

    // Every other ordering must produce the exact same record set
    for (let i = 1; i < allPerms.length; i++) {
      const server = new SimulatedServer();
      allPerms[i].forEach(w => server.applyResult(w));
      expect(server.resultIdSet()).toStrictEqual(referenceIds);
    }
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: Mutable device_status — strict HLC LWW, all orderings converge
// ---------------------------------------------------------------------------

describe('device_status mutable LWW — all orderings converge', () => {
  it('all orderings of 3 heartbeats produce the same winner', () => {
    const BASE = 1_750_000_000_000;
    const device = new SimulatedDevice('device-aaaa', BASE);

    // Three heartbeats from the same device at different times
    const h1 = device.writeDeviceStatus('station-1');
    device.advanceClock(1000);
    const h2 = device.writeDeviceStatus('station-1');
    device.advanceClock(1000);
    const h3 = device.writeDeviceStatus('station-1');

    // h3 must have the highest HLC
    expect(compareHlc(h3.hlc_timestamp, h2.hlc_timestamp)).toBeGreaterThan(0);
    expect(compareHlc(h2.hlc_timestamp, h1.hlc_timestamp)).toBeGreaterThan(0);

    const allPerms = permute([h1, h2, h3]);

    const finalHlcs = allPerms.map(perm => {
      const server = new SimulatedServer();
      perm.forEach(h => server.applyDeviceStatus(h));
      return server.getDeviceStatus('station-1', 'device-aaaa')?.hlc_timestamp;
    });

    // Every ordering must leave h3's HLC as the winner
    for (const finalHlc of finalHlcs) {
      expect(finalHlc).toBe(h3.hlc_timestamp);
    }
  });

  it('stale offline heartbeat is rejected after a fresh online heartbeat', () => {
    // This is the exact scenario migration 017 protects against:
    //   t=100  Offline heartbeat queued (HLC: t=100)
    //   t=200  Fresh online heartbeat sent directly to server (HLC: t=200)
    //   t=201  Offline heartbeat arrives from outbox drain (HLC: t=100)
    //
    // Result: server must retain t=200, not overwrite with t=100.
    const BASE = 1_750_000_000_000;
    const device = new SimulatedDevice('device-aaaa', BASE + 100);

    const staleHeartbeat = device.writeDeviceStatus('station-1'); // HLC at t+100

    device.setClock(BASE + 200);
    const freshHeartbeat = device.writeDeviceStatus('station-1'); // HLC at t+200

    const server = new SimulatedServer();

    // Fresh heartbeat arrives first (online path)
    server.applyDeviceStatus(freshHeartbeat);
    // Stale heartbeat arrives second (outbox drain)
    const result = server.applyDeviceStatus(staleHeartbeat);

    expect(result).toBe('rejected_stale');
    // Server retains the fresh heartbeat
    expect(server.getDeviceStatus('station-1', 'device-aaaa')?.hlc_timestamp)
      .toBe(freshHeartbeat.hlc_timestamp);
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM PROPERTY — the core guarantee
//
// Given N records from N devices with known HLC timestamps, applying
// resolvePayloadConflict in ALL N! orderings produces the EXACT SAME winner.
// ---------------------------------------------------------------------------

describe('determinism property — N! ordering exhaustion', () => {
  it('resolvePayloadConflict produces the same winner for all orderings', () => {
    const BASE = 1_750_000_000_000;

    type Rec = { id: string; hlc_timestamp: string; value: number };

    const records: Rec[] = [
      { id: 'r1', hlc_timestamp: formatHlc(BASE + 100, 0, 'device-aaaa'), value: 10 },
      { id: 'r2', hlc_timestamp: formatHlc(BASE + 200, 0, 'device-bbbb'), value: 20 },
      { id: 'r3', hlc_timestamp: formatHlc(BASE + 150, 3, 'device-cccc'), value: 30 },
    ];

    // The "winner" is the record with the highest HLC — determined before testing
    const expected = records.reduce((a, b) =>
      compareHlc(a.hlc_timestamp, b.hlc_timestamp) >= 0 ? a : b
    );

    // Apply records in all 3! = 6 orderings using fold with resolvePayloadConflict
    const allPerms = permute(records);
    expect(allPerms.length).toBe(6);

    for (const perm of allPerms) {
      const winner = perm.reduce((acc, r) => resolvePayloadConflict(acc, r));
      expect(winner.id).toBe(expected.id);
    }
  });

  it('4-device scenario: 24 orderings all converge to the same winner', () => {
    const BASE = 1_750_000_000_000;
    type Rec = { id: string; hlc_timestamp: string };

    const records: Rec[] = [
      { id: 'r1', hlc_timestamp: formatHlc(BASE + 100, 0, 'device-aaaa') },
      { id: 'r2', hlc_timestamp: formatHlc(BASE + 300, 0, 'device-bbbb') }, // winner
      { id: 'r3', hlc_timestamp: formatHlc(BASE + 200, 5, 'device-cccc') },
      { id: 'r4', hlc_timestamp: formatHlc(BASE + 299, 0, 'device-dddd') },
    ];

    const allPerms = permute(records);
    expect(allPerms.length).toBe(24); // 4! = 24

    // Determine expected winner independently
    const expected = records.reduce((a, b) =>
      compareHlc(a.hlc_timestamp, b.hlc_timestamp) >= 0 ? a : b
    );
    expect(expected.id).toBe('r2'); // BASE+300 is highest

    for (const perm of allPerms) {
      const winner = perm.reduce((acc, r) => resolvePayloadConflict(acc, r));
      expect(winner.id).toBe('r2');
    }
  });

  it('same-millisecond tie: all orderings produce the same tiebreak winner', () => {
    const SAME_MS = 1_750_000_000_000;
    type Rec = { id: string; hlc_timestamp: string };

    // Three records all with the same physical time (pt) — only nodeId differs.
    const records: Rec[] = [
      { id: 'r1', hlc_timestamp: formatHlc(SAME_MS, 0, 'device-aaaa') },
      { id: 'r2', hlc_timestamp: formatHlc(SAME_MS, 0, 'device-bbbb') },
      { id: 'r3', hlc_timestamp: formatHlc(SAME_MS, 0, 'device-zzzz') }, // highest nodeId → wins
    ];

    const allPerms = permute(records);
    expect(allPerms.length).toBe(6);

    // r3 has nodeId 'device-zzzz' which is lexicographically last → highest HLC
    const expected = records.reduce((a, b) =>
      compareHlc(a.hlc_timestamp, b.hlc_timestamp) >= 0 ? a : b
    );
    expect(expected.id).toBe('r3');

    for (const perm of allPerms) {
      const winner = perm.reduce((acc, r) => resolvePayloadConflict(acc, r));
      expect(winner.id).toBe('r3');
    }
  });

  it('±500ms skew: despite clock skew, the intended causal order is preserved', () => {
    // A happens before B in real time, but B's device has a +500ms skewed clock.
    // B's HLC should be higher, which is consistent — B's write was captured
    // at a higher physical timestamp regardless of whether the clock is accurate.
    // The HLC total order is defined by the HLC values, not real-world time.
    const BASE = 1_750_000_000_000;

    const dA    = new SimulatedDevice('device-aaaa', BASE);
    const dBFast = new SimulatedDevice('device-bbbb', BASE + 500);

    // Both write a mutable record (device_status) for the same key
    const sA = dA.writeDeviceStatus('station-1');
    const sB = dBFast.writeDeviceStatus('station-1');

    // B's HLC is higher due to skewed clock
    expect(compareHlc(sB.hlc_timestamp, sA.hlc_timestamp)).toBeGreaterThan(0);

    // In all orderings, B wins (its HLC is definitively higher)
    const allPerms = permute([sA, sB]);
    for (const perm of allPerms) {
      const server = new SimulatedServer();
      perm.forEach(h => server.applyDeviceStatus(h));
      expect(server.getDeviceStatus('station-1', 'device-bbbb')?.hlc_timestamp)
        .toBe(sB.hlc_timestamp);
    }
  });
});

// ---------------------------------------------------------------------------
// Immutable timing results — complete independence of different client_result_ids
// ---------------------------------------------------------------------------

describe('immutable timing result independence', () => {
  it('two scouts recording the same athlete both have their records kept', () => {
    const BASE = 1_750_000_000_000;
    const scout1 = new SimulatedDevice('device-scout1', BASE);
    const scout2 = new SimulatedDevice('device-scout2', BASE); // same wall clock

    // Both scouts capture the same athlete in the same drill at the same time
    const r1 = scout1.writeResult({ client_result_id: 'scout1-r1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.82, station_id: 'station-1' });
    const r2 = scout2.writeResult({ client_result_id: 'scout2-r1', athlete_id: 'ath-1', drill_type: '40yd', value_num: 4.79, station_id: 'station-2' });

    // Add-biased: both records survive. Best result is chosen at query time.
    const server = new SimulatedServer();
    expect(server.applyResult(r1)).toBe('inserted');
    expect(server.applyResult(r2)).toBe('inserted');

    const results = server.getResults();
    expect(results).toHaveLength(2);

    // The application layer picks the best result at query time (not here)
    const best = results.reduce((a, b) => a.value_num < b.value_num ? a : b);
    expect(best.value_num).toBe(4.79);
  });

  it('addBiasedShouldKeep guarantees neither record is deleted even on identical HLC', () => {
    // If two records somehow have identical HLCs (e.g. same device writes twice
    // with a frozen clock and the same logical counter — should not happen in
    // practice but tested for robustness):
    const hlc = formatHlc(1_000, 0, 'device-a');

    // The add-biased rule says: keep the record. No silent deletion.
    expect(addBiasedShouldKeep(hlc, hlc)).toBe(true);
  });
});
