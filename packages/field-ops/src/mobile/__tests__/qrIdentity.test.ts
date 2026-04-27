/**
 * qrIdentity.test.ts
 * Mission Y acceptance — QR identity matrix
 *
 * Covers the framework-agnostic core. The RN view components
 * (AthleteQRCard, ScannerMode) are integration-tested via Maestro/Detox
 * in the mobile harness — they're excluded from vitest because they
 * import from `react-native` + `react-native-vision-camera`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  QR_PREFIX,
  isUUID,
  encodeAthleteQRPayload,
  parseAthleteQR,
  armFromScan,
  ScanDebouncer,
  MemoryAthleteCache,
  MemoryArmedAthleteSink,
  type ArmedAthlete,
} from '../qrIdentity';

const ATHLETE_A: ArmedAthlete = {
  id:         '11111111-1111-4111-a111-111111111111',
  first_name: 'Jordan',
  last_name:  'Garcia',
  position:   'WR',
  band_number: 42,
};
const ATHLETE_B: ArmedAthlete = {
  id:         '22222222-2222-4222-b222-222222222222',
  first_name: 'Marcus',
  last_name:  'Lee',
  position:   'RB',
  band_number: 17,
};

describe('isUUID', () => {
  it('accepts a v4 UUID', () => {
    expect(isUUID(ATHLETE_A.id)).toBe(true);
  });

  it('rejects a non-v4 UUID under strict v4', () => {
    // version=1, variant=8 → valid RFC4122 but not v4
    expect(isUUID('11111111-1111-1111-8111-111111111111', true)).toBe(false);
    expect(isUUID('11111111-1111-1111-8111-111111111111', false)).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isUUID('not-a-uuid')).toBe(false);
    expect(isUUID('')).toBe(false);
    expect(isUUID(undefined as unknown as string)).toBe(false);
    expect(isUUID('11111111-1111-4111-a111-11111111111')).toBe(false);  // 31 hex chars
  });
});

describe('encodeAthleteQRPayload', () => {
  it('produces the canonical CE1: prefixed payload', () => {
    const payload = encodeAthleteQRPayload(ATHLETE_A.id);
    expect(payload).toBe(`${QR_PREFIX}${ATHLETE_A.id}`);
    expect(payload.startsWith('CE1:')).toBe(true);
  });

  it('lowercases the UUID for canonical equality', () => {
    const upper = ATHLETE_A.id.toUpperCase();
    const payload = encodeAthleteQRPayload(upper);
    expect(payload).toBe(`${QR_PREFIX}${ATHLETE_A.id}`);
  });

  it('throws on a non-UUID input', () => {
    expect(() => encodeAthleteQRPayload('not-an-id')).toThrow();
  });
});

describe('parseAthleteQR', () => {
  it('round-trips through encode → parse', () => {
    const payload = encodeAthleteQRPayload(ATHLETE_A.id);
    const parsed  = parseAthleteQR(payload);
    expect(parsed).toEqual({ ok: true, uuid: ATHLETE_A.id });
  });

  it('rejects bare UUIDs without the prefix', () => {
    const r = parseAthleteQR(ATHLETE_A.id);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('wrong_prefix');
  });

  it('rejects non-Core-Elite QRs', () => {
    const r = parseAthleteQR('https://example.com/something');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('wrong_prefix');
  });

  it('rejects garbage after the prefix', () => {
    const r = parseAthleteQR(`${QR_PREFIX}not-a-uuid`);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('not_uuid');
  });

  it('rejects an empty string', () => {
    const r = parseAthleteQR('');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('empty');
  });

  it('tolerates surrounding whitespace and mixed case', () => {
    const payload = `   ${QR_PREFIX}${ATHLETE_A.id.toUpperCase()}   `;
    const r = parseAthleteQR(payload);
    expect(r.ok).toBe(true);
    expect((r as { uuid: string }).uuid).toBe(ATHLETE_A.id);
  });
});

describe('armFromScan — full pipeline', () => {
  let cache: MemoryAthleteCache;
  let sink:  MemoryArmedAthleteSink;

  beforeEach(() => {
    cache = new MemoryAthleteCache([ATHLETE_A, ATHLETE_B]);
    sink  = new MemoryArmedAthleteSink();
  });

  it('arms the sink on a valid Core Elite QR for a cached athlete', async () => {
    const qr = encodeAthleteQRPayload(ATHLETE_A.id);
    const result = await armFromScan(qr, cache, sink);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.athlete.id).toBe(ATHLETE_A.id);
    expect(sink.current?.id).toBe(ATHLETE_A.id);
    expect(sink.history).toHaveLength(1);
  });

  it('rejects with not_in_cache when the UUID is unknown', async () => {
    const qr = encodeAthleteQRPayload('99999999-9999-4999-a999-999999999999');
    const result = await armFromScan(qr, cache, sink);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not_in_cache');
    expect(sink.history).toHaveLength(0);
  });

  it('rejects rogue (non-prefixed) QRs without arming', async () => {
    const result = await armFromScan('https://attacker.com', cache, sink);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('wrong_prefix');
    expect(sink.history).toHaveLength(0);
  });

  it('replaces the previously-armed athlete on the next valid scan', async () => {
    await armFromScan(encodeAthleteQRPayload(ATHLETE_A.id), cache, sink);
    await armFromScan(encodeAthleteQRPayload(ATHLETE_B.id), cache, sink);

    expect(sink.current?.id).toBe(ATHLETE_B.id);
    expect(sink.history.map((a) => a.id)).toEqual([ATHLETE_A.id, ATHLETE_B.id]);
  });
});

describe('ScanDebouncer', () => {
  it('processes the first scan and suppresses identical repeats inside the window', () => {
    let now = 1_000_000;
    const d = new ScanDebouncer({ windowMs: 1500, now: () => now });

    expect(d.shouldProcess('A')).toBe(true);
    expect(d.shouldProcess('A')).toBe(false);
    now += 500;
    expect(d.shouldProcess('A')).toBe(false);
    now += 1100;        // total elapsed = 1600 > windowMs
    expect(d.shouldProcess('A')).toBe(true);
  });

  it('does not suppress a different code seen inside the window', () => {
    let now = 1_000_000;
    const d = new ScanDebouncer({ windowMs: 1500, now: () => now });

    expect(d.shouldProcess('A')).toBe(true);
    expect(d.shouldProcess('B')).toBe(true);    // different value → process
    expect(d.shouldProcess('B')).toBe(false);
  });

  it('reset() forgets the last scan', () => {
    const d = new ScanDebouncer({ windowMs: 1500, now: () => 1_000_000 });
    expect(d.shouldProcess('A')).toBe(true);
    expect(d.shouldProcess('A')).toBe(false);
    d.reset();
    expect(d.shouldProcess('A')).toBe(true);
  });
});
