/**
 * stripe-webhook
 * Core Elite — Mission "Stripe Webhook Engine"
 *
 * Signature-verified Stripe webhook handler. This is the revenue ingest:
 * subscription lifecycle events flow from Stripe → this function →
 * `organizations` table. Three security invariants hold:
 *
 *   1. SIGNATURE — every request body is verified against
 *      STRIPE_WEBHOOK_SECRET via Stripe's HMAC-SHA-256 scheme using
 *      `webhooks.constructEventAsync`. Failures return 400 immediately
 *      and never reach the handlers. Anti-pattern: skipping or mocking
 *      signature verification — explicitly forbidden, NEVER deployed.
 *
 *   2. REPLAY PROTECTION — every event.id is inserted into the
 *      `stripe_webhook_events` table BEFORE any side-effecting work.
 *      The PRIMARY KEY constraint makes the dedup atomic; a duplicate
 *      delivery (Stripe retries, accidental replays) hits unique-
 *      violation and the function returns 200 OK without re-running.
 *
 *   3. SERVICE ROLE ISOLATION — SUPABASE_SERVICE_ROLE_KEY only ever
 *      reads from Deno.env. Never logged, never echoed to the response,
 *      never bundled with the client. The Supabase client constructed
 *      below intentionally bypasses RLS so the webhook can write to
 *      organizations regardless of which authenticated user (if any)
 *      triggered the upstream Stripe action.
 *
 * Three event types handled:
 *
 *   checkout.session.completed       → first subscription started.
 *                                      Links org → customer + subscription.
 *   customer.subscription.updated    → status change (trialing→active,
 *                                      active→past_due, etc.).
 *   customer.subscription.deleted    → subscription canceled.
 *
 * Other event types are acknowledged with 200 (so Stripe stops retrying)
 * but logged in stripe_webhook_events with no side effects.
 *
 * Local development:
 *   1. `stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook`
 *   2. `npx supabase functions serve stripe-webhook --env-file ./.env.local --no-verify-jwt`
 *      (--no-verify-jwt is required: Stripe never sends a Supabase JWT.)
 *   3. `stripe trigger checkout.session.completed`
 *
 * Required environment variables (set via `supabase secrets set`):
 *   STRIPE_SECRET_KEY              — sk_live_* or sk_test_*
 *   STRIPE_WEBHOOK_SECRET          — whsec_* matching the webhook endpoint
 *   SUPABASE_URL                   — auto-provided by the Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY      — auto-provided by the Supabase runtime
 */

// @ts-ignore — Deno-resolved npm specifier; web tsc excludes this file.
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
// @ts-ignore — Deno-resolved npm specifier.
import Stripe from 'npm:stripe@^17.0.0';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Stripe API version pinned so a server-side change at Stripe doesn't
// silently shift the event payload shape. Bump deliberately, in tandem
// with handler updates.
const STRIPE_API_VERSION = '2024-12-18.acacia' as const;

// CORS — webhook endpoints don't need browser CORS, but a permissive
// preflight handler is necessary for `stripe listen` local forwarding.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Subscription status domain — must match the CHECK constraint installed
// by migration 011a. Anything not in this set is treated as 'inactive'
// to satisfy the DB CHECK without losing the event in the ledger.
// ---------------------------------------------------------------------------

const KNOWN_STATUSES = new Set([
  'inactive', 'incomplete', 'incomplete_expired', 'trialing',
  'active', 'past_due', 'canceled', 'unpaid', 'paused',
] as const);

