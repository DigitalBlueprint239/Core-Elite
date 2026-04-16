/**
 * hlc.test.ts
 * Unit tests for the Hybrid Logical Clock implementation (v2 §3.1.3, v3 §3.1.2).
 *
 * Test strategy:
 *   Rather than driving the singleton (which shares _state across tests and
 *   depends on localStorage), every test instantiates one or more
 *   SimulatedDevice objects. Each device owns its own independent HLC state
 *   and uses the pure functions from hlc.ts (formatHlc, parseHlc, compareHlc).
 *   This gives full isolation with zero mocking of module internals.
 *
 * Coverage targets:
 *   ✓ Format stability: lexicographic sort == temporal order
 *   ✓ Monotonicity: tick() is strictly non-decreasing
 *   ✓ Same-millisecond writes: logical counter provides total order
 *   ✓ Clock skew ±500ms: HLC still produces consistent ordering
 *   ✓ update() receive-event rule: local clock advances past remote
 *   ✓ compareHlc: transitivity, symmetry, reflexivity
 *   ✓ parseHlc: round-trip and error cases
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatHlc, parseHlc, compareHlc, maxHlc } from '../hlc';

// ---------------------------------------------------------------------------
// SimulatedDevice — isolated HLC instance for testing
//
// Reimplements tick() and update() using the algorithm from hlc.ts but with
// its own state, making each device's clock fully independent.
// ---------------------------------------------------------------------------

class SimulatedDevice {
  private pt: number;
  private l: number;
  readonly nodeId: string;
  private wallClockMs: number;  // controlled wall clock for this device

  constructor(nodeId: string, initialWallClockMs = 0) {
    this.pt         = 0;
    this.l          = 0;
    this.nodeId     = nodeId;
    this.wallClockMs = initialWallClockMs;
  }

  /** Advance the simulated wall clock. */
  advanceWallClock(ms: number): void {
    this.wallClockMs += ms;
  }

  /** Set the wall clock to an absolute value. */
  setWallClock(ms: number): void {
    this.wallClockMs = ms;
  }

  /**
   * tick() — Kulkarni & Demirbas 2014 send-event rule.
   * Returns a new HLC string and advances this device's state.
   */
  tick(): string {
    const now = this.wallClockMs;
    const newPt = Math.max(this.pt, now);
    const newL  = newPt === this.pt ? this.l + 1 : 0;
    this.pt = newPt;
    this.l  = newL;
    return formatHlc(this.pt, this.l, this.nodeId);
  }

  /**
   * update() — Kulkarni & Demirbas 2014 receive-event rule.
   * Advances local clock after observing a remote HLC string.
   */
  update(remoteHlcStr: string): void {
    const remote = parseHlc(remoteHlcStr);
    const now    = this.wallClockMs;
    const newPt  = Math.max(this.pt, remote.pt, now);

    let newL: number;
    if (newPt === this.pt && newPt === remote.pt) {
      newL = Math.max(this.l, remote.l) + 1;
    } else if (newPt === this.pt) {
      newL = this.l + 1;
    } else if (newPt === remote.pt) {
      newL = remote.l + 1;
    } else {
      newL = 0;
    }

    this.pt = newPt;
    this.l  = newL;
  }

  /** Current HLC string without advancing state. */
  current(): string {
    return formatHlc(this.pt, this.l, this.nodeId);
  }
}

// ---------------------------------------------------------------------------
// Pure function tests — no device state required
// ---------------------------------------------------------------------------

describe('formatHlc', () => {
  it('pads pt to 16 digits', () => {
    const s = formatHlc(1234, 0, 'device-aabbccdd');
    expect(s.split('_')[0]).toBe('0000000000001234');
  });

  it('pads l to 10 digits', () => {
    const s = formatHlc(0, 42, 'device-aabbccdd');
    expect(s.split('_')[1]).toBe('0000000042');
  });

  it('preserves nodeId containing hyphens', () => {
    const s = formatHlc(100, 0, 'device-a1b2c3d4');
    const parts = s.split('_');
    // parts[0]=pt, parts[1]=l, parts[2..]=nodeId segments
    expect(parts.slice(2).join('_')).toBe('device-a1b2c3d4');
  });

  it('produces a lexicographically sortable string', () => {
    const earlier = formatHlc(1000, 0, 'dev-x');
    const later   = formatHlc(2000, 0, 'dev-x');
    // Standard string comparison must agree with temporal order
    expect(earlier < later).toBe(true);
  });

  it('logical counter dominates when pt is equal', () => {
    const first  = formatHlc(5000, 0, 'dev-x');
    const second = formatHlc(5000, 1, 'dev-x');
    const third  = formatHlc(5000, 9999, 'dev-x');
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });
});

