/**
 * VendorImport.tsx
 * Core Elite — Phase 3: Historical Data Import Pipeline
 *
 * Drag-and-drop CSV importer for legacy vendor combine data.
 * Parses CSV client-side, shows a column-mapping preview, then POSTs
 * batched records to the process-vendor-import Edge Function.
 *
 * Expected CSV columns (case-insensitive, flexible aliases accepted):
 *   Required: drill_type, value_num
 *   Identity: athlete_id (UUID) OR first_name + last_name
 *   Optional: recorded_at, attempt_number, notes, position
 *
 * The component calls supabase.functions.invoke() which automatically
 * attaches the admin's session JWT — no VERIFICATION_SECRET needed here.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  FileText,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { DRILL_CATALOG } from '../../constants';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventOption {
  id:   string;
  name: string;
}

/** One row as parsed from the CSV header + values */
type RawRow = Record<string, string>;

/** A row after column mapping has been applied */
interface MappedRow {
  athlete_id?:     string;
  first_name?:     string;
  last_name?:      string;
  drill_type:      string;
  value_num:       string;
  recorded_at?:    string;
  attempt_number?: string;
  notes?:          string;
  position?:       string;
}

interface ImportResult {
  inserted:      number;
  skipped:       number;
  failed:        number;
  total:         number;
  new_athletes:  number;
  event_name:    string;
  errors:        { row: number; reason: string }[];
}

/** Maps required/optional logical field names to detected CSV column names */
interface ColumnMapping {
  athlete_id:     string;
  first_name:     string;
  last_name:      string;
  drill_type:     string;
  value_num:      string;
  recorded_at:    string;
  attempt_number: string;
  notes:          string;
  position:       string;
}

type Phase =
  | 'idle'
  | 'file_dropped'
  | 'importing'
  | 'done'
  | 'error';

// ─── Constants ────────────────────────────────────────────────────────────────

const NONE = '— none —';
const MAX_PREVIEW_ROWS = 8;

/**
 * Common header aliases for auto-detection.
 * Keys are our canonical field names; values are CSV header candidates
 * (all lower-cased for comparison).
 */
const COLUMN_ALIASES: Record<keyof ColumnMapping, string[]> = {
  athlete_id:     ['athlete_id', 'athlete id', 'athleteid', 'id'],
  first_name:     ['first_name', 'firstname', 'first', 'given_name', 'given'],
  last_name:      ['last_name', 'lastname', 'last', 'family_name', 'surname'],
  drill_type:     ['drill_type', 'drill', 'event', 'test', 'category', 'activity'],
  value_num:      ['value_num', 'value', 'time', 'distance', 'score', 'result', 'measurement', 'num'],
  recorded_at:    ['recorded_at', 'date', 'datetime', 'timestamp', 'test_date', 'event_date', 'occurred_at'],
  attempt_number: ['attempt_number', 'attempt', 'rep', 'trial', 'take'],
  notes:          ['notes', 'note', 'comment', 'comments', 'memo', 'remark'],
  position:       ['position', 'pos', 'player_position', 'role'],
};

// ─── CSV Parser ───────────────────────────────────────────────────────────────

/**
 * Lightweight RFC 4180-compatible CSV parser.
 * Handles quoted fields, escaped double-quotes, CRLF/LF, and UTF-8 BOM.
 */
function parseCSV(raw: string): { headers: string[]; rows: RawRow[] } {
  // Strip UTF-8 BOM
  const text  = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const nonEmpty = lines.filter(l => l.trim() !== '');
  if (nonEmpty.length < 2) return { headers: [], rows: [] };

  const headers = parseRow(nonEmpty[0]).map(h => h.toLowerCase().trim());
  const rows    = nonEmpty.slice(1).map(line => {
    const values = parseRow(line);
    return Object.fromEntries(
      headers.map((h, i) => [h, values[i] ?? ''])
    ) as RawRow;
  });

  return { headers, rows };
}

/**
 * Auto-detects the best column mapping given a list of CSV headers.
 * Returns the canonical field name → CSV column name mapping.
 * Fields with no match are set to NONE.
 */
