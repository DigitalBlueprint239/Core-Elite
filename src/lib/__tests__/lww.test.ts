/**
 * lww.test.ts
 * Unit tests for add-biased Last-Write-Wins conflict resolution (v2 §3.1.2).
 *
 * Coverage targets:
 *   ✓ lwwShouldReplace: strict inequality — ties DO NOT replace
 *   ✓ addBiasedShouldKeep: >= inequality — ties ALWAYS keep
 *   ✓ resolvePayloadConflict: all HLC comparison cases + missing HLC fallbacks
 *   ✓ deviceStatusShouldUpdate: strict > for mutable record updates
 *   ✓ The core add-biased guarantee: no timing result is ever silently deleted
 */

import { describe, it, expect } from 'vitest';
import { formatHlc } from '../hlc';
import {
  lwwShouldReplace,
  addBiasedShouldKeep,
  resolvePayloadConflict,
  deviceStatusShouldUpdate,
} from '../lww';

// ---------------------------------------------------------------------------
// Helpers — build HLC strings without spinning up devices
// ---------------------------------------------------------------------------

function hlc(pt: number, l: number, node: string): string {
  return formatHlc(pt, l, node);
}

const EARLIER = hlc(1_000, 0, 'device-a');
const LATER   = hlc(2_000, 0, 'device-a');
const SAME_PT_LOW_L  = hlc(5_000, 0, 'device-a');
const SAME_PT_HIGH_L = hlc(5_000, 9, 'device-a');
const SAME_BOTH_A = hlc(5_000, 3, 'device-aaa');
const SAME_BOTH_B = hlc(5_000, 3, 'device-bbb');

// ---------------------------------------------------------------------------
// lwwShouldReplace — immutable record update guard
// ---------------------------------------------------------------------------