describe('parseHlc', () => {
  it('round-trips formatHlc output correctly', () => {
    const original = { pt: 1750000000000, l: 7, nodeId: 'device-cafebabe' };
    const str = formatHlc(original.pt, original.l, original.nodeId);
    const parsed = parseHlc(str);
    expect(parsed.pt).toBe(original.pt);
    expect(parsed.l).toBe(original.l);
    expect(parsed.nodeId).toBe(original.nodeId);
  });

  it('handles nodeId with hyphens correctly', () => {
    const str = formatHlc(999, 3, 'device-a1-b2-c3');
    const parsed = parseHlc(str);
    expect(parsed.nodeId).toBe('device-a1-b2-c3');
  });

  it('throws on a string with fewer than 3 segments', () => {
    expect(() => parseHlc('0000000000001234_0000000001')).toThrow();
  });

  it('throws on non-numeric pt', () => {
    expect(() => parseHlc('zzzzzzzzzzzzzzzz_0000000001_device-x')).toThrow();
  });
});

describe('compareHlc', () => {
  it('returns negative when a is earlier than b (higher pt)', () => {
    const a = formatHlc(1000, 0, 'dev-x');
    const b = formatHlc(2000, 0, 'dev-x');
    expect(compareHlc(a, b)).toBeLessThan(0);
  });

  it('returns positive when a is later than b (higher pt)', () => {
    const a = formatHlc(3000, 0, 'dev-x');
    const b = formatHlc(1000, 0, 'dev-x');
    expect(compareHlc(a, b)).toBeGreaterThan(0);
  });

  it('returns zero for identical strings', () => {
    const s = formatHlc(5000, 3, 'dev-x');
    expect(compareHlc(s, s)).toBe(0);
  });

  it('uses logical counter as tiebreaker when pt is equal', () => {
    const low  = formatHlc(5000, 1, 'dev-x');
    const high = formatHlc(5000, 5, 'dev-x');
    expect(compareHlc(low, high)).toBeLessThan(0);
    expect(compareHlc(high, low)).toBeGreaterThan(0);
  });

  it('uses nodeId as final tiebreaker when pt and l are equal', () => {
    const a = formatHlc(5000, 3, 'device-aaa');
    const b = formatHlc(5000, 3, 'device-zzz');
    // 'aaa' < 'zzz' lexicographically
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, a)).toBeGreaterThan(0);
  });

  it('satisfies transitivity: a < b and b < c implies a < c', () => {
    const a = formatHlc(1000, 0, 'dev-a');
    const b = formatHlc(2000, 0, 'dev-b');
    const c = formatHlc(3000, 0, 'dev-c');
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, c)).toBeLessThan(0);
    expect(compareHlc(a, c)).toBeLessThan(0);
  });

  it('satisfies asymmetry: if a < b then b > a', () => {
    const a = formatHlc(1000, 2, 'dev-x');
    const b = formatHlc(1000, 5, 'dev-x');
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, a)).toBeGreaterThan(0);
  });
});