function detectMapping(headers: string[]): ColumnMapping {
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());

  const detect = (candidates: string[]): string => {
    for (const candidate of candidates) {
      const match = headers.find((_, i) => lowerHeaders[i] === candidate);
      if (match) return match;
    }
    return NONE;
  };

  return {
    athlete_id:     detect(COLUMN_ALIASES.athlete_id),
    first_name:     detect(COLUMN_ALIASES.first_name),
    last_name:      detect(COLUMN_ALIASES.last_name),
    drill_type:     detect(COLUMN_ALIASES.drill_type),
    value_num:      detect(COLUMN_ALIASES.value_num),
    recorded_at:    detect(COLUMN_ALIASES.recorded_at),
    attempt_number: detect(COLUMN_ALIASES.attempt_number),
    notes:          detect(COLUMN_ALIASES.notes),
    position:       detect(COLUMN_ALIASES.position),
  };
}

/** Applies the column mapping to convert a RawRow → MappedRow */
function applyMapping(row: RawRow, m: ColumnMapping): MappedRow {
  const get = (col: string): string | undefined => {
    const v = col !== NONE ? (row[col.toLowerCase()] ?? '').trim() : '';
    return v !== '' ? v : undefined;
  };
  return {
    athlete_id:     get(m.athlete_id),
    first_name:     get(m.first_name),
    last_name:      get(m.last_name),
    drill_type:     get(m.drill_type) ?? '',
    value_num:      get(m.value_num) ?? '',
    recorded_at:    get(m.recorded_at),
    attempt_number: get(m.attempt_number),
    notes:          get(m.notes),
    position:       get(m.position),
  };
}

/** Basic pre-flight validation on a mapped row; returns error string or null */
function validateRow(r: MappedRow, i: number): string | null {
  if (!r.drill_type) return `Row ${i + 1}: drill_type is empty`;
  if (!r.value_num || isNaN(parseFloat(r.value_num))) {
    return `Row ${i + 1}: value_num "${r.value_num}" is not a number`;
  }
  if (!r.athlete_id && (!r.first_name || !r.last_name)) {
    return `Row ${i + 1}: provide athlete_id OR both first_name and last_name`;
  }
  return null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">
      {children}
    </p>
  );
}

interface FieldRowProps {
  label:    string;
  required: boolean;
  value:    string;
  headers:  string[];
  onChange: (v: string) => void;
}

