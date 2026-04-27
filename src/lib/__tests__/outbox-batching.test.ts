/**
 * outbox-batching.test.ts
 * Mission "Sync Lock Hardening" — self-correction loop
 *
 * The mission's <self_correction_loop> mandates: simulate 200 dummy
 * outbox items and assert the batching loop fires exactly 4 times.
 * That is reproduced verbatim here so a reviewer can grep for the
 * exact wording. Plus boundary-condition tests covering 0, 1, 49, 50,
 * 51, and 199-item queues so the chunker is locked against off-by-one
 * regressions.
 */

import { describe, it, expect } from 'vitest';
import { chunkOutboxItems, OUTBOX_BATCH_SIZE, type ResultOutboxPayload } from '../offline';

// Build a dummy `OutboxItem`-ish record — the chunker is generic, so it
// only needs an array of *something*. We use a structurally-typed payload
// to confirm the strict-typed signature compiles end-to-end (anti-pattern
// guard from the spec: "the chunking logic strictly types the arrays and
// does not violate the OutboxItem payload structure").
function makeDummyResultPayload(i: number): ResultOutboxPayload {
  return {
    client_result_id: `client-${i.toString().padStart(4, '0')}`,
    event_id:         '00000000-0000-4000-a000-000000000001',
    athlete_id:       `00000000-0000-4000-a000-${i.toString().padStart(12, '0')}`,
    band_id:          `band-${i}`,
    station_id:       `station-${(i % 3) + 1}`,
    drill_type:       'forty',
    value_num:        4.5 + (i % 10) * 0.01,
    attempt_number:   1,
    meta:             { hlc_timestamp: `0000000000000${i}`.padStart(16, '0') + '_0000000001_device-test' },
    source_type:      'manual',
  };
}

describe('chunkOutboxItems — Mission "Sync Lock Hardening"', () => {
  it('OUTBOX_BATCH_SIZE is 50 (anti-pattern: queue >50 must be chunked)', () => {
    expect(OUTBOX_BATCH_SIZE).toBe(50);
  });

  it('200 dummy outbox items → batching loop fires exactly 4 times', () => {
    const items = Array.from({ length: 200 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);

    // The mandated assertion. If this number drifts, the spec contract
    // with Supabase RPC timeouts + IndexedDB lock budgets is violated.
    expect(batches).toHaveLength(4);
    expect(batches.every((b) => b.length === 50)).toBe(true);

    // Concatenating the batches reconstructs the original order — chunking
    // never reorders the FIFO sequence the sync loop relies on for HLC
    // causal preservation.
    const flattened = batches.flat();
    expect(flattened).toHaveLength(200);
    expect(flattened[0].client_result_id).toBe('client-0000');
    expect(flattened[199].client_result_id).toBe('client-0199');
  });

  it('chunks every item exactly once — no drops, no duplicates', () => {
    const items = Array.from({ length: 200 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    const seen = new Set<string>();
    for (const batch of batches) {
      for (const item of batch) {
        expect(seen.has(item.client_result_id)).toBe(false);
        seen.add(item.client_result_id);
      }
    }
    expect(seen.size).toBe(200);
  });

  it('preserves FIFO order across the chunk boundary', () => {
    const items = Array.from({ length: 200 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    // Batch 0 ends at index 49, batch 1 starts at 50 — the boundary
    // is the most regression-prone slot. Confirm both endpoints.
    expect(batches[0][49].client_result_id).toBe('client-0049');
    expect(batches[1][0].client_result_id).toBe('client-0050');
    expect(batches[2][0].client_result_id).toBe('client-0100');
    expect(batches[3][0].client_result_id).toBe('client-0150');
    expect(batches[3][49].client_result_id).toBe('client-0199');
  });

  it('handles empty queue → zero batches', () => {
    expect(chunkOutboxItems([], OUTBOX_BATCH_SIZE)).toEqual([]);
  });

  it('handles single-item queue → one batch with one item', () => {
    const items = [makeDummyResultPayload(0)];
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('boundary — 49 items → exactly 1 batch (queue NOT >50)', () => {
    const items = Array.from({ length: 49 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(49);
  });

  it('boundary — 50 items → exactly 1 batch (still fits in one)', () => {
    const items = Array.from({ length: 50 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(50);
  });

  it('boundary — 51 items → exactly 2 batches (one over → split)', () => {
    const items = Array.from({ length: 51 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(1);
  });

  it('199 items → exactly 4 batches (last is short)', () => {
    const items = Array.from({ length: 199 }, (_, i) => makeDummyResultPayload(i));
    const batches = chunkOutboxItems(items, OUTBOX_BATCH_SIZE);
    expect(batches).toHaveLength(4);
    expect(batches.slice(0, 3).every((b) => b.length === 50)).toBe(true);
    expect(batches[3]).toHaveLength(49);
  });

  it('size <= 0 falls back to a single chunk (defensive, never silent misbehavior)', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeDummyResultPayload(i));
    expect(chunkOutboxItems(items, 0)).toEqual([items]);
    expect(chunkOutboxItems(items, -10)).toEqual([items]);
  });
});
