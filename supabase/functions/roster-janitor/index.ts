/**
 * roster-janitor
 * Core Elite — Mission Z: AI Data Janitor
 *
 * Accepts a paste of raw, messy roster data (CSV, TSV, formatted Excel
 * dump, or even just space-separated text scraped from a coach's email)
 * and returns a strict, schema-validated JSON array suitable for the
 * Enterprise Importer ingestion pipeline.
 *
 * LLM contract:
 *   Provider:        Anthropic Messages API (claude-opus-4-7)
 *   Output format:   structured outputs (output_config.format =
 *                    json_schema) — server-validated, never raw text
 *   Caching:         ephemeral cache_control on the system prompt so
 *                    repeated cleanses inside the 5-minute window pay
 *                    ~10% of the cached-prefix token cost
 *   Effort:          low — short, scoped extraction; thinking off
 *
 * Auth:
 *   Caller must be a Supabase-authenticated user with role 'admin' on
 *   the `profiles` table. Same gate as generate-verified-export.
 *
 * Request body (JSON):
 *   { raw: string }    — the messy paste, max 200 KB
 *
 * Response 200 (JSON):
 *   {
 *     rows:      NormalizedRow[]
 *     warnings:  string[]            — non-fatal coercions per row
 *     usage:     { input_tokens, output_tokens, cache_read_input_tokens, ... }
 *     model:     string              — which Claude model handled this
 *   }
 *
 * Response errors:
 *   400 — payload missing/oversized, or LLM refusal
 *   401 — missing Authorization header
 *   403 — caller is not an admin
 *   500 — ANTHROPIC_API_KEY unset, or upstream Anthropic error
 *
 * Environment variables (set via `supabase secrets set`):
 *   ANTHROPIC_API_KEY  — required, from console.anthropic.com
 *   ANTHROPIC_MODEL    — optional override, defaults to claude-opus-4-7
 *
 * Local development:
 *   npx supabase functions serve roster-janitor --env-file ./.env.local
 *   curl -X POST http://localhost:54321/functions/v1/roster-janitor \
 *        -H 'authorization: Bearer <admin-jwt>' \
 *        -H 'content-type: application/json' \
 *        -d '{"raw":"Smith, John, QB, 6-2, 195, 4.6\nDoe Jane WR 5-10 175 4.5"}'
 */

// @ts-ignore — Deno-resolved npm specifier; tsc on the web client doesn't see this file.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
// @ts-ignore — Deno-resolved npm specifier.
import Anthropic from 'npm:@anthropic-ai/sdk@^0.30.0';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hard cap on the paste size — generous enough for a 1k-row roster but small
// enough that a malicious caller can't drive cost through the roof on one
// request. ~200 KB ≈ 50k input tokens worst case, well under context.
const MAX_RAW_BYTES   = 200_000;
const DEFAULT_MODEL   = 'claude-opus-4-7';
const DEFAULT_TIMEOUT = 30_000;   // ms

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// System prompt — kept verbatim and stable so the prompt cache stays warm.
//
// Render order is tools → system → messages, so a cache breakpoint on this
// string caches the whole prefix. Any byte change here invalidates every
// cached entry — DO NOT interpolate dates, request IDs, or per-call data.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a strict data normalization engine for a high school football combine platform.

You will receive ONE block of raw, messy sports roster data — pasted from email,
Excel, Google Docs, hand-typed lists, or copied from a vendor PDF. The format
varies wildly: comma- or tab-delimited, fixed-width columns, mixed delimiters,
inconsistent capitalization, swapped column orders, decorative lines, footnotes,
and frequent typos.

Your job: extract one normalized record per athlete. Discard everything that is
not athlete-row data (titles, page headers, totals, team names, coach contact
lines, blank rows, rank numbers without other content).

Fields to extract per athlete:

  first_name   string         — Title-cased. Strip trailing periods. NEVER null.
  last_name    string         — Title-cased. Hyphenated names preserved. NEVER null.
                                If a name is given as a single token (e.g. "Madonna"),
                                use it as last_name and put empty string in first_name.
  position     string | null  — Normalize to one of:
                                  QB, RB, WR, TE, OL, DL, LB, CB, S, K, P, ATH
                                Map common variants:
                                  HB/FB → RB    SE/SLOT/X/Z → WR   OT/OG/C → OL
                                  DT/DE/EDGE   → DL          ILB/OLB    → LB
                                  CORNERBACK   → CB          SAFETY     → S
                                  ATHLETE/UTL  → ATH
                                If unrecognized or missing, output null.
  height_in    integer | null — TOTAL INCHES. Convert from any of:
                                  "6-2", "6'2", "6'2\\"", "6 ft 2 in", "6.2" (= 6'2")
                                If only feet given (e.g. "6"), output 12 * feet.
                                If a decimal between 4 and 8 with no quote/foot mark
                                appears (e.g. "6.0"), treat the integer part as feet
                                and the fraction part as inches (e.g. "6.0" → 72,
                                "5.11" → 71). If parsing is ambiguous, return null
                                and add a warning.
                                Reject impossibilities: < 48 in or > 90 in → null + warning.
  weight_lb    integer | null — Pounds, integer. If kg is clearly indicated (e.g. "85 kg"),
                                multiply by 2.20462 and round.
                                Reject impossibilities: < 80 or > 450 → null + warning.
  forty        number | null  — 40-yard dash time in SECONDS, two decimal places.
                                Accept "4.6", "4.65", "4.6s", "4:65" (treat colon as
                                decimal in single-segment 40-yard times).
                                Reject impossibilities: < 4.00 (sub-world-record floor)
                                or > 9.00 → null + warning.