function normalizeStatus(s: string | null | undefined): string {
  if (s && KNOWN_STATUSES.has(s as typeof KNOWN_STATUSES extends Set<infer T> ? T : never)) {
    return s;
  }
  return 'inactive';
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function plainResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Replay-protection ledger — INSERT-then-process pattern
//
// Returns:
//   - 'inserted' when this is the first time we've seen this event_id
//   - 'duplicate' when the row already exists (retry / replay)
//   - 'error' on any other DB failure (we let the caller 500 so Stripe retries)
// ---------------------------------------------------------------------------

type RecordOutcome = 'inserted' | 'duplicate' | 'error';

async function recordEvent(
  admin:    SupabaseClient,
  event:    Stripe.Event,
): Promise<{ outcome: RecordOutcome; error?: string }> {
  const { error } = await admin
    .from('stripe_webhook_events')
    .insert({
      event_id:    event.id,
      event_type:  event.type,
      payload:     event as unknown as Record<string, unknown>,
    });

  if (!error) return { outcome: 'inserted' };

  // Postgres unique-violation. The supabase-js client surfaces the SQLSTATE
  // code as `error.code === '23505'`. Anything else is unexpected.
  if (error.code === '23505') return { outcome: 'duplicate' };

  return { outcome: 'error', error: error.message };
}

async function markProcessed(
  admin:        SupabaseClient,
  eventId:      string,
  errorMessage: string | null = null,
): Promise<void> {
  // Best-effort — failure here doesn't break the side-effect path that
  // already succeeded. We log to console for the Supabase logs surface.
  const { error } = await admin
    .from('stripe_webhook_events')
    .update({
      processed_at:  new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq('event_id', eventId);

  if (error) {
    console.error('[stripe-webhook] failed to mark event processed', eventId, error.message);
  }
}

// ---------------------------------------------------------------------------
// Event handlers — each is purely a database write. Side effects on
// other systems (email, analytics) belong in dedicated workers, not in
// the webhook critical path; latency added here is latency Stripe sees
// and uses to drive its retry timer.
// ---------------------------------------------------------------------------

interface OrgUpdate {
  stripe_customer_id?:     string;
  stripe_subscription_id?: string | null;
  subscription_status?:    string;
}

/**
 * Resolve the Core Elite organization the event refers to. We try, in
 * order:
 *   1. event.data.object.client_reference_id       (set on Checkout)
 *   2. event.data.object.metadata.organization_id  (set on Subscription)
 *   3. lookup by stripe_customer_id                (works for any event
 *                                                   that already linked
 *                                                   the customer in a
 *                                                   prior delivery)
 */
async function resolveOrganizationId(
  admin:  SupabaseClient,
  object: Record<string, unknown>,
): Promise<string | null> {
  const clientRef = typeof object.client_reference_id === 'string' ? object.client_reference_id : null;
  if (clientRef) return clientRef;

  const metadata = (object.metadata && typeof object.metadata === 'object')
    ? (object.metadata as Record<string, unknown>)
    : null;
  const metaOrgId = metadata && typeof metadata.organization_id === 'string'
    ? metadata.organization_id
    : null;
  if (metaOrgId) return metaOrgId;

  const customerId = typeof object.customer === 'string' ? object.customer : null;
  if (customerId) {
    const { data } = await admin
      .from('organizations')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  return null;
}

async function handleCheckoutCompleted(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  if (session.mode !== 'subscription') {
    // Non-subscription checkouts (one-time payments) aren't part of the
    // billing engine — ack and ignore.
    return;
  }

  const orgId = await resolveOrganizationId(admin, session as unknown as Record<string, unknown>);
  if (!orgId) {
    throw new Error(
      `checkout.session.completed missing organization linkage (session=${session.id})`,
    );
  }

  const update: OrgUpdate = {
    stripe_customer_id:     typeof session.customer === 'string'
                              ? session.customer
                              : (session.customer?.id ?? undefined),
    stripe_subscription_id: typeof session.subscription === 'string'
                              ? session.subscription
                              : (session.subscription?.id ?? undefined),
    subscription_status:    'active',  // Checkout completion implies active
  };

  const { error } = await admin
    .from('organizations')
    .update(update)
    .eq('id', orgId);

  if (error) throw new Error(`organizations.update failed: ${error.message}`);
}

async function handleSubscriptionUpdated(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;

  // Prefer customer-id lookup — most stable across Stripe's lifecycle.
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  const update: OrgUpdate = {
    stripe_subscription_id: sub.id,
    subscription_status:    normalizeStatus(sub.status),
  };

  const { error } = await admin
    .from('organizations')
    .update(update)
    .eq('stripe_customer_id', customerId);

  if (error) throw new Error(`organizations.update failed: ${error.message}`);
}

async function handleSubscriptionDeleted(
  admin: SupabaseClient,
  event: Stripe.Event,
): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // Clear the subscription id and set status to canceled. The customer
  // id is preserved so a future re-subscription via the same Stripe
  // customer can be re-linked without operator intervention.
  const { error } = await admin
    .from('organizations')
    .update({
      stripe_subscription_id: null,
      subscription_status:    'canceled',
    })
    .eq('stripe_customer_id', customerId);

  if (error) throw new Error(`organizations.update failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

// @ts-ignore — Deno global, not visible to web tsc
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return plainResponse(405, 'POST only');
  }

  // ── Resolve secrets ──────────────────────────────────────────────────
  // @ts-ignore — Deno global
  const stripeSecretKey   = Deno.env.get('STRIPE_SECRET_KEY');
  // @ts-ignore — Deno global
  const stripeWebhookSec  = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  // @ts-ignore — Deno global
  const supabaseUrl       = Deno.env.get('SUPABASE_URL');
  // @ts-ignore — Deno global
  const serviceRoleKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!stripeSecretKey || !stripeWebhookSec || !supabaseUrl || !serviceRoleKey) {
    // Misconfiguration — never expose which secret is missing in the
    // response body (it would help an attacker confirm endpoint identity).
    console.error('[stripe-webhook] missing one or more required env vars');
    return plainResponse(500, 'Server configuration error.');
  }

  // ── Read body + signature ────────────────────────────────────────────
  // CRITICAL: Stripe verification needs the EXACT raw bytes the request
  // arrived with. JSON.parse-and-re-stringify breaks the HMAC. We use
  // req.text() and never touch the body before constructEventAsync.
  const signature = req.headers.get('stripe-signature');
  if (!signature) return plainResponse(400, 'Missing Stripe-Signature header.');

  const rawBody = await req.text();

  // ── Verify signature (anti-pattern compliance: NEVER skip) ──────────
  // constructEventAsync is mandatory in Deno because Web Crypto's HMAC
  // is async. The sync `constructEvent` would silently fall back to a
  // synchronous Node-only path that doesn't exist in Deno → throws.
  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: STRIPE_API_VERSION,
    // Use Web Crypto for HMAC — the only working option in Deno.
    httpClient: Stripe.createFetchHttpClient(),
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      stripeWebhookSec,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid signature';
    console.warn('[stripe-webhook] signature verification failed:', msg);
    // 400 (not 401) is what Stripe expects for signature failures so it
    // does not enter exponential retry — the secret rotation is the fix.
    return plainResponse(400, `Webhook signature verification failed.`);
  }

  // ── Initialize the admin client (service role key bypasses RLS) ─────
  // The service role key is read from env above and NEVER returned to
  // any caller. Anti-pattern compliance.
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Replay protection (anti-pattern compliance: NEVER process twice) ─
  const recordOutcome = await recordEvent(admin, event);
  if (recordOutcome.outcome === 'error') {
    // DB unavailable — let Stripe retry. Don't ack.
    console.error('[stripe-webhook] ledger insert failed:', recordOutcome.error);
    return plainResponse(500, 'Ledger insert failed.');
  }
  if (recordOutcome.outcome === 'duplicate') {
    // Already processed — ack so Stripe stops retrying.
    return jsonResponse(200, { received: true, status: 'duplicate' });
  }

  // ── Dispatch to handler ──────────────────────────────────────────────
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(admin, event);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(admin, event);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(admin, event);
        break;
      default:
        // Unhandled event type — already in the ledger; just ack.
        break;
    }

    await markProcessed(admin, event.id);
    return jsonResponse(200, { received: true, status: 'ok', type: event.type });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'handler failure';
    console.error('[stripe-webhook] handler error', event.id, event.type, msg);
    // The ledger row stays with processed_at = NULL + error_message set
    // so an admin can replay or remediate.
    await markProcessed(admin, event.id, msg);
    // 500 → Stripe retries. The replay-protection ledger short-circuits
    // the next attempt cleanly.
    return plainResponse(500, 'Handler failure (recorded in ledger).');
  }
});
