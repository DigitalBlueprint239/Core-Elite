/**
 * apm.ts
 * Core Elite — Application Performance Monitoring
 *
 * A lightweight, vendor-agnostic APM layer. Zero runtime dependencies —
 * captures render timings from the browser's native PerformanceObserver
 * and wraps Supabase queries to measure round-trip latency, then ships
 * events via a pluggable transport (Beacon / Sentry / LogRocket).
 *
 * Why not pull in Sentry directly:
 *   - The Sentry SDK adds ~90KB gzipped and forces an opinion on error
 *     capture (which we already handle via <ErrorBoundary>).
 *   - D1 infosec audits require data-egress documentation. A thin shim
 *     we own and can point at any collector (including an on-prem one)
 *     is easier to sign off than a vendor SDK.
 *   - The shape below is Sentry/LogRocket-compatible: swap the transport
 *     in initAPM() and no call-site changes are needed.
 *
 * Activation:
 *   - Production only (import.meta.env.PROD).
 *   - Opt-out via VITE_APM_DISABLED=1 (e.g. for staff privacy drills).
 *   - Sampled at VITE_APM_SAMPLE_RATE (default 1.0) to cap cost on free tiers.
 *
 * Three event classes are recorded:
 *
 *   - 'render'  — React / route render timings, from PerformanceObserver
 *                 'longtask' and 'largest-contentful-paint' entries.
 *   - 'query'   — Supabase RPC / table query round-trip, wrapped by
 *                 instrumentSupabase() in src/lib/supabase.ts.
 *   - 'nav'     — SPA route transitions (reported by App.tsx on every
 *                 react-router navigation).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type APMEventType = 'render' | 'query' | 'nav' | 'error';

export interface APMEvent {
  type:       APMEventType;
  name:       string;            // e.g. 'LCP', 'submit_result_secure', '/staff/station/:id'
  durationMs: number;
  timestamp:  number;             // Date.now() at capture
  tags?:      Record<string, string | number | boolean>;
}

export interface APMTransport {
  send(event: APMEvent): void;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * BeaconTransport — POSTs JSON via navigator.sendBeacon so the request
 * survives page unload. Ideal for a self-hosted collector; swap out for
 * Sentry.captureMessage() or LogRocket.track() if you adopt a vendor.
 */
export class BeaconTransport implements APMTransport {
  constructor(private endpoint: string) {}
  send(event: APMEvent): void {
    try {
      const body = JSON.stringify(event);
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(this.endpoint, body);
        return;
      }
      // Fallback — unloaded page may drop this, which is acceptable.
      void fetch(this.endpoint, {
        method:      'POST',
        headers:     { 'content-type': 'application/json' },
        body,
        keepalive:   true,
      }).catch(() => {});
    } catch {
      // APM must never throw into the app.
    }
  }
}

/**
 * ConsoleTransport — dev-mode echo. Not wired in prod; documented here so
 * on-call has a zero-infra way to validate the pipeline during rollout.
 */
export class ConsoleTransport implements APMTransport {
  send(event: APMEvent): void {
    // eslint-disable-next-line no-console
    console.debug('[apm]', event);
  }
}

// ---------------------------------------------------------------------------
// Slow-query thresholds — D1 infosec mandates visibility into anything
// slower than these. Values chosen against our p95 baseline:
//   - RPC:          300ms  (submit_result_secure observed p95 ~180ms)
//   - SELECT:       500ms  (admin table queries with joins)
//   - Route render: 100ms  (60fps budget is 16ms; 100ms = "perceptible")
// Edit with care; every bump inflates the noise floor for reviewers.
// ---------------------------------------------------------------------------

export const APM_THRESHOLDS = {
  RPC_MS:          300,
  SELECT_MS:       500,
  RENDER_MS:       100,
  LONGTASK_MS:      50,   // browser-defined — PerformanceObserver's own floor
} as const;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

interface APMState {
  enabled:    boolean;
  sampleRate: number;
  transport:  APMTransport | null;
}

let _state: APMState = {
  enabled:    false,
  sampleRate: 1,
  transport:  null,
};

function shouldSample(): boolean {
  return _state.enabled && Math.random() < _state.sampleRate;
}

function record(event: APMEvent): void {
  if (!shouldSample() || !_state.transport) return;
  // Transport errors must never propagate — APM is best-effort.
  try { _state.transport.send(event); } catch { /* swallowed */ }
}

