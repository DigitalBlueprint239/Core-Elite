/**
 * supabase.ts
 * Core Elite — Supabase type shim
 *
 * REGENERATION:
 *   When a local Supabase instance is running (requires Docker Desktop), run:
 *
 *     npx supabase gen types typescript --local > src/types/supabase.ts
 *
 *   For a deployed project, pass the project ref instead:
 *
 *     npx supabase gen types typescript --project-id <ref> > src/types/supabase.ts
 *
 *   The CLI was unavailable at the time this file was authored (Docker not
 *   running), so this is a hand-authored shim covering only the surface
 *   that Mission S reshaped: the submit_result_secure router + adapter,
 *   failed_rpc_logs, and the versioned internal implementations.
 *
 *   The generated file will subsume this one — when you regenerate, delete
 *   everything below this comment block and let the CLI overwrite.
 */

// ---------------------------------------------------------------------------
// Minimal Database shape — covers only what the app currently imports.
// Everything else stays `unknown` rather than `any` so adding a new table
// requires a deliberate edit (or a full regeneration).
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------------------------------------------------------------------------
// submit_result_secure — router + versioned implementations
//
// Two callable surfaces exist (overloads resolved by PostgREST on argument
// names):
//
//   1. JSONB router:       submit_result_secure(p_payload: Json)
//   2. Named-param adapter: submit_result_secure(p_client_result_id: string, ...)
//
// Both return the same SubmitResultResponse JSONB. Internal versioned
// functions (_v5, _v6) are NOT exposed — REVOKE'd from PUBLIC in mig 025.
// ---------------------------------------------------------------------------

export type SubmitResultVersion = '5' | '6';

export interface SubmitResultPayloadV5 {
  client_result_id: string;
  event_id:         string;
  athlete_id:       string;
  band_id:          string;
  station_id:       string;
  drill_type:       string;
  value_num:        number;
  attempt_number?:  number;
  meta?:            Json;
  /** Explicit version pin — preferred for new clients. */
  _v?:              '5';
}

export interface SubmitResultPayloadV6 extends Omit<SubmitResultPayloadV5, '_v'> {
  device_timestamp?: number;   // BIGINT — epoch ms
  source_type?:      string;
  session_id?:       string | null;
  _v?:               '6';
}

export type SubmitResultPayload = SubmitResultPayloadV5 | SubmitResultPayloadV6;

/** Success and error shapes returned by the router. Discriminate on `code`. */
export type SubmitResultResponse =
  | { success: true;  result_id: string; status?: 'duplicate' }
  | { success: false; code: 'UNAUTHORIZED';          error: string }
  | { success: false; code: 'INTERNAL_ERROR';        error: string }
  | { success: false; code: 'INVALID_PAYLOAD';       error: string }
  | { success: false; code: 'MISSING_REQUIRED_KEYS'; error: string; missing: string[] }
  | { success: false; code: 'DEPRECATED_VERSION';    error: string; requested_version: string; supported_versions: SubmitResultVersion[] }
  | { success: false; code: 'UNKNOWN_VERSION';       error: string; requested_version: string; supported_versions: SubmitResultVersion[] }
  | {
      success:                false;
      status:                 'suspicious_duplicate';
      code:                   'SUSPICIOUS_DUPLICATE';
      existing_result_id:     string;
      existing_value:         number;
      existing_recorded_at:   string;
      existing_attempt_num:   number;
      new_value:              number;
      athlete_id:             string;
      drill_type:             string;
    };

// ---------------------------------------------------------------------------
// failed_rpc_logs — DLQ row shape
// ---------------------------------------------------------------------------

export interface FailedRpcLog {
  id:             string;
  rpc_name:       string;
  reason:
    | 'invalid_payload_type'
    | 'missing_required_keys'
    | 'deprecated_version'
    | 'unknown_version'
    | string;                     // open set — future reasons added by migrations
  raw_payload:    Json;
  error_context:  Json;
  caller_role:    string | null;
  caller_uid:     string | null;
  created_at:     string;
  reviewed_at:    string | null;
  reviewed_by:    string | null;
  resolution:     'replayed' | 'discarded' | 'client_fixed' | string | null;
}

// ---------------------------------------------------------------------------
// Database — the shape supabase-js expects when the client is constructed
// with createClient<Database>(url, key). Left as a wide open shape until
// the CLI-generated file replaces this stub.
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      failed_rpc_logs: {
        Row:    FailedRpcLog;
        Insert: Omit<FailedRpcLog, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<FailedRpcLog>;
      };
      // ... other tables fall through to the regeneration.
    };
    Functions: {
      submit_result_secure: {
        // PostgREST picks the overload based on provided argument keys.
        Args: SubmitResultPayload | {
          p_client_result_id: string;
          p_event_id:         string;
          p_athlete_id:       string;
          p_band_id:          string;
          p_station_id:       string;
          p_drill_type:       string;
          p_value_num:        number;
          p_attempt_number?:  number;
          p_meta?:            Json;
          p_device_timestamp?: number;
          p_source_type?:     string;
          p_session_id?:      string | null;
        };
        Returns: SubmitResultResponse;
      };
    };
    Enums: Record<string, never>;
  };
}
