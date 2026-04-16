/**
 * process-vendor-import
 * Core Elite — Phase 3: Historical Data Import Pipeline
 *
 * Accepts a JSON payload of pre-parsed legacy CSV records and bulk-inserts
 * them into the results table with source_type = 'legacy_csv'.
 *
 * Security:
 *   JWT gateway verification is disabled (verify_jwt = false in config.toml)
 *   to avoid the 401 gateway issue. The function performs its own JWT
 *   validation and enforces admin-only access.
 *
 * Idempotency:
 *   client_result_id is a deterministic UUID derived from the canonical
 *   record fields. Importing the same CSV twice will hit the UNIQUE
 *   constraint and be counted as 'skipped' rather than errored.
 *
 * Realtime isolation:
 *   Rows inserted with source_type = 'legacy_csv' are excluded from live
 *   dashboard subscriptions via a Realtime filter. This function does not
 *   suppress the Postgres publication directly — that filtering is done
 *   on the subscriber side (LiveCommandCenter: source_type=neq.legacy_csv).
 *
 * Request body (JSON):
 *   {
 *     event_id:              string (UUID) — required
 *     records:               ImportRecord[] — max 5,000 per call
 *     historical_timestamp?: string (ISO 8601) — used as default recorded_at
 *   }
 *
 * ImportRecord:
 *   {
 *     drill_type:      string — required
 *     value_num:       number — required
 *     athlete_id?:     string (UUID) — direct ref; takes precedence over name
 *     first_name?:     string — used with last_name when athlete_id absent
 *     last_name?:      string
 *     recorded_at?:    string (ISO 8601)
 *     attempt_number?: number (default 1)
 *     notes?:          string → meta.notes
 *     position?:       string — used when creating a new athlete record
 *   }
 *
 * Response (200):
 *   { inserted, skipped, failed, total, new_athletes, errors[0..49] }
 *
 * Error responses:
 *   400 — Bad request / missing required fields
 *   401 — Missing or invalid JWT
 *   403 — Caller does not have admin role
 *   404 — event_id not found
 *   500 — Unexpected server error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImportRecord {
  athlete_id?:     string;
  first_name?:     string;
  last_name?:      string;
  drill_type:      string;
  value_num:       number | string;
  recorded_at?:    string;
  attempt_number?: number | string;
  notes?:          string;
  position?:       string;
}

interface ImportPayload {
  event_id:              string;
  records:               ImportRecord[];
  historical_timestamp?: string;
}

interface RowError {
  row:    number;
  reason: string;
}

interface ResolvedRecord {
  rowIndex:     number;
  athleteId:    string | null;
  isNew:        boolean;
  newFirst?:    string;
  newLast?:     string;
  newPosition?: string;
  drillType:    string;
  valueNum:     number;
  recordedAt?:  string;
  attemptNum:   number;
  notes?:       string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CHUNK_SIZE   = 50;    // rows per INSERT batch
const MAX_RECORDS  = 5_000; // safety cap per request

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derives a deterministic RFC 4122 v4-format UUID from a seed string.
 * Version and variant bits are set so tooling treats it as a valid v4 UUID.
 * Used for client_result_id so re-imports are idempotent.
 */
