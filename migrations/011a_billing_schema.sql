-- =============================================================================
-- MIGRATION 011a: Billing schema — Stripe subscription columns + replay table
-- Core Elite Combine 2026 · Mission "Stripe Webhook Engine"
-- =============================================================================
--
-- FILENAME NOTE: spec asked for `migrations/011_billing_schema.sql` but slot
-- `011_rate_limiting.sql` was already taken. Using `011a` preserves
-- lexical-order sequential application, matching 007a / 008a / 009a / 010a
-- in earlier missions.
--
-- WHY this exists:
--   The Stripe webhook handler in `supabase/functions/stripe-webhook` is
--   the company's revenue ingest. To process subscription lifecycle
--   events idempotently and atomically, the database needs:
--     1. Three columns on `organizations` linking each tenant to their
--        Stripe customer + active subscription, plus a typed status
--        enum so the application can branch on lifecycle state.
--     2. A small append-only replay-protection table that lets the
--        webhook reject duplicate event deliveries via a primary-key
--        constraint instead of via application-side dedup logic
--        (which would have a TOCTOU race at scale).
--
-- WHAT this does:
--   1. Adds organizations.stripe_customer_id      TEXT (UNIQUE).
--   2. Adds organizations.stripe_subscription_id  TEXT (UNIQUE).
--   3. Adds organizations.subscription_status     TEXT NOT NULL DEFAULT 'inactive'
--      with CHECK domain matching Stripe's subscription.status enum.
--   4. Indexes both customer + subscription IDs for the webhook's
--      lookup-by-customer / lookup-by-subscription paths.
--   5. Creates `stripe_webhook_events` (event_id PRIMARY KEY) — the
--      webhook INSERTs each event_id atomically and treats a unique-
--      violation as "already processed; ack with 200." This eliminates
--      replay attacks and double-processing across retries.
--
-- IDEMPOTENCY: every statement is `IF NOT EXISTS` / `IF EXISTS` /
-- `CREATE OR REPLACE` / DROP-then-CREATE. Re-running this migration after
-- a successful first apply is a clean no-op.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Stripe linkage columns on organizations
-- ---------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'inactive';

-- ---------------------------------------------------------------------------
-- 2. UNIQUE constraints on the foreign-system identifiers
-- ---------------------------------------------------------------------------
--
-- Two different organizations cannot share a Stripe customer / subscription —
-- if Stripe ever sends the same customer.id for two distinct orgs, that's a
-- data error we want loud rather than silent. UNIQUE indexes also serve as
-- the lookup index for the webhook's `WHERE stripe_customer_id = $1` path.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_stripe_customer_id_key'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_stripe_customer_id_key UNIQUE (stripe_customer_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_stripe_subscription_id_key'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_stripe_subscription_id_key UNIQUE (stripe_subscription_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. CHECK constraint on subscription_status
-- ---------------------------------------------------------------------------
--
-- Mirrors Stripe's `Subscription.status` enum verbatim plus an `inactive`
-- bootstrap value for orgs that have never started a subscription. If
-- Stripe adds a new status, the webhook will hit this CHECK and fail
-- loudly — preferable to silent storage of an unknown lifecycle state.

ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_subscription_status_check;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_subscription_status_check
  CHECK (subscription_status IN (
    'inactive',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'paused'
  ));

-- ---------------------------------------------------------------------------
-- 4. Documentation
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN organizations.stripe_customer_id IS
  'Stripe customer.id for this org. Set on checkout.session.completed. ' ||
  'UNIQUE — one Stripe customer maps to exactly one Core Elite org.';
COMMENT ON COLUMN organizations.stripe_subscription_id IS
  'Active Stripe subscription.id. Set on checkout.session.completed and ' ||
  'updated on customer.subscription.updated. Cleared on .deleted.';
COMMENT ON COLUMN organizations.subscription_status IS
  'Mirror of Stripe Subscription.status. Source of truth for feature ' ||
  'gating in the application layer.';

-- ---------------------------------------------------------------------------
-- 5. stripe_webhook_events — replay-protection ledger
-- ---------------------------------------------------------------------------
--
-- The webhook INSERTs each Stripe event.id here BEFORE doing any side-
-- effecting work. A unique-violation on the PK means we have already
-- processed this event — the webhook returns 200 OK without re-running
-- the side effects. This is atomically race-free; even if Stripe's
-- retries land in parallel HTTP workers, exactly one INSERT will succeed.
--
-- Append-only: the table is never UPDATEd or DELETEd by the webhook.
-- A nightly cleanup job can prune events older than 30 days
-- (Stripe's max retry window) — out of scope here.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id        TEXT        PRIMARY KEY,
  event_type      TEXT        NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  -- payload preserved for forensics + replay if a handler bug requires
  -- re-processing under controlled conditions.
  payload         JSONB       NOT NULL,
  -- Set when handler completes; null when handler threw mid-processing.
  -- A non-null received_at + null processed_at row is a "stuck" event
  -- worth investigating.
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
  ON stripe_webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_unprocessed
  ON stripe_webhook_events (received_at DESC)
  WHERE processed_at IS NULL;

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Admin-only read; no direct INSERT/UPDATE policy — writes flow through
-- the webhook function under SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.
DROP POLICY IF EXISTS "stripe_webhook_events_admin_select" ON stripe_webhook_events;
CREATE POLICY "stripe_webhook_events_admin_select"
  ON stripe_webhook_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

COMMENT ON TABLE stripe_webhook_events IS
  'Mission "Stripe Webhook Engine": replay-protection ledger. Webhook ' ||
  'INSERTs each event.id atomically before side-effecting work; a ' ||
  'unique-violation means "already processed, ack with 200." Append-only.';

COMMIT;
