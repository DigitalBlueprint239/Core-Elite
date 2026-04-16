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
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