async function deterministicUUID(seed: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(seed));
  const bytes   = new Uint8Array(hashBuf).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function errorResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ error: { code, detail } }),
    { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    // ── Step 1: Validate caller JWT + assert admin role ───────────────────
    //
    // verify_jwt = false in config.toml bypasses the Supabase gateway check.
    // We re-validate manually here so only authenticated admins can import.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return errorResponse(401, 'UNAUTHORIZED', 'Missing Authorization header.');
    }

    const anonClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return errorResponse(401, 'UNAUTHORIZED', 'Invalid or expired session token.');
    }

    // Service-role client for all DB writes — bypasses RLS
    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: profile } = await svc
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Admin role is required to perform legacy imports.');
    }

    // ── Step 2: Parse and validate request body ───────────────────────────
    let body: ImportPayload;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }

    const { event_id, records, historical_timestamp } = body;

    if (!event_id || typeof event_id !== 'string') {
      return errorResponse(400, 'INVALID_REQUEST', 'event_id (UUID) is required.');
    }
    if (!Array.isArray(records) || records.length === 0) {
      return errorResponse(400, 'INVALID_REQUEST', 'records must be a non-empty array.');
    }
    if (records.length > MAX_RECORDS) {
      return errorResponse(
        400, 'INVALID_REQUEST',
        `Maximum ${MAX_RECORDS.toLocaleString()} records per request. ` +
        `Received ${records.length}. Split into multiple requests.`,
      );
    }

    // ── Step 3: Verify event exists ───────────────────────────────────────
    const { data: event, error: eventErr } = await svc
      .from('events')
      .select('id, name')
      .eq('id', event_id)
      .single();

    if (eventErr || !event) {
      return errorResponse(404, 'NOT_FOUND', `Event ${event_id} not found.`);
    }

    // ── Step 4: Upsert synthetic import station ───────────────────────────
    //
    // The results table requires a valid station_id FK. We create one
    // synthetic "Legacy Import" station per event — disabled and excluded
    // from normal station routing.
    const importStationId = `IMPORT_${event_id}`;
    await svc.from('stations').upsert(
      {
        id:            importStationId,
        event_id:      event_id,
        name:          'Legacy Import',
        drill_type:    'legacy',
        enabled:       false,
        requires_auth: false,
      },
      { onConflict: 'id' },
    );

    // ── Step 5: Upsert synthetic import band ─────────────────────────────
    //
    // band_id is NOT NULL in results. The synthetic band uses display_number
    // 0 (reserved; real bands start at 1) and is keyed by event so the
    // UNIQUE(event_id, display_number) constraint is satisfied across events.
    const importBandId = `IMPORT_${event_id}`;
    await svc.from('bands').upsert(
      {
        band_id:        importBandId,
        event_id:       event_id,
        display_number: 0,
        status:         'available',
      },
      { onConflict: 'band_id' },
    );

    // ── Step 6: Bulk-load existing athletes for name-based lookup ─────────
    const { data: existingAthletes } = await svc
      .from('athletes')
      .select('id, first_name, last_name')
      .eq('event_id', event_id);

    const athleteByName = new Map<string, string>(); // 'first|last' → uuid
    const athleteIdSet  = new Set<string>();

    for (const a of (existingAthletes ?? [])) {
      const key = `${a.first_name.toLowerCase().trim()}|${a.last_name.toLowerCase().trim()}`;
      athleteByName.set(key, a.id);
      athleteIdSet.add(a.id);
    }

    // ── Step 7: First pass — validate + resolve athlete references ────────
    const importTimestamp = historical_timestamp
      ? new Date(historical_timestamp).getTime()
      : Date.now();

    const errors: RowError[]           = [];
    const resolved: ResolvedRecord[]   = [];
    const newAthleteKeys = new Set<string>();

    for (let i = 0; i < records.length; i++) {
      const r      = records[i];
      const rowNum = i + 1;

      // ── Validate drill_type ──────────────────────────────────────────
      if (!r.drill_type || typeof r.drill_type !== 'string' || r.drill_type.trim() === '') {
        errors.push({ row: rowNum, reason: 'drill_type is required' });
        continue;
      }

      // ── Validate value_num ───────────────────────────────────────────
      const rawVal = r.value_num;
      const val    = typeof rawVal === 'string' ? parseFloat(rawVal) : Number(rawVal);
      if (!Number.isFinite(val)) {
        errors.push({ row: rowNum, reason: `value_num "${rawVal}" is not a valid number` });
        continue;
      }

      // ── Validate attempt_number ──────────────────────────────────────
      const rawAttempt   = r.attempt_number;
      const attemptNum   = rawAttempt != null ? parseInt(String(rawAttempt), 10) : 1;
      if (!Number.isInteger(attemptNum) || attemptNum < 1) {
        errors.push({ row: rowNum, reason: `attempt_number "${rawAttempt}" must be a positive integer` });
        continue;
      }

      // ── Resolve athlete identity ─────────────────────────────────────
      let athleteId: string | null = null;
      let isNew                    = false;
      let newFirst: string | undefined;
      let newLast:  string | undefined;
      let newPos:   string | undefined;

      if (r.athlete_id) {
        // Direct UUID reference — athlete must exist in this event
        if (!athleteIdSet.has(r.athlete_id)) {
          errors.push({ row: rowNum, reason: `athlete_id ${r.athlete_id} not found in event` });
          continue;
        }
        athleteId = r.athlete_id;

      } else if (r.first_name && r.last_name) {
        const nameKey = `${r.first_name.toLowerCase().trim()}|${r.last_name.toLowerCase().trim()}`;
        if (athleteByName.has(nameKey)) {
          athleteId = athleteByName.get(nameKey)!;
        } else {
          // New athlete — queue for batch creation
          isNew      = true;
          newFirst   = r.first_name.trim();
          newLast    = r.last_name.trim();
          newPos     = r.position?.trim();
          newAthleteKeys.add(nameKey);
          // athleteId filled in after batch creation
        }
      } else {
        errors.push({
          row: rowNum,
          reason: 'Provide athlete_id (UUID) OR both first_name and last_name',
        });
        continue;
      }

      resolved.push({
        rowIndex:   i,
        athleteId,
        isNew,
        newFirst,
        newLast,
        newPosition: newPos,
        drillType:  r.drill_type.trim(),
        valueNum:   val,
        recordedAt: r.recorded_at,
        attemptNum,
        notes:      r.notes,
      });
    }

    // ── Step 8: Batch-create new athletes ─────────────────────────────────
    //
    // parent_name / parent_email / parent_phone are NOT NULL in the schema.
    // Placeholder values mark these as legacy-import records.
    let newAthleteCount = 0;

    if (newAthleteKeys.size > 0) {
      const seen    = new Set<string>();
      const toCreate: Record<string, unknown>[] = [];

      for (const r of resolved) {
        if (!r.isNew || !r.newFirst || !r.newLast) continue;
        const key = `${r.newFirst.toLowerCase()}|${r.newLast.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        toCreate.push({
          event_id:     event_id,
          first_name:   r.newFirst,
          last_name:    r.newLast,
          position:     r.newPosition ?? null,
          parent_name:  'Legacy Import',
          parent_email: 'legacy@import.local',
          parent_phone: '0000000000',
        });
      }

      const { data: created, error: createErr } = await svc
        .from('athletes')
        .insert(toCreate)
        .select('id, first_name, last_name');

      if (createErr) {
        console.error('[process-vendor-import] Athlete creation error:', createErr.message);
        // Non-fatal: rows without resolved athletes will be counted as failed
      } else {
        newAthleteCount = created?.length ?? 0;
        for (const a of (created ?? [])) {
          const key = `${a.first_name.toLowerCase()}|${a.last_name.toLowerCase()}`;
          athleteByName.set(key, a.id);
          athleteIdSet.add(a.id);
        }
      }
    }

    // ── Step 9: Fill athlete IDs for newly created athletes ───────────────
    for (const r of resolved) {
      if (r.isNew && r.newFirst && r.newLast) {
        const key = `${r.newFirst.toLowerCase()}|${r.newLast.toLowerCase()}`;
        r.athleteId = athleteByName.get(key) ?? null;
      }
    }

    // ── Step 10: Build result rows ────────────────────────────────────────
    const rowsToInsert: Record<string, unknown>[] = [];

    for (const r of resolved) {
      if (!r.athleteId) {
        errors.push({
          row:    r.rowIndex + 1,
          reason: 'Athlete could not be resolved (batch creation may have failed)',
        });
        continue;
      }

      const recordedAt = r.recordedAt
        ? new Date(r.recordedAt).toISOString()
        : new Date(importTimestamp).toISOString();

      const deviceTs = r.recordedAt
        ? new Date(r.recordedAt).getTime()
        : importTimestamp;

      // Deterministic client_result_id for idempotent re-imports
      const seed = [
        'legacy_csv', event_id, r.athleteId,
        r.drillType, r.attemptNum, r.valueNum, recordedAt,
      ].join('|');
      const clientResultId = await deterministicUUID(seed);

      rowsToInsert.push({
        client_result_id:  clientResultId,
        event_id:          event_id,
        athlete_id:        r.athleteId,
        band_id:           importBandId,
        station_id:        importStationId,
        drill_type:        r.drillType,
        value_num:         r.valueNum,
        attempt_number:    r.attemptNum,
        source_type:       'legacy_csv',
        validation_status: 'clean',
        device_timestamp:  deviceTs,
        recorded_at:       recordedAt,
        meta: {
          import_source: 'vendor_csv',
          ...(r.notes ? { notes: r.notes } : {}),
        },
      });
    }

    // ── Step 11: Chunked insert ───────────────────────────────────────────
    let inserted = 0;
    let skipped  = 0;

    for (let i = 0; i < rowsToInsert.length; i += CHUNK_SIZE) {
      const chunk = rowsToInsert.slice(i, i + CHUNK_SIZE);

      const { data: insertData, error: insertErr } = await svc
        .from('results')
        .insert(chunk)
        .select('id');

      if (insertErr) {
        if (insertErr.code === '23505') {
          // Unique constraint violation = already imported (idempotent re-run)
          skipped += chunk.length;
        } else {
          console.error(`[process-vendor-import] Chunk ${i}–${i + CHUNK_SIZE} error:`, insertErr.message);
          errors.push({
            row:    i + 1,
            reason: `Batch insert failed: ${insertErr.message}`,
          });
        }
      } else {
        inserted += insertData?.length ?? chunk.length;
      }
    }

    // ── Step 12: Return summary ───────────────────────────────────────────
    return new Response(
      JSON.stringify({
        inserted,
        skipped,
        failed:       errors.length,
        total:        records.length,
        new_athletes: newAthleteCount,
        event_name:   event.name,
        // Cap error list so the response doesn't balloon
        errors:       errors.slice(0, 50),
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );

  } catch (err) {
    console.error('[process-vendor-import] Unhandled error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
});
