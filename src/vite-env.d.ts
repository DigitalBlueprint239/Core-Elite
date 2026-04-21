/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL:         string
  readonly VITE_SUPABASE_ANON_KEY:    string
  /**
   * Secret used to authenticate calls to the generate-verified-export Edge Function.
   * Must match the VERIFICATION_SECRET stored in Supabase Edge Function secrets.
   * Admin-only: never expose this value to non-admin users.
   */
  readonly VITE_VERIFICATION_SECRET?: string

  // ── Stripe Price IDs (from Stripe Dashboard → Products) ──────────────────
  readonly VITE_STRIPE_PRICE_COMBINE?:      string  // $49 one-time
  readonly VITE_STRIPE_PRICE_ATHLETE_PRO?:  string  // $14.99/mo recurring
  readonly VITE_STRIPE_PRICE_ENTERPRISE?:   string  // $36,000/yr recurring

  // ── Stripe Payment Links (pre-built checkout URLs, no server required) ───
  readonly VITE_STRIPE_LINK_COMBINE?:       string
  readonly VITE_STRIPE_LINK_ATHLETE_PRO?:   string
  readonly VITE_STRIPE_LINK_ENTERPRISE?:    string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