// ---------------------------------------------------------------------------
// Public API — initAPM
// ---------------------------------------------------------------------------

export interface InitAPMOptions {
  /** Override prod-only guard — set to true from a dev harness to exercise transport. */
  force?:       boolean;
  /** Fraction of events to send. Default 1.0. */
  sampleRate?:  number;
  /** Where to send events. Defaults to BeaconTransport(VITE_APM_ENDPOINT). */
  transport?:   APMTransport;
}

/**
 * initAPM — set up performance observers and wire the transport.
 * Safe to call multiple times; subsequent calls no-op if already initialised.
 * Never throws — a busted observer must not crash the app.
 */
export function initAPM(opts: InitAPMOptions = {}): void {
  if (_state.enabled) return;

  const env = (import.meta as any).env ?? {};
  const isProd = Boolean(env.PROD);
  const explicitlyDisabled = env.VITE_APM_DISABLED === '1' || env.VITE_APM_DISABLED === 'true';

  if (!opts.force && (!isProd || explicitlyDisabled)) return;

  const sampleRate = opts.sampleRate ?? Number(env.VITE_APM_SAMPLE_RATE ?? 1);
  const endpoint   = env.VITE_APM_ENDPOINT as string | undefined;
  const transport  = opts.transport
                  ?? (endpoint ? new BeaconTransport(endpoint) : null);

  if (!transport) {
    // No transport means APM is effectively a no-op — keep enabled=false.
    return;
  }

  _state = { enabled: true, sampleRate, transport };

  try {
    // Long-task capture (>50ms on the main thread — jank source)
    if (typeof PerformanceObserver !== 'undefined') {
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= APM_THRESHOLDS.LONGTASK_MS) {
            record({
              type:       'render',
              name:       'longtask',
              durationMs: Math.round(entry.duration),
              timestamp:  Date.now(),
              tags:       { entry_type: entry.entryType },
            });
          }
        }
      });
      try { longTaskObserver.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit); }
      catch { /* longtask unsupported in some browsers */ }

      // LCP — Largest Contentful Paint (page-load render quality)
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (!last) return;
        record({
          type:       'render',
          name:       'LCP',
          durationMs: Math.round(last.startTime),
          timestamp:  Date.now(),
        });
      });
      try { lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true } as PerformanceObserverInit); }
      catch { /* LCP unsupported in some browsers */ }
    }
  } catch {
    // APM init must never crash app boot.
  }
}

// ---------------------------------------------------------------------------
// Public API — reporters called from the app
// ---------------------------------------------------------------------------

/**
 * reportRender — call after a heavy render pass to log the duration.
 * Only emitted when durationMs >= APM_THRESHOLDS.RENDER_MS.
 */
export function reportRender(name: string, durationMs: number, tags?: APMEvent['tags']): void {
  if (durationMs < APM_THRESHOLDS.RENDER_MS) return;
  record({ type: 'render', name, durationMs: Math.round(durationMs), timestamp: Date.now(), tags });
}

/** reportNav — SPA route change. Not threshold-gated (always emitted). */
export function reportNav(path: string, durationMs: number): void {
  record({ type: 'nav', name: path, durationMs: Math.round(durationMs), timestamp: Date.now() });
}

/**
 * reportSlowQuery — called by the Supabase wrapper. Gated by the table's
 * operation kind so RPCs and SELECTs get separate thresholds.
 */
export function reportSlowQuery(
  name: string,
  durationMs: number,
  kind: 'rpc' | 'select' | 'mutate',
  tags?: APMEvent['tags'],
): void {
  const threshold = kind === 'rpc' ? APM_THRESHOLDS.RPC_MS : APM_THRESHOLDS.SELECT_MS;
  if (durationMs < threshold) return;
  record({
    type:       'query',
    name,
    durationMs: Math.round(durationMs),
    timestamp:  Date.now(),
    tags:       { kind, ...(tags ?? {}) },
  });
}

/**
 * reportError — structural errors caught by ErrorBoundary or global
 * handlers. APM error events are deliberately coarse — detailed stack
 * traces belong in a separate error-tracking channel.
 */
export function reportError(name: string, tags?: APMEvent['tags']): void {
  record({ type: 'error', name, durationMs: 0, timestamp: Date.now(), tags });
}

// ---------------------------------------------------------------------------
// Test hook — reset module state. Exported for vitest only.
// ---------------------------------------------------------------------------

export function __resetAPMForTest(): void {
  _state = { enabled: false, sampleRate: 1, transport: null };
}
