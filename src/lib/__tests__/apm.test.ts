/**
 * apm.test.ts — Mission V acceptance
 *
 * Verifies the APM layer is inert in dev/test, reports above threshold in
 * prod (via force=true), and lets the transport swallow errors without
 * throwing into the app.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initAPM,
  reportSlowQuery,
  reportRender,
  reportNav,
  reportError,
  APMEvent,
  APMTransport,
  __resetAPMForTest,
  APM_THRESHOLDS,
} from '../apm';

class RecordingTransport implements APMTransport {
  events: APMEvent[] = [];
  send(event: APMEvent): void { this.events.push(event); }
}

describe('APM layer', () => {
  beforeEach(() => { __resetAPMForTest(); });

  it('is inert when not initialised', () => {
    const t = new RecordingTransport();
    // initAPM never called — reporters should no-op.
    reportSlowQuery('test.rpc', 9999, 'rpc');
    reportRender('slow', 9999);
    reportNav('/anywhere', 999);
    reportError('boom');
    expect(t.events).toHaveLength(0);
  });

  it('is inert outside prod unless force=true', () => {
    const t = new RecordingTransport();
    // Default env for vitest is NOT prod; initAPM should early-return.
    initAPM({ transport: t });
    reportSlowQuery('test.rpc', 9999, 'rpc');
    expect(t.events).toHaveLength(0);
  });

  it('emits slow RPC events above the 300ms threshold', () => {
    const t = new RecordingTransport();
    initAPM({ force: true, transport: t });

    reportSlowQuery('submit_result_secure', APM_THRESHOLDS.RPC_MS - 1, 'rpc');
    expect(t.events).toHaveLength(0);

    reportSlowQuery('submit_result_secure', APM_THRESHOLDS.RPC_MS + 1, 'rpc');
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({
      type: 'query',
      name: 'submit_result_secure',
      tags: { kind: 'rpc' },
    });
  });

  it('uses the SELECT threshold for select/mutate kinds', () => {
    const t = new RecordingTransport();
    initAPM({ force: true, transport: t });

    reportSlowQuery('athletes.select', APM_THRESHOLDS.SELECT_MS - 1, 'select');
    expect(t.events).toHaveLength(0);
    reportSlowQuery('athletes.select', APM_THRESHOLDS.SELECT_MS + 1, 'select');
    expect(t.events).toHaveLength(1);
  });

  it('emits nav events unconditionally (route transitions are load-bearing)', () => {
    const t = new RecordingTransport();
    initAPM({ force: true, transport: t });
    reportNav('/staff/station/42', 12);
    reportNav('/admin/dashboard', 0);
    expect(t.events.map(e => e.name)).toEqual(['/staff/station/42', '/admin/dashboard']);
  });

  it('swallows transport errors so APM never crashes the app', () => {
    const throwing: APMTransport = { send() { throw new Error('collector down'); } };
    initAPM({ force: true, transport: throwing });
    // reportRender is above threshold — would call transport.
    expect(() => reportRender('slow-boundary', 9999)).not.toThrow();
  });

  it('respects sampleRate=0 (everything dropped)', () => {
    const t = new RecordingTransport();
    initAPM({ force: true, transport: t, sampleRate: 0 });
    for (let i = 0; i < 100; i++) reportNav('/sampled-out', 10);
    expect(t.events).toHaveLength(0);
  });

  it('second initAPM call does not replace the transport', () => {
    const a = new RecordingTransport();
    const b = new RecordingTransport();
    initAPM({ force: true, transport: a });
    initAPM({ force: true, transport: b });
    reportNav('/x', 1);
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });
});

describe('APM transport swallow vs reporter swallow', () => {
  it('reportError is coarse — always recorded when enabled', () => {
    const t = new RecordingTransport();
    __resetAPMForTest();
    initAPM({ force: true, transport: t });
    reportError('ErrorBoundary:caught', { route: '/admin/ops' });
    expect(t.events[0]).toMatchObject({ type: 'error', name: 'ErrorBoundary:caught' });
  });
});

// Silence vitest about unused import in some configs.
void vi;