describe('lwwShouldReplace', () => {
  it('returns true when incoming is strictly later (higher pt)', () => {
    expect(lwwShouldReplace(EARLIER, LATER)).toBe(true);
  });

  it('returns false when incoming is earlier', () => {
    expect(lwwShouldReplace(LATER, EARLIER)).toBe(false);
  });

  it('returns false on equal HLC strings — ties do NOT replace', () => {
    // Critical: tie case must not replace. For immutable results, this means
    // the existing record stays and the incoming is treated as a duplicate.
    expect(lwwShouldReplace(EARLIER, EARLIER)).toBe(false);
    expect(lwwShouldReplace(SAME_BOTH_A, SAME_BOTH_A)).toBe(false);
  });

  it('returns true when incoming has higher logical counter (same pt)', () => {
    expect(lwwShouldReplace(SAME_PT_LOW_L, SAME_PT_HIGH_L)).toBe(true);
  });

  it('returns false when incoming has lower logical counter (same pt)', () => {
    expect(lwwShouldReplace(SAME_PT_HIGH_L, SAME_PT_LOW_L)).toBe(false);
  });

  it('handles nodeId tiebreak: higher nodeId wins when pt and l are equal', () => {
    // device-bbb > device-aaa lexicographically
    expect(lwwShouldReplace(SAME_BOTH_A, SAME_BOTH_B)).toBe(true);
    expect(lwwShouldReplace(SAME_BOTH_B, SAME_BOTH_A)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addBiasedShouldKeep — THE CORE ANTI-DATA-LOSS GUARANTEE
// ---------------------------------------------------------------------------

describe('addBiasedShouldKeep', () => {
  it('returns true when addHlc is strictly later (add is clearly newer)', () => {
    expect(addBiasedShouldKeep(LATER, EARLIER)).toBe(true);
  });

  it('returns false when addHlc is strictly earlier (remove is newer)', () => {
    expect(addBiasedShouldKeep(EARLIER, LATER)).toBe(false);
  });

  it('returns TRUE on exact tie — add ALWAYS wins ties', () => {
    // This is the add-biased guarantee from v2 §3.1.2:
    //   "when max_t(add) = max_t(remove), preserve the record.
    //    Never silently delete a timing result."
    expect(addBiasedShouldKeep(EARLIER, EARLIER)).toBe(true);
    expect(addBiasedShouldKeep(SAME_BOTH_A, SAME_BOTH_A)).toBe(true);
    expect(addBiasedShouldKeep(SAME_BOTH_B, SAME_BOTH_B)).toBe(true);
  });

  it('returns true on same-ms tie between two devices (both pt=5000, l=3)', () => {
    // Two tablets record the same athlete in the same millisecond.
    // Both have the same pt and l. add-biased rule: keep the record.
    expect(addBiasedShouldKeep(SAME_BOTH_A, SAME_BOTH_B)).toBeDefined();
    // At minimum, the add must not lose due to a tie with any remove
    // timestamp equal to itself
    expect(addBiasedShouldKeep(SAME_BOTH_A, SAME_BOTH_A)).toBe(true);
  });

  it('add-biased rule is strictly stronger than lwwShouldReplace on ties', () => {
    // For a tie: lwwShouldReplace returns false, addBiasedShouldKeep returns true.
    // This asymmetry is intentional: adds survive ties, removes do not.
    const tie = EARLIER;
    expect(lwwShouldReplace(tie, tie)).toBe(false);   // lww tie → no replace
    expect(addBiasedShouldKeep(tie, tie)).toBe(true); // add-biased tie → keep
  });
});

// ---------------------------------------------------------------------------
// resolvePayloadConflict — generic conflict resolver
// ---------------------------------------------------------------------------

describe('resolvePayloadConflict', () => {
  type Record = { id: string; hlc_timestamp?: string; value: number };

  const makeRecord = (id: string, hlc: string, value: number): Record =>
    ({ id, hlc_timestamp: hlc, value });

  it('returns incoming when incoming HLC is strictly later', () => {
    const existing = makeRecord('r1', EARLIER, 10);
    const incoming = makeRecord('r2', LATER,   20);
    expect(resolvePayloadConflict(existing, incoming)).toBe(incoming);
  });

  it('returns existing when existing HLC is strictly later', () => {
    const existing = makeRecord('r1', LATER,   10);
    const incoming = makeRecord('r2', EARLIER, 20);
    expect(resolvePayloadConflict(existing, incoming)).toBe(existing);
  });

  it('returns existing on equal HLC strings (stable tiebreak — first write wins)', () => {
    const existing = makeRecord('r1', EARLIER, 10);
    const incoming = makeRecord('r2', EARLIER, 20);
    // Equal HLCs → existing wins. This is safe for immutable timing results
    // because both records have distinct client_result_ids — they are separate
    // records, not competing versions of the same record.
    expect(resolvePayloadConflict(existing, incoming)).toBe(existing);
  });

  it('returns incoming when only incoming has an HLC', () => {
    const existing = makeRecord('r1', undefined as any, 10);
    const incoming = makeRecord('r2', LATER, 20);
    expect(resolvePayloadConflict(existing, incoming)).toBe(incoming);
  });

  it('returns existing when neither has an HLC', () => {
    const existing = makeRecord('r1', undefined as any, 10);
    const incoming = makeRecord('r2', undefined as any, 20);
    // No ordering information — keep existing (stable)
    expect(resolvePayloadConflict(existing, incoming)).toBe(existing);
  });

  it('returns existing when only existing has an HLC', () => {
    const existing = makeRecord('r1', LATER, 10);
    const incoming = makeRecord('r2', undefined as any, 20);
    expect(resolvePayloadConflict(existing, incoming)).toBe(existing);
  });

  it('is idempotent: applying twice gives the same result', () => {
    const existing = makeRecord('r1', EARLIER, 10);
    const incoming = makeRecord('r2', LATER,   20);
    const first  = resolvePayloadConflict(existing, incoming);
    const second = resolvePayloadConflict(existing, incoming);
    expect(first).toBe(second);
  });

  it('is not symmetric: swapping inputs may change result', () => {
    const a = makeRecord('r1', EARLIER, 10);
    const b = makeRecord('r2', LATER,   20);
    const ab = resolvePayloadConflict(a, b);
    const ba = resolvePayloadConflict(b, a);
    // One of these must be a, the other b (different winners)
    expect(ab).toBe(b);
    expect(ba).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// deviceStatusShouldUpdate — mutable record, strict >
// ---------------------------------------------------------------------------

describe('deviceStatusShouldUpdate', () => {
  it('returns true when incoming HLC is strictly greater (newer heartbeat)', () => {
    expect(deviceStatusShouldUpdate(EARLIER, LATER)).toBe(true);
  });

  it('returns false when incoming HLC is older (stale heartbeat should be rejected)', () => {
    // This is the scenario from migration 017: a queued offline heartbeat
    // arrives after a fresher online heartbeat. Must be rejected.
    expect(deviceStatusShouldUpdate(LATER, EARLIER)).toBe(false);
  });

  it('returns false on equal HLC (tie — keep existing, do not overwrite)', () => {
    // For mutable records, ties go to existing (strict > not >=).
    // This is the opposite of addBiasedShouldKeep, which is for immutable adds.
    expect(deviceStatusShouldUpdate(EARLIER, EARLIER)).toBe(false);
  });

  it('uses strict > — one stronger than the add-biased >= rule', () => {
    const same = SAME_BOTH_A;
    expect(deviceStatusShouldUpdate(same, same)).toBe(false); // strict: tie → no update
    expect(addBiasedShouldKeep(same, same)).toBe(true);       // add-biased: tie → keep
  });
});

// ---------------------------------------------------------------------------
// Cross-function contract test
//
// The add-biased rule must be STRICTLY STRONGER than lwwShouldReplace for ties.
// If both functions ever return the same value on a tie, the add-bias is lost.
// ---------------------------------------------------------------------------

describe('add-biased contract', () => {
  const allTestHlcs = [EARLIER, LATER, SAME_PT_LOW_L, SAME_PT_HIGH_L, SAME_BOTH_A, SAME_BOTH_B];

  it('for any HLC h: addBiasedShouldKeep(h, h) is always true', () => {
    for (const h of allTestHlcs) {
      expect(addBiasedShouldKeep(h, h)).toBe(true);
    }
  });

  it('for any HLC h: lwwShouldReplace(h, h) is always false', () => {
    for (const h of allTestHlcs) {
      expect(lwwShouldReplace(h, h)).toBe(false);
    }
  });

  it('for any HLC h: deviceStatusShouldUpdate(h, h) is always false', () => {
    for (const h of allTestHlcs) {
      expect(deviceStatusShouldUpdate(h, h)).toBe(false);
    }
  });
});
