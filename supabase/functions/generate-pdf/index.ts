/**
 * generate-pdf
 * Core Elite — Mission "Athlete PDF Report"
 *
 * Stateless, signature-verified PDF generator. The caller POSTs an
 * `athlete_id`; the function authenticates the JWT, queries the athletes
 * + results tables WITH the user's auth context (so RLS gates access —
 * no service-role bypass), runs the same composite-score math as the
 * L3 scout report, and streams a single-page branded PDF back.
 *
 * Architecture invariants (anti-pattern compliance):
 *   1. NO headless browser (Puppeteer / Playwright). pdf-lib is the
 *      only PDF dependency — pure-JS, ~250 kB, runs inside the Edge
 *      Function memory budget.
 *   2. Response carries `Content-Type: application/pdf` AND
 *      `Content-Disposition: attachment; filename=...` so browsers
 *      download instead of trying to render in-tab.
 *   3. NO unauthenticated access. The `Authorization` header is checked
 *      twice: once via `auth.getUser(jwt)` to validate the JWT itself,
 *      once via the RLS-gated `from('athletes').select(...)` which
 *      returns zero rows when the user is not entitled to the athlete.
 *
 * Local development:
 *   npx supabase functions serve generate-pdf --env-file ./.env.local
 *
 *   curl -X POST http://localhost:54321/functions/v1/generate-pdf \
 *        -H 'authorization: Bearer <user-jwt>' \
 *        -H 'content-type: application/json' \
 *        -d '{"athlete_id":"<uuid>"}' \
 *        --output athlete-report.pdf
 */

// @ts-ignore — Deno-resolved npm specifier; web tsc excludes this file.
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
// @ts-ignore — Deno-resolved npm specifier. Pure-JS PDF lib; NO headless browser.
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@^1.17.1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Five primary drills — same set as the L3 UI (src/pages/scout/AthleteDetail.tsx).
type DrillId = 'forty' | 'ten_split' | 'shuttle_5_10_5' | 'vertical' | 'broad';

const DRILL_ORDER: readonly DrillId[] = [
  'forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad',
] as const;

const DRILL_LABELS: Record<DrillId, string> = {
  forty:           '40 YARD',
  ten_split:       '10 SPLIT',
  shuttle_5_10_5:  '5-10-5 SHUTTLE',
  vertical:        'VERTICAL',
  broad:           'BROAD JUMP',
};

const DRILL_UNIT: Record<DrillId, 's' | 'in'> = {
  forty: 's', ten_split: 's', shuttle_5_10_5: 's',
  vertical: 'in', broad: 'in',
};

const DRILL_LOWER_IS_BETTER: Record<DrillId, boolean> = {
  forty: true, ten_split: true, shuttle_5_10_5: true,
  vertical: false, broad: false,
};

