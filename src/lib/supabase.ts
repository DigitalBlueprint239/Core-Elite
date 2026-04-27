import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { reportSlowQuery } from './apm';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing. Please check your .env file.');
}

const rawClient = createClient(supabaseUrl || '', supabaseAnonKey || '');

/**
 * APM instrumentation — wraps .rpc() so every RPC round-trip reports its
 * latency to the APM collector. The wrapper is a thin Proxy layer so the
 * Supabase client's Fluent API (eq, in, order, ...) still works unchanged
 * at every call site.
 *
 * Scope:
 *   - .rpc(name, args) — timed from invocation to Promise resolution.
 *   - table queries (.from(...).select/insert/update/delete) — left alone.
 *     Supabase's builder returns PostgrestQueryBuilder chains that would
 *     require a deep proxy to instrument cleanly; for D1 audit we only
 *     need RPC latency (the slow-path API) for now.
 *
 * The wrapper is always installed — reportSlowQuery is a no-op when APM
 * isn't enabled, so dev/test paths pay nothing.
 */
function instrumentRpc(client: SupabaseClient): SupabaseClient {
  const originalRpc = client.rpc.bind(client);
  (client as any).rpc = function rpcInstrumented(name: string, args?: any, opts?: any) {
    const start = performance.now();
    const builder = originalRpc(name, args, opts);

    // PostgrestFilterBuilder is a thenable — hook .then() to time resolution.
    const originalThen = builder.then.bind(builder);
    (builder as any).then = (onFulfilled?: any, onRejected?: any) =>
      originalThen(
        (v: any) => {
          reportSlowQuery(name, performance.now() - start, 'rpc');
          return onFulfilled ? onFulfilled(v) : v;
        },
        (e: any) => {
          reportSlowQuery(name, performance.now() - start, 'rpc', { ok: false });
          if (onRejected) return onRejected(e);
          throw e;
        },
      );

    return builder;
  };

  return client;
}

export const supabase = instrumentRpc(rawClient);