describe('maxHlc', () => {
  it('returns the later of two HLC strings', () => {
    const a = formatHlc(1000, 0, 'dev-a');
    const b = formatHlc(2000, 0, 'dev-b');
    expect(maxHlc(a, b)).toBe(b);
    expect(maxHlc(b, a)).toBe(b);
  });

  it('returns either string when they are equal', () => {
    const s = formatHlc(5000, 3, 'dev-x');
    expect(maxHlc(s, s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// SimulatedDevice — tick() monotonicity
// ---------------------------------------------------------------------------

describe('tick() monotonicity', () => {
  it('produces strictly non-decreasing HLC strings on a single device', () => {
    const device = new SimulatedDevice('dev-a', 1_000_000);
    const ticks: string[] = [];

    for (let i = 0; i < 100; i++) {
      device.advanceWallClock(1); // advance 1ms each iteration
      ticks.push(device.tick());
    }

    for (let i = 1; i < ticks.length; i++) {
      expect(compareHlc(ticks[i], ticks[i - 1])).toBeGreaterThan(0);
    }
  });

  it('advances logical counter when wall clock does not advance (frozen clock)', () => {
    // Wall clock stuck at 5000ms — logical counter must increment.
    const device = new SimulatedDevice('dev-a', 5_000);

    const t1 = device.tick(); // pt=5000, l=0
    const t2 = device.tick(); // pt=5000, l=1  (clock still frozen)
    const t3 = device.tick(); // pt=5000, l=2

    expect(compareHlc(t1, t2)).toBeLessThan(0);
    expect(compareHlc(t2, t3)).toBeLessThan(0);

    // Verify logical counter increments
    expect(parseHlc(t1).l).toBe(0);
    expect(parseHlc(t2).l).toBe(1);
    expect(parseHlc(t3).l).toBe(2);
  });

  it('resets logical counter to 0 when physical time advances', () => {
    const device = new SimulatedDevice('dev-a', 5_000);
    device.tick(); // l=0 at pt=5000
    device.tick(); // l=1 at pt=5000

    device.advanceWallClock(100); // clock advances to 5100
    const after = device.tick();  // pt=5100, l should reset to 0

    expect(parseHlc(after).pt).toBe(5_100);
    expect(parseHlc(after).l).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: Same-millisecond writes across two devices
// ---------------------------------------------------------------------------

describe('same-millisecond writes', () => {
  it('two devices writing at the same wall-clock ms produce a total order', () => {
    // Both devices have the same wall clock (e.g. synced via NTP to the millisecond).
    const WALL_CLOCK_MS = 1_750_000_000_000;
    const deviceA = new SimulatedDevice('device-aaaa', WALL_CLOCK_MS);
    const deviceB = new SimulatedDevice('device-bbbb', WALL_CLOCK_MS);

    const hlcA = deviceA.tick();
    const hlcB = deviceB.tick();

    // Both have pt = WALL_CLOCK_MS and l = 0, but different nodeIds.
    // The nodeId tiebreaker gives a deterministic total order.
    const comparison = compareHlc(hlcA, hlcB);
    expect(comparison).not.toBe(0); // strictly ordered, not equal
    // Verify the order is deterministic: same inputs → same comparison
    expect(compareHlc(hlcA, hlcB)).toBe(comparison);
  });

  it('100 same-millisecond writes from one device produce distinct total order', () => {
    const device = new SimulatedDevice('dev-a', 1_750_000_000_000);
    // Wall clock frozen — all writes have the same physical time.
    const ticks = Array.from({ length: 100 }, () => device.tick());

    // Each tick must be strictly greater than the previous.
    for (let i = 1; i < ticks.length; i++) {
      expect(compareHlc(ticks[i], ticks[i - 1])).toBeGreaterThan(0);
    }

    // All must be unique.
    expect(new Set(ticks).size).toBe(100);
  });

  it('three devices all writing at the same ms produce a consistent order', () => {
    const MS = 1_750_000_000_000;
    const dA = new SimulatedDevice('device-aaa', MS);
    const dB = new SimulatedDevice('device-bbb', MS);
    const dC = new SimulatedDevice('device-ccc', MS);

    const tA = dA.tick();
    const tB = dB.tick();
    const tC = dC.tick();

    // The comparison must be a total order: exactly one of tA, tB, tC is max
    const all   = [tA, tB, tC];
    const sorted = [...all].sort((a, b) => compareHlc(a, b));

    // Sorted order must be stable (same sort on every run)
    expect(sorted).toStrictEqual([...all].sort((a, b) => compareHlc(a, b)));

    // No ties
    expect(compareHlc(sorted[0], sorted[1])).toBeLessThan(0);
    expect(compareHlc(sorted[1], sorted[2])).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED: ±500ms clock skew
// ---------------------------------------------------------------------------

describe('clock skew ±500ms', () => {
  it('Device B with +500ms skew wins over Device A with accurate clock', () => {
    const REFERENCE_MS = 1_750_000_000_000;
    const deviceA = new SimulatedDevice('device-aaaa', REFERENCE_MS);       // accurate
    const deviceB = new SimulatedDevice('device-bbbb', REFERENCE_MS + 500); // +500ms ahead

    const tA = deviceA.tick();
    const tB = deviceB.tick();

    // B's physical time is ahead — B's HLC should be greater.
    expect(compareHlc(tB, tA)).toBeGreaterThan(0);
  });

  it('Device B with -500ms skew loses to Device A with accurate clock', () => {
    const REFERENCE_MS = 1_750_000_000_000;
    const deviceA = new SimulatedDevice('device-aaaa', REFERENCE_MS);       // accurate
    const deviceB = new SimulatedDevice('device-bbbb', REFERENCE_MS - 500); // -500ms behind

    const tA = deviceA.tick();
    const tB = deviceB.tick();

    // A's physical time is higher — A's HLC should be greater.
    expect(compareHlc(tA, tB)).toBeGreaterThan(0);
  });

  it('after receiving a +500ms message, slow device leaps ahead', () => {
    // Device B is 500ms behind. When it receives a message from A (which
    // is accurate), update() should advance B's pt to max(B.pt, A.pt, now).
    const REFERENCE_MS = 1_750_000_000_000;
    const deviceA = new SimulatedDevice('device-aaaa', REFERENCE_MS);       // accurate
    const deviceB = new SimulatedDevice('device-bbbb', REFERENCE_MS - 500); // 500ms behind

    const msgFromA = deviceA.tick(); // pt = REFERENCE_MS
    deviceB.update(msgFromA);        // B's pt advances to REFERENCE_MS

    const tAfterUpdate = deviceB.tick();

    // After update, B's next tick must be strictly greater than A's message.
    expect(compareHlc(tAfterUpdate, msgFromA)).toBeGreaterThan(0);
  });

  it('after receiving a future message, device does not go backward', () => {
    // Device B has an accurate clock. Device A's clock is 500ms ahead.
    // After B receives A's message, B's clock advances. If A's clock then
    // falls back (NTP correction), B's pt must NOT decrease.
    const REFERENCE_MS = 1_750_000_000_000;
    const deviceA = new SimulatedDevice('device-aaaa', REFERENCE_MS + 500); // 500ms ahead
    const deviceB = new SimulatedDevice('device-bbbb', REFERENCE_MS);

    const msgFromA = deviceA.tick(); // pt = REFERENCE_MS + 500
    const ptBefore = parseHlc(deviceB.tick()).pt;
    deviceB.update(msgFromA);        // B advances to REFERENCE_MS + 500
    const ptAfter  = parseHlc(deviceB.tick()).pt;

    // B's pt must never decrease
    expect(ptAfter).toBeGreaterThanOrEqual(ptBefore);
  });

  it('all three skewed devices produce a consistent ordering after mutual sync', () => {
    const BASE = 1_750_000_000_000;
    const dA = new SimulatedDevice('device-aaaa', BASE);        // accurate
    const dB = new SimulatedDevice('device-bbbb', BASE + 500);  // +500ms
    const dC = new SimulatedDevice('device-cccc', BASE - 300);  // -300ms

    const tA = dA.tick();
    const tB = dB.tick();

    // C receives A's and B's events, then ticks
    dC.update(tA);
    dC.update(tB);
    const tC = dC.tick();

    // After observing A and B, C must be ahead of both
    expect(compareHlc(tC, tA)).toBeGreaterThan(0);
    expect(compareHlc(tC, tB)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// update() receive-event rule
// ---------------------------------------------------------------------------

describe('update() receive-event rule', () => {
  it('advances local pt past remote pt', () => {
    const deviceA = new SimulatedDevice('dev-a', 1000);
    const deviceB = new SimulatedDevice('dev-b', 500); // B is 500ms behind

    const msgA = deviceA.tick(); // pt=1000
    deviceB.update(msgA);

    const tB = deviceB.tick();
    expect(parseHlc(tB).pt).toBeGreaterThanOrEqual(1000);
  });

  it('local write after update is strictly greater than the received message', () => {
    const deviceA = new SimulatedDevice('dev-a', 2000);
    const deviceB = new SimulatedDevice('dev-b', 1000);

    const msgA = deviceA.tick();
    deviceB.update(msgA);
    const tB = deviceB.tick();

    expect(compareHlc(tB, msgA)).toBeGreaterThan(0);
  });

  it('advancing local clock past a remote event fires the else branch in update()', () => {
    // Device A sends a message with pt=5000.
    // Device B's wall clock is 9000 — higher than both its own pt (0) and A's pt.
    //
    // In update():
    //   newPt = max(local.pt=0, remote.pt=5000, now=9000) = 9000
    //   newPt !== local.pt (9000 ≠ 0), newPt !== remote.pt (9000 ≠ 5000)
    //   → ELSE branch fires → l resets to 0 (internal state)
    //
    // The NEXT tick() with wall clock still frozen at 9000:
    //   newPt = max(pt=9000, now=9000) = 9000 = pt → increment l: 0 → 1
    //
    // So tick() returns l=1. The update() did reset l, but tick() increments
    // it because the clock is frozen. To observe l=0 from tick(), advance the
    // wall clock between update() and tick() (see separate test).
    const deviceA = new SimulatedDevice('dev-a', 5000);
    const deviceB = new SimulatedDevice('dev-b', 9000);

    const msgA = deviceA.tick(); // pt=5000, l=0
    deviceB.update(msgA);        // B: newPt=9000 (wall clock wins), l resets to 0

    const tB = deviceB.tick();   // wall clock still 9000 → l increments to 1
    expect(parseHlc(tB).pt).toBe(9000);
    expect(parseHlc(tB).l).toBe(1); // 0 (post-update) + 1 (tick increment) = 1
  });

  it('advancing wall clock after update produces l=0 on next tick', () => {
    // When the wall clock advances between update() and tick(), the tick()
    // sees a new pt > stored pt and resets l to 0.
    const deviceA = new SimulatedDevice('dev-a', 5000);
    const deviceB = new SimulatedDevice('dev-b', 9000);

    const msgA = deviceA.tick();  // pt=5000
    deviceB.update(msgA);         // B: pt=9000, l=0
    deviceB.advanceWallClock(1);  // B's clock → 9001

    const tB = deviceB.tick();    // now=9001, newPt=9001 > stored 9000 → l resets to 0
    expect(parseHlc(tB).pt).toBe(9001);
    expect(parseHlc(tB).l).toBe(0);
  });
});