// Gillen et al. 2019 aggregate norms — same numbers the scoring engine
// uses when no position-specific norm is available. Inlined here to keep
// the PDF function self-contained (no cross-runtime imports from src/).
const NORMS: Record<DrillId, { mean: number; sd: number }> = {
  forty:           { mean: 5.3,  sd: 0.4  },
  ten_split:       { mean: 1.9,  sd: 0.2  },
  shuttle_5_10_5:  { mean: 4.6,  sd: 0.3  },
  vertical:        { mean: 25.2, sd: 4.3  },
  broad:           { mean: 96.9, sd: 10.6 },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AthleteRow {
  id:          string;
  first_name:  string;
  last_name:   string;
  position:    string;
  bands:       { display_number: number | null } | null;
  results:     Array<{ drill_type: string; value_num: number }> | null;
}

interface DrillCell {
  drillId:    DrillId;
  value:      number;        // best raw value, direction-aware
  percentile: number;        // 0-100
}

// ---------------------------------------------------------------------------
// Math — Abramowitz & Stegun normal CDF + percentile derivation.
// Mirrors src/lib/scoring/percentile.ts so the PDF's composite matches
// the canonical L3 UI score within rounding error.
// ---------------------------------------------------------------------------

function normalCDF(z: number): number {
  // A&S 26.2.17. Max absolute error: 7.5e-8.
  const b1 =  0.319381530;
  const b2 = -0.356563782;
  const b3 =  1.781477937;
  const b4 = -1.821255978;
  const b5 =  1.330274429;
  const p  =  0.2316419;
  const c2 =  0.39894228;

  if (z >= 0) {
    const t = 1 / (1 + p * z);
    return 1 - c2 * Math.exp(-z * z / 2) * t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  }
  return 1 - normalCDF(-z);
}

function computePercentile(drillId: DrillId, value: number): number {
  const { mean, sd } = NORMS[drillId];
  const lowerIsBetter = DRILL_LOWER_IS_BETTER[drillId];
  // Direction-aware z. Lower-is-better drills negate the z so that a
  // sub-mean time still yields a high percentile.
  const z = lowerIsBetter ? (mean - value) / sd : (value - mean) / sd;
  return Math.max(0, Math.min(100, normalCDF(z) * 100));
}

function buildDrillCells(rawResults: Array<{ drill_type: string; value_num: number }>): DrillCell[] {
  // Best raw value per drill, direction-aware.
  const best: Partial<Record<DrillId, number>> = {};
  for (const r of rawResults) {
    if (!(DRILL_ORDER as readonly string[]).includes(r.drill_type)) continue;
    const drillId = r.drill_type as DrillId;
    const v = Number(r.value_num);
    if (!Number.isFinite(v)) continue;
    const lower = DRILL_LOWER_IS_BETTER[drillId];
    const prev  = best[drillId];
    if (prev === undefined) best[drillId] = v;
    else best[drillId] = lower ? Math.min(prev, v) : Math.max(prev, v);
  }

  const cells: DrillCell[] = [];
  for (const drillId of DRILL_ORDER) {
    const value = best[drillId];
    if (value === undefined) continue;
    cells.push({ drillId, value, percentile: computePercentile(drillId, value) });
  }
  return cells;
}

function computeComposite(cells: DrillCell[]): number {
  if (cells.length === 0) return 0;
  return cells.reduce((s, c) => s + c.percentile, 0) / cells.length;
}

// ---------------------------------------------------------------------------
// PDF rendering — pdf-lib, single page, dark-navy/cyan to match the L3 UI
// ---------------------------------------------------------------------------

// US Letter portrait (612 x 792 pt). Standard for recruiter print/email.
const PAGE_WIDTH  = 612;
const PAGE_HEIGHT = 792;

// Theme — cyan/navy mirror of the L3 scout UI (slate-900 + cyan-400).
const COLOR_BG          = rgb(0.058, 0.090, 0.165); // slate-900
const COLOR_TEXT        = rgb(0.97,  0.98,  0.99 ); // slate-100
const COLOR_DIM         = rgb(0.58,  0.64,  0.72 ); // slate-400
const COLOR_FAINT       = rgb(0.32,  0.39,  0.46 ); // slate-500
const COLOR_ACCENT      = rgb(0.13,  0.78,  0.93 ); // cyan-400
const COLOR_TRACK       = rgb(0.12,  0.16,  0.23 ); // slate-800
const COLOR_FILL_HIGH   = rgb(0.13,  0.78,  0.93 ); // cyan-400  (≥80)
const COLOR_FILL_MID    = rgb(0.04,  0.51,  0.64 ); // cyan-600  (50-79)
const COLOR_FILL_LOW    = rgb(0.40,  0.45,  0.51 ); // slate-500 (<50)

function fillFor(p: number) {
  if (p >= 80) return COLOR_FILL_HIGH;
  if (p >= 50) return COLOR_FILL_MID;
  return COLOR_FILL_LOW;
}

interface RenderArgs {
  athlete:   AthleteRow;
  cells:     DrillCell[];
  composite: number;
}

async function renderPdf({ athlete, cells, composite }: RenderArgs): Promise<Uint8Array> {
  const doc  = await PDFDocument.create();
  doc.setTitle(`${athlete.first_name} ${athlete.last_name} — Combine Report`);
  doc.setAuthor('Core Elite Combine');
  doc.setSubject('Athlete combine results');
  doc.setProducer('Core Elite — generate-pdf');
  doc.setCreationDate(new Date());

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const sans     = await doc.embedFont(StandardFonts.Helvetica);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono     = await doc.embedFont(StandardFonts.Courier);
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);

  // Background fill — dark navy across the full page.
  page.drawRectangle({
    x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT,
    color: COLOR_BG,
  });

  // ── Sticky header strip ─────────────────────────────────────────────
  const HEADER_H = 60;
  page.drawRectangle({
    x: 0, y: PAGE_HEIGHT - HEADER_H, width: PAGE_WIDTH, height: HEADER_H,
    color: rgb(0.04, 0.06, 0.12), // slate-950
  });
  page.drawText('CORE ELITE · COMBINE REPORT', {
    x: 36, y: PAGE_HEIGHT - 38,
    font: sansBold, size: 11, color: COLOR_ACCENT,
  });
  page.drawText(new Date().toISOString().slice(0, 10), {
    x: PAGE_WIDTH - 100, y: PAGE_HEIGHT - 38,
    font: mono, size: 10, color: COLOR_DIM,
  });

  // ── Identity strip ──────────────────────────────────────────────────
  let cursorY = PAGE_HEIGHT - HEADER_H - 50;
  const fullName = `${athlete.first_name} ${athlete.last_name.toUpperCase()}`;
  page.drawText(fullName, {
    x: 36, y: cursorY,
    font: sansBold, size: 28, color: COLOR_TEXT,
  });
  cursorY -= 22;

  const identityLine = [
    athlete.position,
    athlete.bands?.display_number != null ? `BAND #${athlete.bands.display_number}` : null,
    `${cells.length} DRILL${cells.length === 1 ? '' : 'S'}`,
  ].filter((s): s is string => Boolean(s)).join('  ·  ');
  page.drawText(identityLine, {
    x: 36, y: cursorY,
    font: mono, size: 9, color: COLOR_FAINT,
  });

  // Composite badge — top-right of identity strip
  const compositeStr = composite.toFixed(0);
  const compositeFontSize = 56;
  const compositeWidth = sansBold.widthOfTextAtSize(compositeStr, compositeFontSize);
  page.drawText(compositeStr, {
    x: PAGE_WIDTH - 36 - compositeWidth,
    y: cursorY + 4,
    font: sansBold, size: compositeFontSize, color: COLOR_ACCENT,
  });
  page.drawText('COMPOSITE', {
    x: PAGE_WIDTH - 36 - sansBold.widthOfTextAtSize('COMPOSITE', 8),
    y: cursorY - 12,
    font: sansBold, size: 8, color: COLOR_DIM,
  });

  // ── Section header ──────────────────────────────────────────────────
  cursorY -= 60;
  page.drawText('BIOMECHANICAL TRACE', {
    x: 36, y: cursorY,
    font: sansBold, size: 11, color: COLOR_ACCENT,
  });
  cursorY -= 6;
  page.drawLine({
    start: { x: 36, y: cursorY }, end: { x: PAGE_WIDTH - 36, y: cursorY },
    thickness: 0.5, color: COLOR_TRACK,
  });
  cursorY -= 24;

  // ── Drill rows ──────────────────────────────────────────────────────
  const ROW_H = 56;
  const BAR_W = 320;
  const BAR_H = 6;
  const LABEL_X  = 36;
  const VALUE_X  = 200;
  const BAR_X    = 250;
  const PCT_X    = PAGE_WIDTH - 36;

  for (const cell of cells) {
    // Label
    page.drawText(DRILL_LABELS[cell.drillId], {
      x: LABEL_X, y: cursorY,
      font: sansBold, size: 11, color: COLOR_DIM,
    });

    // Raw value (tabular-nums via monospace font for vertical alignment)
    const raw = `${cell.value.toFixed(2)}${DRILL_UNIT[cell.drillId]}`;
    page.drawText(raw, {
      x: VALUE_X, y: cursorY,
      font: monoBold, size: 11, color: COLOR_TEXT,
    });

    // Percentile readout (right-aligned)
    const pctStr = `${cell.percentile.toFixed(0)}p`;
    const pctW   = monoBold.widthOfTextAtSize(pctStr, 11);
    page.drawText(pctStr, {
      x: PCT_X - pctW, y: cursorY,
      font: monoBold, size: 11, color: COLOR_ACCENT,
    });

    // Bar — track + fill
    const barY = cursorY - 16;
    page.drawRectangle({
      x: BAR_X, y: barY, width: BAR_W, height: BAR_H,
      color: COLOR_TRACK,
    });
    const fillW = (cell.percentile / 100) * BAR_W;
    page.drawRectangle({
      x: BAR_X, y: barY, width: fillW, height: BAR_H,
      color: fillFor(cell.percentile),
    });

    // Quartile ticks (subtle — drawn under the fill, rendered after so
    // pdf-lib doesn't swap order; visually fine because cyan covers darker).
    for (const tick of [25, 50, 75]) {
      const tx = BAR_X + (tick / 100) * BAR_W;
      page.drawLine({
        start: { x: tx, y: barY }, end: { x: tx, y: barY + BAR_H },
        thickness: 0.5, color: rgb(0.25, 0.31, 0.39), // slate-700
      });
    }

    cursorY -= ROW_H;
  }

  if (cells.length === 0) {
    page.drawText('NO DRILL DATA', {
      x: 36, y: cursorY,
      font: mono, size: 10, color: COLOR_FAINT,
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────
  page.drawLine({
    start: { x: 36, y: 56 }, end: { x: PAGE_WIDTH - 36, y: 56 },
    thickness: 0.5, color: COLOR_TRACK,
  });
  page.drawText(
    'Norms: Gillen et al. 2019 (PMC6355118) · A&S 26.2.17 percentile · ' +
    'Generated server-side with verified RLS scope.',
    { x: 36, y: 40, font: sans, size: 7, color: COLOR_FAINT },
  );
  page.drawText(`athlete_id: ${athlete.id}`, {
    x: 36, y: 26,
    font: mono, size: 7, color: COLOR_FAINT,
  });

  return await doc.save();
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function plainResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain', ...CORS_HEADERS },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// @ts-ignore — Deno global, not visible to web tsc
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return plainResponse(405, 'POST only');
  }

  // ── Auth gate (anti-pattern: NO unauthenticated access) ──────────────
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization header' });
  }

  // @ts-ignore — Deno global
  const supabaseUrl     = Deno.env.get('SUPABASE_URL');
  // @ts-ignore — Deno global
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[generate-pdf] missing SUPABASE_URL / SUPABASE_ANON_KEY');
    return plainResponse(500, 'Server configuration error.');
  }

  // Construct the Supabase client with the CALLER'S auth header — so
  // every query runs under the user's RLS context. The service role key
  // is intentionally NOT touched here; this function trusts RLS to
  // enforce tenant isolation (see migrations/010a_rls_hardening.sql).
  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false },
  });

  // Validate the JWT itself — auth.getUser checks signature + expiry.
  const jwt = authHeader.slice('Bearer '.length);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) {
    return jsonResponse(401, { error: 'Invalid session' });
  }

  // ── Body parse ───────────────────────────────────────────────────────
  let body: { athlete_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id : '';
  if (athleteId.length === 0) {
    return jsonResponse(400, { error: 'Missing athlete_id' });
  }

  // ── RLS-gated query ──────────────────────────────────────────────────
  // The query runs with the user's auth context; RLS policies in
  // mig 010a (athletes_tenant_select / results_tenant_select) return
  // zero rows when the user is not entitled to this athlete. We treat
  // a missing row as 403 Forbidden so a recruiter scoping never leaks
  // existence — same response whether the row doesn't exist OR exists
  // outside the user's tenant.
  const { data: athlete, error: queryErr } = await supabase
    .from('athletes')
    .select('id, first_name, last_name, position, bands(display_number), results(drill_type, value_num)')
    .eq('id', athleteId)
    .maybeSingle<AthleteRow>();

  if (queryErr) {
    console.error('[generate-pdf] athlete query failed', queryErr.message);
    return jsonResponse(500, { error: 'Athlete lookup failed' });
  }
  if (!athlete) {
    return jsonResponse(403, { error: 'Athlete not found or not authorized.' });
  }

  // ── Compute composite + drill cells ──────────────────────────────────
  const cells     = buildDrillCells(athlete.results ?? []);
  const composite = computeComposite(cells);

  // ── Render + return ──────────────────────────────────────────────────
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdf({ athlete, cells, composite });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'PDF render failure';
    console.error('[generate-pdf] render error', msg);
    return jsonResponse(500, { error: 'PDF render failed' });
  }

  const safeName = `${athlete.last_name}_${athlete.first_name}_combine_report.pdf`
    .replace(/[^A-Za-z0-9._-]/g, '_');

  // Anti-pattern compliance: explicit Content-Type + Content-Disposition.
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type':        'application/pdf',
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control':       'private, no-store',
    },
  });
});
