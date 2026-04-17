/**
 * b2b-exports.ts
 * Core Elite — Institutional Export Layer
 *
 * Generates CRM-compatible CSV payloads for D1 collegiate recruiting
 * platforms. The column schemas are fixed by the receiving platform's
 * import specification and must not be modified without coordinating
 * with the institutional administrator at the target school.
 *
 * Supported targets:
 *   ARMS     — Athletic Recruiting Management System (used by 120+ D1 programs)
 *   JumpForward — SaaS recruiting platform (acquired by Teamworks, 2022)
 *   XOS      — Digital film + recruiting platform (used by Power 5 programs)
 *
 * All three platforms accept the ARMS column schema with minor aliasing.
 * One export function handles all three: generateArmsCSV().
 *
 * CSV escaping: RFC 4180 compliant.
 *   - Fields containing commas, double-quotes, or newlines are wrapped in
 *     double-quotes.
 *   - Double-quote characters within a field are escaped as "".
 *   - Null/undefined values are exported as empty strings (never "null"
 *     or "undefined" — these would be imported as literal strings by some
 *     platforms and corrupt filter queries).
 */

// ---------------------------------------------------------------------------
// Drill ID → ARMS column mapping
// The ARMS schema uses human-readable column headers, not our internal IDs.
// Order matches the official ARMS athlete import template v3.1 (2023).
// ---------------------------------------------------------------------------

const DRILL_TO_ARMS_COL: Record<string, string> = {
  forty:          '40 Time',
  ten_split:      '10-Split',
  vertical:       'Vertical',
  broad:          'Broad Jump',
  shuttle_5_10_5: 'Pro-Agility',  // 5-10-5 = Pro Agility in ARMS taxonomy
  three_cone:     'L-Drill',       // 3-cone = L-Drill in ARMS taxonomy
  bench_reps:     'Bench Press',
};

// ARMS column order — must match exactly.
// Columns not present in our data model are exported as empty strings.
const ARMS_HEADERS = [
  'Name',
  'High School',
  'Grad Year',
  'Position',
  'Height',
  'Weight',
  '40 Time',
  '10-Split',
  'Vertical',
  'Broad Jump',
  'Pro-Agility',
  'L-Drill',
] as const;

export type ArmsHeader = typeof ARMS_HEADERS[number];

// ---------------------------------------------------------------------------
// Athlete shape expected by this module.
// Intentionally loose — accepts the CoachPortal AthleteRow or any superset.
// ---------------------------------------------------------------------------

export interface ExportableAthlete {
  id:          string;
  first_name:  string;
  last_name:   string;
  position:    string;
  // Extended fields — high_school added via migration 022;
  // height_in / weight_lb match the DB column names (integer inches / lbs).
  high_school?: string;
  grad_year?:   string | number;
  height_in?:   number | string;  // integer inches, e.g. 74
  weight_lb?:   number | string;  // integer lbs
  // Results — only best result per drill is exported
  bestResults:  Record<string, { value_num: number } | undefined>;
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV escaping
// ---------------------------------------------------------------------------

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Wrap in double-quotes if the field contains a comma, double-quote,
  // newline, or carriage return. These are the only triggers per RFC 4180.
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// generateArmsCSV
//
// Produces a well-formed, RFC 4180-compliant CSV string ready for direct
// download. The output is UTF-8 and includes a BOM (\uFEFF) so that
// Microsoft Excel opens it correctly without a data import wizard step.
//
// Usage:
//   const csv = generateArmsCSV(athletes);
//   downloadCSV(csv, `core-elite-arms-export-${eventName}-${date}.csv`);
// ---------------------------------------------------------------------------

export function generateArmsCSV(
  athletes:  ExportableAthlete[],
  eventName: string = 'export',
): string {
  const headerRow = ARMS_HEADERS.map(escapeCell).join(',');

  const dataRows = athletes.map(a => {
    const fullName = `${a.first_name} ${a.last_name}`;

    // Build column → value map for this athlete
    const row: Record<ArmsHeader, unknown> = {
      'Name':        fullName,
      'High School': a.high_school  ?? '',
      'Grad Year':   a.grad_year    ?? '',
      'Position':    a.position     ?? '',
      'Height':      a.height_in    ?? '',
      'Weight':      a.weight_lb    ?? '',
      '40 Time':     a.bestResults['forty']?.value_num          ?? '',
      '10-Split':    a.bestResults['ten_split']?.value_num       ?? '',
      'Vertical':    a.bestResults['vertical']?.value_num        ?? '',
      'Broad Jump':  a.bestResults['broad']?.value_num           ?? '',
      'Pro-Agility': a.bestResults['shuttle_5_10_5']?.value_num  ?? '',
      'L-Drill':     a.bestResults['three_cone']?.value_num      ?? '',
    };

    return ARMS_HEADERS.map(col => escapeCell(row[col])).join(',');
  });

  // UTF-8 BOM + header + data rows, CRLF line endings (RFC 4180 §2)
  return '\uFEFF' + [headerRow, ...dataRows].join('\r\n');
}

// ---------------------------------------------------------------------------
// downloadCSV — triggers a browser file download.
// Call this from your onClick handler; do not call in SSR context.
// ---------------------------------------------------------------------------

export function downloadCSV(csvString: string, filename: string): void {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke immediately — the browser retains the blob in memory until
  // the tab closes, but revoking the URL allows GC to reclaim it sooner.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// ---------------------------------------------------------------------------
// buildExportFilename — standardised naming convention for scout archives.
// Format: core-elite-arms_[event-slug]_[YYYY-MM-DD].csv
// The event slug is URL-safe: lowercase, hyphens only, no special chars.
// ---------------------------------------------------------------------------

export function buildExportFilename(eventName: string): string {
  const slug = eventName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const date = new Date().toISOString().split('T')[0];
  return `core-elite-arms_${slug}_${date}.csv`;
}