function FieldRow({ label, required, value, headers, onChange }: FieldRowProps) {
  const detected = value !== NONE;
  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-800 last:border-0">
      <div className="w-32 shrink-0">
        <span className="text-white text-xs font-bold">{label}</span>
        {required && <span className="ml-1 text-red-400 text-[10px] font-black">*</span>}
      </div>
      <div className="flex-1">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full bg-slate-900 border border-slate-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-sky-500"
        >
          <option value={NONE}>{NONE}</option>
          {headers.map(h => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
      </div>
      <div className="w-5 shrink-0">
        {detected
          ? <CheckCircle className="w-4 h-4 text-emerald-400" />
          : required
            ? <AlertCircle className="w-4 h-4 text-red-400" />
            : <span className="w-4 h-4 block" />
        }
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function VendorImport() {
  // ── Data state ───────────────────────────────────────────────────────────
  const [events,        setEvents]        = useState<EventOption[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [headers,       setHeaders]       = useState<string[]>([]);
  const [rawRows,       setRawRows]       = useState<RawRow[]>([]);
  const [fileName,      setFileName]      = useState('');
  const [mapping,       setMapping]       = useState<ColumnMapping | null>(null);
  const [importResult,  setImportResult]  = useState<ImportResult | null>(null);
  const [errorMsg,      setErrorMsg]      = useState('');

  // ── UI phase ─────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('idle');

  // ── Drag state ───────────────────────────────────────────────────────────
  const [isDragOver,  setIsDragOver]  = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const dropRef = useRef<HTMLDivElement>(null);

  // ── Load events on mount ─────────────────────────────────────────────────
  useEffect(() => {
    supabase
      .from('events')
      .select('id, name')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setEvents((data ?? []).map((e: { id: string; name: string }) => ({
          id:   e.id,
          name: e.name,
        })));
      });
  }, []);

  // ── File processing ──────────────────────────────────────────────────────
  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setErrorMsg('Only .csv files are supported.');
      setPhase('error');
      return;
    }

    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      if (!text) {
        setErrorMsg('Could not read file contents.');
        setPhase('error');
        return;
      }
      const { headers: h, rows } = parseCSV(text);
      if (h.length === 0 || rows.length === 0) {
        setErrorMsg('CSV appears empty or has no data rows after the header.');
        setPhase('error');
        return;
      }
      setHeaders(h);
      setRawRows(rows);
      setFileName(file.name);
      setMapping(detectMapping(h));
      setPhase('file_dropped');
    };
    reader.readAsText(file, 'UTF-8');
  }, []);

  // ── Drag handlers ────────────────────────────────────────────────────────
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true);  }, []);
  const onDragLeave = useCallback(()                    => { setIsDragOver(false); }, []);
  const onDrop      = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  // ── Import ───────────────────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!mapping || !selectedEvent || rawRows.length === 0) return;

    // Client-side pre-flight check
    const validationErrors: string[] = [];
    const mapped = rawRows.map((r, i) => {
      const m = applyMapping(r, mapping);
      const err = validateRow(m, i);
      if (err) validationErrors.push(err);
      return m;
    });

    if (validationErrors.length > 0) {
      setErrorMsg(
        `${validationErrors.length} row(s) failed validation:\n` +
        validationErrors.slice(0, 5).join('\n') +
        (validationErrors.length > 5 ? `\n…and ${validationErrors.length - 5} more` : '')
      );
      setPhase('error');
      return;
    }

    setPhase('importing');
    setImportProgress(0);

    // Build request payload
    const payload = {
      event_id: selectedEvent,
      records:  mapped.map(r => ({
        ...(r.athlete_id     ? { athlete_id:     r.athlete_id     } : {}),
        ...(r.first_name     ? { first_name:     r.first_name     } : {}),
        ...(r.last_name      ? { last_name:      r.last_name      } : {}),
        drill_type:           r.drill_type,
        value_num:            parseFloat(r.value_num),
        ...(r.recorded_at    ? { recorded_at:    r.recorded_at    } : {}),
        ...(r.attempt_number ? { attempt_number: parseInt(r.attempt_number, 10) } : {}),
        ...(r.notes          ? { notes:          r.notes          } : {}),
        ...(r.position       ? { position:       r.position       } : {}),
      })),
    };

    // Simulate progress (no streaming — show determinate progress before/after)
    const progressTick = window.setInterval(
      () => setImportProgress(p => Math.min(p + 8, 85)),
      200,
    );

    try {
      const { data, error } = await supabase.functions.invoke(
        'process-vendor-import',
        { body: payload },
      );

      window.clearInterval(progressTick);
      setImportProgress(100);

      if (error) {
        throw new Error(error.message ?? 'Edge Function returned an error.');
      }

      setImportResult(data as ImportResult);
      setPhase('done');
    } catch (err: unknown) {
      window.clearInterval(progressTick);
      setErrorMsg(err instanceof Error ? err.message : 'Import failed due to an unexpected error.');
      setPhase('error');
    }
  }, [mapping, selectedEvent, rawRows]);

  const reset = useCallback(() => {
    setPhase('idle');
    setHeaders([]);
    setRawRows([]);
    setFileName('');
    setMapping(null);
    setImportResult(null);
    setErrorMsg('');
    setImportProgress(0);
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────
  const previewRows     = rawRows.slice(0, MAX_PREVIEW_ROWS);
  const mappingValid    =
    mapping !== null &&
    mapping.drill_type !== NONE &&
    mapping.value_num  !== NONE &&
    (mapping.athlete_id !== NONE ||
      (mapping.first_name !== NONE && mapping.last_name !== NONE));

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-900 p-4 lg:p-6 text-white">

      {/* ── Header ── */}
      <div className="mb-6">
        <h1 className="text-2xl lg:text-3xl font-black uppercase tracking-tight flex items-center gap-3">
          <Upload className="w-7 h-7 text-sky-400 shrink-0" />
          Vendor Import
        </h1>
        <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">
          Legacy CSV data pipeline — Phase 3
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6 items-start">

        {/* ── Left column: drop zone + mapping ── */}
        <div className="space-y-5">

          {/* Format reference card */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
            <SectionLabel>Expected CSV Format</SectionLabel>
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left">
                    <th className="pb-2 pr-4 text-slate-400 font-black uppercase tracking-wide">Column</th>
                    <th className="pb-2 pr-4 text-slate-400 font-black uppercase tracking-wide">Required</th>
                    <th className="pb-2 text-slate-400 font-black uppercase tracking-wide">Example / Notes</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-slate-300">
                  {[
                    ['drill_type',     '✓', `forty | vertical | shuttle_5_10_5 | bench_reps …`],
                    ['value_num',      '✓', '4.52  (numeric only)'],
                    ['athlete_id',     '†', 'UUID — use this OR first_name + last_name'],
                    ['first_name',     '†', 'John'],
                    ['last_name',      '†', 'Smith'],
                    ['recorded_at',    '', '2024-03-15T10:30:00Z'],
                    ['attempt_number', '', '1 (default)'],
                    ['position',       '', 'WR  (used when creating new athletes)'],
                    ['notes',          '', 'Strong rep — stored in meta.notes'],
                  ].map(([col, req, note]) => (
                    <tr key={col} className="border-t border-slate-700/50">
                      <td className="py-1.5 pr-4 text-sky-300 text-[11px]">{col}</td>
                      <td className="py-1.5 pr-4 text-center">
                        {req === '✓' && <span className="text-red-400 font-black">✓</span>}
                        {req === '†' && <span className="text-amber-400">†</span>}
                      </td>
                      <td className="py-1.5 text-slate-400 text-[10px]">{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-slate-600 mt-2">† One of these groups is required.</p>
            </div>
          </div>

          {/* Drill IDs reference */}
          <details className="group bg-slate-800 border border-slate-700 rounded-xl">
            <summary className="flex items-center justify-between p-4 cursor-pointer select-none">
              <span className="text-xs font-black uppercase tracking-widest text-slate-400">
                Valid drill_type values
              </span>
              <ChevronDown className="w-4 h-4 text-slate-500 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {DRILL_CATALOG.map(d => (
                <div key={d.id} className="bg-slate-900 rounded px-2 py-1">
                  <p className="text-sky-300 font-mono text-[11px]">{d.id}</p>
                  <p className="text-slate-500 text-[9px]">{d.label}</p>
                </div>
              ))}
            </div>
          </details>

          {/* Drop zone */}
          {(phase === 'idle' || phase === 'error') && (
            <div>
              <SectionLabel>Step 1 — Drop CSV File</SectionLabel>
              <div
                ref={dropRef}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`relative border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center gap-4 transition-colors cursor-pointer ${
                  isDragOver
                    ? 'border-sky-400 bg-sky-500/10'
                    : 'border-slate-600 hover:border-slate-500 bg-slate-800/40'
                }`}
              >
                <label className="absolute inset-0 cursor-pointer" htmlFor="csv-input" />
                <input
                  id="csv-input"
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={onFileInput}
                />
                <FileText className={`w-10 h-10 ${isDragOver ? 'text-sky-400' : 'text-slate-600'}`} />
                <div className="text-center pointer-events-none">
                  <p className="text-white font-black text-sm">
                    {isDragOver ? 'Release to load' : 'Drop CSV here or click to browse'}
                  </p>
                  <p className="text-slate-500 text-xs mt-1">UTF-8, comma-separated, first row as headers</p>
                </div>
              </div>

              {phase === 'error' && errorMsg && (
                <div className="mt-3 flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <pre className="text-red-300 text-xs whitespace-pre-wrap font-mono">{errorMsg}</pre>
                  <button onClick={reset} className="ml-auto shrink-0 text-slate-500 hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Column mapping */}
          {(phase === 'file_dropped') && mapping !== null && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <SectionLabel>Step 2 — Confirm Column Mapping</SectionLabel>
                <button
                  onClick={reset}
                  className="text-[10px] text-slate-500 hover:text-white flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Remove file
                </button>
              </div>

              <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden mb-4">
                <div className="px-4 py-3 border-b border-slate-700 flex items-center gap-3">
                  <FileText className="w-4 h-4 text-sky-400" />
                  <span className="text-sm font-bold text-white">{fileName}</span>
                  <span className="ml-auto text-xs text-slate-500">
                    {rawRows.length.toLocaleString()} rows · {headers.length} columns
                  </span>
                </div>
                <div className="px-4 py-2">
                  {(Object.entries(mapping) as [keyof ColumnMapping, string][]).map(
                    ([field, col]) => (
                      <FieldRow
                        key={field}
                        label={field}
                        required={field === 'drill_type' || field === 'value_num'}
                        value={col}
                        headers={headers}
                        onChange={v =>
                          setMapping(prev => prev ? { ...prev, [field]: v } : prev)
                        }
                      />
                    ),
                  )}
                </div>
              </div>

              {/* Preview table */}
              <SectionLabel>Preview (first {Math.min(previewRows.length, MAX_PREVIEW_ROWS)} rows)</SectionLabel>
              <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="border-b border-slate-700">
                      {headers.map(h => (
                        <th key={h} className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-wide text-slate-400 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i} className="border-b border-slate-800 hover:bg-slate-700/30">
                        {headers.map(h => (
                          <td key={h} className="px-3 py-2 text-slate-300 font-mono whitespace-nowrap max-w-[120px] truncate">
                            {row[h] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rawRows.length > MAX_PREVIEW_ROWS && (
                  <p className="px-3 py-2 text-[10px] text-slate-600 border-t border-slate-800">
                    …and {(rawRows.length - MAX_PREVIEW_ROWS).toLocaleString()} more rows not shown
                  </p>
                )}
              </div>

              {!mappingValid && (
                <div className="mt-3 flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <p className="text-amber-300 text-xs font-bold">
                    Map drill_type, value_num, and athlete identity before importing.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Importing progress */}
          {phase === 'importing' && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 text-sky-400 animate-spin" />
              <div className="w-full max-w-xs">
                <div className="flex justify-between text-xs text-slate-400 mb-2 font-bold uppercase tracking-widest">
                  <span>Processing</span>
                  <span>{importProgress}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-1.5">
                  <div
                    className="bg-sky-400 h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${importProgress}%` }}
                  />
                </div>
              </div>
              <p className="text-slate-400 text-sm">
                Inserting {rawRows.length.toLocaleString()} records into the database…
              </p>
            </div>
          )}

          {/* Done */}
          {phase === 'done' && importResult && (
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-5">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-8 h-8 text-emerald-400 shrink-0" />
                <div>
                  <p className="text-white font-black text-lg">Import Complete</p>
                  <p className="text-slate-400 text-xs mt-0.5">
                    Event: <span className="text-white font-bold">{importResult.event_name}</span>
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {([
                  ['Inserted',       importResult.inserted,     'text-emerald-400'],
                  ['Skipped',        importResult.skipped,      'text-slate-400'],
                  ['Failed',         importResult.failed,       importResult.failed > 0 ? 'text-red-400' : 'text-slate-400'],
                  ['New Athletes',   importResult.new_athletes, 'text-sky-400'],
                ] as const).map(([label, val, color]) => (
                  <div key={label} className="bg-slate-900 rounded-lg p-4">
                    <p className="text-slate-500 text-[9px] font-black uppercase tracking-widest">{label}</p>
                    <p className={`text-3xl font-black tabular-nums ${color}`}>{val}</p>
                  </div>
                ))}
              </div>

              {importResult.errors.length > 0 && (
                <div>
                  <p className="text-xs font-black uppercase tracking-widest text-red-400 mb-2">
                    Row errors ({importResult.errors.length})
                  </p>
                  <ul className="space-y-1 max-h-48 overflow-y-auto">
                    {importResult.errors.map((e, i) => (
                      <li key={i} className="flex gap-2 text-xs bg-red-500/10 border border-red-500/20 rounded px-3 py-1.5">
                        <span className="text-red-400 font-black shrink-0">Row {e.row}</span>
                        <span className="text-slate-300">{e.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                onClick={reset}
                className="w-full py-2 border border-slate-600 rounded-lg text-xs font-black uppercase tracking-widest text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
              >
                Import Another File
              </button>
            </div>
          )}
        </div>

        {/* ── Right column: event selector + action ── */}
        <div className="space-y-4 xl:sticky xl:top-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <SectionLabel>Step 3 — Select Target Event</SectionLabel>
            {events.length === 0 ? (
              <p className="text-slate-500 text-xs">Loading events…</p>
            ) : (
              <select
                value={selectedEvent}
                onChange={e => setSelectedEvent(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="">— choose an event —</option>
                {events.map(ev => (
                  <option key={ev.id} value={ev.id}>{ev.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Action button */}
          <button
            onClick={handleImport}
            disabled={
              phase !== 'file_dropped' ||
              !selectedEvent           ||
              !mappingValid
            }
            className={`w-full py-4 rounded-xl text-sm font-black uppercase tracking-widest transition-all ${
              phase === 'file_dropped' && selectedEvent && mappingValid
                ? 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/20'
                : 'bg-slate-700 text-slate-500 cursor-not-allowed'
            }`}
          >
            {phase === 'importing'
              ? 'Importing…'
              : `Process Import (${rawRows.length.toLocaleString()} rows)`
            }
          </button>

          {/* Safety notice */}
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 space-y-1.5">
            <p className="text-amber-300 text-[10px] font-black uppercase tracking-widest">
              Safety notes
            </p>
            <ul className="space-y-1">
              {[
                'Rows are tagged source_type = imported_csv and excluded from live dashboards.',
                'Import is idempotent — re-uploading the same file is safe.',
                'Athletes not found by name will be created with placeholder contact info.',
                'This action cannot be undone from the UI. Use Supabase Studio to void rows.',
              ].map((note, i) => (
                <li key={i} className="text-amber-200/60 text-[10px] flex gap-1.5">
                  <span className="text-amber-500 shrink-0">•</span>
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
