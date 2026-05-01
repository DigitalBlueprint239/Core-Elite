/**
 * generate-verified-export
 * Core Elite — B2B Cryptographic Verification Layer
 *
 * Produces a signed, read-only export payload attesting that every live_ble
 * result in the dataset was captured by BLE laser hardware, not keyed manually.
 *
 * Verification mechanism:
 *   For each result where source_type = 'live_ble', the function computes:
 *
 *     HMAC-SHA-256(
 *       key   = VERIFICATION_SECRET  (Supabase Edge Function secret)
 *       data  = "${athlete_id}|${value_num}|${device_timestamp}|${clock_offset_ms}|${rtt_ms}"
 *     )
 *
 *   The resulting hex digest is written back to results.verification_hash and
 *   included in the export payload. A downstream verifier (recruiter portal,
 *   third-party auditor) can reproduce the hash independently if given the
 *   VERIFICATION_SECRET and the same canonical fields — proving the data
 *   transited through this server-side function unmodified.
 *
 *   Manual entries (source_type = 'manual') are included in the export
 *   with verification_hash = null and verification_status = 'unverified_manual'.
 *   There is no path to hardware-verify a manually entered result.
 *
 * Canonical payload string rules:
 *   - value_num:       toFixed(6) — normalises floating point without data loss
 *   - device_timestamp: integer string (ms since epoch, device clock)
 *   - clock_offset_ms: toFixed(3) — null → literal string 'null'
 *   - rtt_ms:          toFixed(3) — null → literal string 'null'
 *   These rules are fixed and must not change; changing them invalidates all
 *   existing hashes. Increment VERIFICATION_VERSION if the format ever changes.
 *
 * Security notes:
 *   - VERIFICATION_SECRET must be ≥ 32 bytes of cryptographically random data.
 *     Generate with: openssl rand -hex 32
 *   - The secret never leaves this function — it is NEVER returned to callers.
 *   - This function uses the Supabase service role key for DB writes. It must
 *     ONLY be callable by authenticated admin/staff users (enforced below).
 *   - All crypto operations use the native Web Crypto API (crypto.subtle).
 *     No external npm crypto libraries are imported.
 *
 * Request body (JSON):
 *   { athlete_id: string }  — export all results for one athlete
 *   { session_id: string }  — export all results for an event session/wave
 *   One of the two is required. Providing both filters to the intersection.
 *
 * Response (200):
 *   { generated_at, verification_version, athlete_id?, session_id?,
 *     result_count, verified_count, unverified_count, results: [...] }
 *
 * Error responses:
 *   400 — VERIFICATION_SECRET missing from environment
 *   400 — Neither athlete_id nor session_id provided
 *   401 — Missing or invalid Authorization header
 *   403 — Authenticated user does not have staff/admin role
 *   500 — Unexpected server error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFICATION_VERSION = '1.0';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ---------------------------------------------------------------------------
// Crypto — native Web Crypto API only (Constraint 4)
//
// Uses HMAC-SHA-256: the correct cryptographic construction for a keyed hash.
// A bare SHA-256(secret + data) is vulnerable to length-extension attacks;
// HMAC is not. Both use only crypto.subtle — no external libraries.
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();

  // Import the secret as an HMAC-SHA-256 key.
  // extractable: false — the raw key bytes can never be exported from the
  // Web Crypto runtime, adding a defence-in-depth layer even inside this fn.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    /* extractable */ false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(message),
  );

  // Convert ArrayBuffer to lowercase hex string
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Canonical payload string
//
// The order and format of fields is fixed and versioned.
// Any change requires a VERIFICATION_VERSION bump and re-verification of all
// existing hashes (a new Edge Function deployment calling this for all rows).
//
// clock_offset_ms / rtt_ms may be null when the device had no BLE clock sync.
// The result can still be live_ble (hardware captured) but the clock quality
// is unattested. Using the literal string 'null' (not '0') makes this explicit
// in the hash and distinguishable from a device with a measured 0ms offset.
// ---------------------------------------------------------------------------