Output rules — these are absolute and non-negotiable:

1. Output ONLY a JSON object matching the provided schema. No prose, no markdown
   code fences, no apologies, no explanations.
2. Every athlete present in the input MUST appear in the output, in order.
   Skip ONLY non-athlete rows (decorations, totals, headers).
3. If a field is missing, ambiguous, or fails a sanity check, set it to null
   and include a one-line note in the warnings array. Format each warning as:
   "row N (Last, First): <one-line description>".
4. Never invent data. If a coach didn't list 40 times for any athlete, every
   forty value must be null and warnings should be empty for that field.
5. The warnings array must be empty if every field on every row parsed cleanly.

Begin processing now.`;

// JSON Schema for structured outputs. additionalProperties: false on every
// object is required by the structured-outputs feature.
const OUTPUT_SCHEMA = {
  type:                 'object',
  additionalProperties: false,
  required:             ['rows', 'warnings'],
  properties: {
    rows: {
      type:  'array',
      items: {
        type:                 'object',
        additionalProperties: false,
        required:             ['first_name', 'last_name', 'position', 'height_in', 'weight_lb', 'forty'],
        properties: {
          first_name: { type: 'string' },
          last_name:  { type: 'string' },
          position:   { anyOf: [{ type: 'string' }, { type: 'null' }] },
          height_in:  { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          weight_lb:  { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          forty:      { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
    },
    warnings: {
      type:  'array',
      items: { type: 'string' },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Auth gate — same shape as generate-verified-export
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string;
  role:   string;
}

async function authenticateAdmin(req: Request): Promise<AuthContext | Response> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization header' });
  }

  const supabase = createClient(
    // @ts-ignore — Deno global, not visible to web tsc
    Deno.env.get('SUPABASE_URL')!,
    // @ts-ignore — Deno global
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const jwt = authHeader.slice('Bearer '.length);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return jsonResponse(401, { error: 'Invalid session' });

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) return jsonResponse(403, { error: 'Profile not found' });
  if (profile.role !== 'admin') return jsonResponse(403, { error: 'Admin role required' });

  return { userId: user.id, role: profile.role };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

interface CleansedRow {
  first_name: string;
  last_name:  string;
  position:   string | null;
  height_in:  number | null;
  weight_lb:  number | null;
  forty:      number | null;
}

interface CleansedPayload {
  rows:     CleansedRow[];
  warnings: string[];
}

async function cleanse(raw: string): Promise<{
  payload: CleansedPayload;
  usage:   Record<string, number>;
  model:   string;
}> {
  // @ts-ignore — Deno global
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  // @ts-ignore — Deno global
  const model = Deno.env.get('ANTHROPIC_MODEL') ?? DEFAULT_MODEL;

  const client = new Anthropic({ apiKey, timeout: DEFAULT_TIMEOUT });

  const response = await client.messages.create({
    model,
    // 16k tokens is comfortably above worst-case JSON for a 1k-row roster
    // (each row ~30 tokens). For larger rosters, switch to streaming.
    max_tokens: 16_000,

    // No thinking, low effort — this is structured extraction, not reasoning.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },

    // Cache the system prompt so repeated cleanses (the typical admin
    // workflow — cleanse, review, re-cleanse with edits) hit the cache.
    system: [
      {
        type:           'text',
        text:           SYSTEM_PROMPT,
        cache_control:  { type: 'ephemeral' },
      },
    ],

    messages: [
      {
        role:    'user',
        content: `Normalize this roster paste:\n\n${raw}`,
      },
    ],
  });

  // Structured outputs surface as a single text block whose body is the JSON.
  // We still validate it parses + matches our shape — defence in depth.
  const block = response.content.find((b: { type: string }) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined;
  if (!block) throw new Error('LLM returned no text block');

  let parsed: CleansedPayload;
  try {
    parsed = JSON.parse(block.text);
  } catch (e) {
    throw new Error(`LLM returned malformed JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.warnings)) {
    throw new Error('LLM payload missing required keys (rows / warnings)');
  }

  return {
    payload: parsed,
    usage:   {
      input_tokens:               response.usage.input_tokens,
      output_tokens:              response.usage.output_tokens,
      cache_read_input_tokens:    response.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    },
    model:   response.model,
  };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// @ts-ignore — Deno global
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'POST only' });
  }

  // Auth gate
  const auth = await authenticateAdmin(req);
  if (auth instanceof Response) return auth;

  // Parse body
  let body: { raw?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (typeof body.raw !== 'string' || body.raw.trim().length === 0) {
    return jsonResponse(400, { error: 'Missing or empty `raw` field' });
  }
  if (new TextEncoder().encode(body.raw).byteLength > MAX_RAW_BYTES) {
    return jsonResponse(400, {
      error: `Paste exceeds ${MAX_RAW_BYTES.toLocaleString()} bytes — split into multiple cleanses.`,
    });
  }

  // Call the LLM
  try {
    const { payload, usage, model } = await cleanse(body.raw);
    return jsonResponse(200, { ...payload, usage, model });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    // Surface the upstream message but never the API key or stack trace.
    return jsonResponse(500, { error: msg });
  }
});