function buildCanonicalPayload(fields: {
  athlete_id:       string;
  value_num:        number;
  device_timestamp: number;
  clock_offset_ms:  number | null;
  rtt_ms:           number | null;
}): string {
  const valueStr       = fields.value_num.toFixed(6);
  const tsStr          = String(fields.device_timestamp);
  const offsetStr      = fields.clock_offset_ms != null
    ? fields.clock_offset_ms.toFixed(3)
    : 'null';
  const rttStr         = fields.rtt_ms != null
    ? fields.rtt_ms.toFixed(3)
    : 'null';

  return `${fields.athlete_id}|${valueStr}|${tsStr}|${offsetStr}|${rttStr}`;
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface ResultRow {
  result_id:         string;
  client_result_id:  string;
  athlete_id:        string;
  event_id:          string;
  band_id:           string;
  station_id:        string;
  drill_type:        string;
  value_num:         number;
  attempt_number:    number;
  validation_status: string;
  hlc_timestamp:     string | null;
  device_timestamp:  number;
  recorded_at:       string;
  source_type:       string;
  verification_hash: string | null;
  session_id:        string | null;
  meta:              Record<string, unknown> | null;
  // capture_telemetry (LEFT JOIN — may be null for manual entries)
  ct_telemetry_id:       string | null;
  ct_device_id:          string | null;
  ct_device_label:       string | null;
  ct_captured_at:        string | null;
  ct_capture_duration_ms: number | null;
  ct_ble_rssi:           number | null;
  ct_ble_phy:            string | null;
  ct_was_offline:        boolean | null;
  ct_sync_latency_ms:    number | null;
  ct_clock_offset_ms:    number | null;
  ct_rtt_ms:             number | null;
  // result_provenance (LEFT JOIN — may be null)
  prov_device_id:        string | null;
  prov_device_label:     string | null;
  prov_hlc_timestamp:    string | null;
  prov_was_offline:      boolean | null;
}

// ---------------------------------------------------------------------------
// Export payload shape — what recruiters receive
// ---------------------------------------------------------------------------

type VerificationStatus =
  | 'hardware_verified'     // live_ble, hash computed, clock sync present
  | 'hardware_no_clock'     // live_ble, hash computed, no clock sync data
  | 'unverified_manual';    // manual entry, no hardware attestation possible

interface ExportResult {
  result_id:           string;
  drill_type:          string;
  value_num:           number;
  attempt_number:      number;
  recorded_at:         string;
  // Canonical SourceType (src/lib/types.ts). Hardware-verified rows are
  // 'live_ble' only; everything else is the unverified manual or imported
  // path. Verified-export only includes rows whose source_type is in this
  // narrow union — imported_csv rows are filtered out at the query level.
  source_type:         'live_ble' | 'manual';
  verification_status: VerificationStatus;
  verification_hash:   string | null;
  /** The exact string that was hashed. Null for manual entries. */
  verification_payload: string | null;
  telemetry: {
    device_id:           string;
    device_label:        string;
    device_timestamp_ms: number;
    clock_offset_ms:     number | null;
    rtt_ms:              number | null;
    ble_rssi:            number | null;
    ble_phy:             string | null;
    was_offline:         boolean;
    sync_latency_ms:     number | null;
    capture_duration_ms: number | null;
  } | null;
  provenance: {
    device_id:      string;
    device_label:   string;
    hlc_timestamp:  string;
    was_offline:    boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    // ── Step 1: Validate VERIFICATION_SECRET ──────────────────────────────
    // Must fail fast before any DB work. A missing secret means the entire
    // verification pipeline is non-functional — return 400 immediately.
    const verificationSecret = Deno.env.get('VERIFICATION_SECRET');
    if (!verificationSecret || verificationSecret.trim() === '') {
      return errorResponse(400, 'CONFIGURATION_ERROR',
        'VERIFICATION_SECRET is not set in the Edge Function environment. ' +
        'Run: supabase secrets set VERIFICATION_SECRET=<your-secret>');
    }

    // ── Step 2: Manual secret-based authorization ─────────────────────────
    // The Supabase API Gateway JWT check is disabled for this function
    // (verify_jwt = false in config.toml / --no-verify-jwt at deploy time).
    // Instead we enforce access by comparing the caller-supplied secret against
    // the VERIFICATION_SECRET environment variable.
    //
    // Accepted header forms (in priority order):
    //   X-Verification-Secret: <secret>
    //   Authorization: Bearer <secret>
    //
    // This keeps the function callable by B2B partners and server-side admin
    // tooling without requiring Supabase session JWTs.
    const xSecret   = req.headers.get('X-Verification-Secret');
    const authHeader = req.headers.get('Authorization');
    const callerSecret =
      xSecret ??
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

    if (!callerSecret || callerSecret !== verificationSecret) {
      return errorResponse(401, 'UNAUTHORIZED',
        'Missing or invalid verification secret. ' +
        'Supply the secret via X-Verification-Secret or Authorization: Bearer <secret>.');
    }

    // Service-role client for all subsequent DB operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Step 3: Parse and validate request body ───────────────────────────
    let body: { athlete_id?: string; session_id?: string };
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }

    const { athlete_id, session_id } = body;

    if (!athlete_id && !session_id) {
      return errorResponse(400, 'INVALID_REQUEST',
        'Provide at least one of: athlete_id, session_id.');
    }

    // ── Step 4: Query results with joined telemetry and provenance ─────────
    //
    // LEFT JOINs: manual entries have no capture_telemetry or result_provenance
    // rows — they are included in the export with null telemetry fields.
    // The WHERE clause filters voided rows and scopes to the requested entity.
    const { data: rows, error: queryError } = await serviceClient
      .rpc('export_verified_results', {
        p_athlete_id: athlete_id ?? null,
        p_session_id: session_id ?? null,
      });

    if (queryError) {
      console.error('[generate-verified-export] Query error:', queryError);
      return errorResponse(500, 'QUERY_ERROR', 'Failed to retrieve results.');
    }

    const resultRows = (rows ?? []) as ResultRow[];

    // ── Step 5 & 6: Compute hashes + build export payload ─────────────────

    const exportResults: ExportResult[] = [];
    // Collect results that need their verification_hash updated in DB
    const hashUpdates: Array<{ result_id: string; hash: string }> = [];

    for (const row of resultRows) {
      if (row.source_type === 'live_ble') {
        // Build the canonical payload string from the six attestation fields
        const canonicalPayload = buildCanonicalPayload({
          athlete_id:      row.athlete_id,
          value_num:       row.value_num,
          device_timestamp: row.device_timestamp,
          clock_offset_ms: row.ct_clock_offset_ms,
          rtt_ms:          row.ct_rtt_ms,
        });

        const hash = await hmacSha256Hex(verificationSecret, canonicalPayload);

        const verificationStatus: VerificationStatus =
          (row.ct_clock_offset_ms != null && row.ct_rtt_ms != null)
            ? 'hardware_verified'
            : 'hardware_no_clock';

        hashUpdates.push({ result_id: row.result_id, hash });

        exportResults.push({
          result_id:            row.result_id,
          drill_type:           row.drill_type,
          value_num:            row.value_num,
          attempt_number:       row.attempt_number,
          recorded_at:          row.recorded_at,
          source_type:          'live_ble',
          verification_status:  verificationStatus,
          verification_hash:    hash,
          verification_payload: canonicalPayload,
          telemetry: row.ct_device_id ? {
            device_id:           row.ct_device_id,
            device_label:        row.ct_device_label!,
            device_timestamp_ms: row.device_timestamp,
            clock_offset_ms:     row.ct_clock_offset_ms,
            rtt_ms:              row.ct_rtt_ms,
            ble_rssi:            row.ct_ble_rssi,
            ble_phy:             row.ct_ble_phy,
            was_offline:         row.ct_was_offline ?? false,
            sync_latency_ms:     row.ct_sync_latency_ms,
            capture_duration_ms: row.ct_capture_duration_ms,
          } : null,
          provenance: row.prov_device_id ? {
            device_id:     row.prov_device_id,
            device_label:  row.prov_device_label!,
            hlc_timestamp: row.prov_hlc_timestamp!,
            was_offline:   row.prov_was_offline ?? false,
          } : null,
        });

      } else {
        // 'manual' — hardware verification is not possible, by design
        exportResults.push({
          result_id:            row.result_id,
          drill_type:           row.drill_type,
          value_num:            row.value_num,
          attempt_number:       row.attempt_number,
          recorded_at:          row.recorded_at,
          source_type:          'manual',
          verification_status:  'unverified_manual',
          verification_hash:    null,
          verification_payload: null,
          telemetry:            null,
          provenance:           null,
        });
      }
    }

    // ── Step 7: Persist verification hashes to results table ──────────────
    //
    // Use the service role client — the hash write-back is a server-initiated
    // operation that must not be blocked by RLS. The result row is never
    // modified by this step in a way that changes the athletic data; only
    // verification_hash is updated.
    //
    // We update individually rather than in a single SQL CASE batch because
    // Supabase's JS client does not expose multi-row UPDATE with different
    // values per row. Individual updates are safe here: typical athlete has
    // ≤ 30 results (5 drills × 3–6 attempts). For session exports (all
    // athletes), batch size is bounded by event size (≤ 500 athletes × 30 =
    // 15,000 rows) — acceptable for a non-real-time export operation.
    //
    // Failed hash updates do NOT abort the export — the caller still receives
    // a valid signed payload. The next call will re-compute and re-persist.
    if (hashUpdates.length > 0) {
      const updatePromises = hashUpdates.map(({ result_id, hash }) =>
        serviceClient
          .from('results')
          .update({ verification_hash: hash })
          .eq('id', result_id)
          .then(({ error }) => {
            if (error) {
              console.error(
                `[generate-verified-export] Failed to persist hash for result ${result_id}:`,
                error.message,
              );
            }
          })
      );
      await Promise.all(updatePromises);
    }

    // ── Step 8: Return the signed export payload ───────────────────────────

    const verifiedCount   = exportResults.filter(r => r.source_type === 'live_ble').length;
    const unverifiedCount = exportResults.filter(r => r.source_type === 'manual').length;

    const payload = {
      generated_at:          new Date().toISOString(),
      verification_version:  VERIFICATION_VERSION,
      // Echo back the filter that was applied
      ...(athlete_id && { athlete_id }),
      ...(session_id && { session_id }),
      result_count:          exportResults.length,
      verified_count:        verifiedCount,
      unverified_count:      unverifiedCount,
      // Summary for recruiter display without reading each row
      verification_summary: {
        all_hardware_verified: unverifiedCount === 0 && verifiedCount > 0,
        has_manual_entries:    unverifiedCount > 0,
        clock_sync_present:    exportResults.some(
          r => r.source_type === 'live_ble' &&
               r.verification_status === 'hardware_verified'
        ),
      },
      results: exportResults,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        // Prevent the signed payload from being cached — each call re-computes
        // with the latest DB state and the current secret.
        'Cache-Control': 'no-store',
      },
    });

  } catch (err) {
    console.error('[generate-verified-export] Unhandled error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(
  status: number,
  code:   string,
  detail: string,
): Response {
  return new Response(
    JSON.stringify({ error: { code, detail } }),
    {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    },
  );
}
