import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  Shield,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EventOption {
  id:   string;
  name: string;
}

type RawRow = Record<string, string>;

interface ColMap {
  first_name:  string;
  last_name:   string;
  email:       string;
  dob:         string;
  position:    string;
  forty:       string;
  pro_agility: string;
  vertical:    string;
  broad:       string;
}

interface ImportResult {
  success:      boolean;
  inserted:     number;
  skipped:      number;
  new_athletes: number;
  total:        number;
  errors:       { row: number; reason: string }[];
  error?:       string;
}

type Phase = 'idle' | 'mapped' | 'importing' | 'done' | 'error';

// ─── Constants ────────────────────────────────────────────────────────────────

const NONE = '— none —';

const COL_ALIASES: Record<keyof ColMap, string[]> = {
  first_name:  ['first name', 'firstname', 'first_name', 'first', 'given name', 'given_name'],
  last_name:   ['last name', 'lastname', 'last_name', 'last', 'surname', 'family name'],
  email:       ['email', 'parent email', 'parent_email', 'e-mail', 'contact email', 'guardian email'],
  dob:         ['dob', 'date of birth', 'date_of_birth', 'birthdate', 'birth date', 'birthday', 'born'],
  position:    ['position', 'pos', 'player position', 'player_position', 'role'],
  forty:       ['40', '40-yd', '40yd', 'forty', '40_yard', '40 yard', '40 time', '40-yard', '40 dash'],
  pro_agility: ['pro agility', 'pro_agility', 'shuttle', 'agility', '5-10-5', 'pro agility shuttle', 'shuttle_5_10_5'],
  vertical:    ['vertical', 'vert', 'vertical jump', 'vertical_jump', 'vert jump', 'vj'],
  broad:       ['broad', 'broad jump', 'broad_jump', 'standing broad', 'standing broad jump', 'sbj'],
};

const COL_META: { key: keyof ColMap; label: string; required: boolean }[] = [
  { key: 'first_name',  label: 'First Name',    required: true  },
  { key: 'last_name',   label: 'Last Name',     required: true  },
  { key: 'dob',         label: 'DOB',           required: true  },
  { key: 'email',       label: 'Email',         required: false },
  { key: 'position',    label: 'Position',      required: false },
  { key: 'forty',       label: '40-Yard Dash',  required: false },
  { key: 'pro_agility', label: 'Pro Agility',   required: false },
  { key: 'vertical',    label: 'Vertical Jump', required: false },
  { key: 'broad',       label: 'Broad Jump',    required: false },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseCSV(raw: string): { headers: string[]; rows: RawRow[] } {
  const text  = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);

  const parseRow = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuote = !inQuote; }
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
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])) as RawRow;
  });
  return { headers, rows };
}

function detectColMap(headers: string[]): ColMap {
  const lower  = headers.map(h => h.toLowerCase().trim());
  const detect = (candidates: string[]): string => {
    for (const c of candidates) {
      const idx = lower.findIndex(h => h === c);
      if (idx !== -1) return headers[idx];
    }
    return NONE;
  };
  return {
    first_name:  detect(COL_ALIASES.first_name),
    last_name:   detect(COL_ALIASES.last_name),
    email:       detect(COL_ALIASES.email),
    dob:         detect(COL_ALIASES.dob),
    position:    detect(COL_ALIASES.position),
    forty:       detect(COL_ALIASES.forty),
    pro_agility: detect(COL_ALIASES.pro_agility),
    vertical:    detect(COL_ALIASES.vertical),
    broad:       detect(COL_ALIASES.broad),
  };
}

function colMapValid(m: ColMap | null): boolean {
  if (!m) return false;
  return m.first_name !== NONE && m.last_name !== NONE && m.dob !== NONE;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-3">
      {children}
    </p>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function EnterpriseImporter() {
  const [events,        setEvents]        = useState<EventOption[]>([]);
  const [selectedEvent, setSelectedEvent] = useState('');
  const [headers,       setHeaders]       = useState<string[]>([]);
  const [rawRows,       setRawRows]       = useState<RawRow[]>([]);
  const [fileName,      setFileName]      = useState('');
  const [colMap,        setColMap]        = useState<ColMap | null>(null);
  const [phase,         setPhase]         = useState<Phase>('idle');
  const [isDragOver,    setIsDragOver]    = useState(false);
  const [logs,          setLogs]          = useState<string[]>([]);
  const [importResult,  setImportResult]  = useState<ImportResult | null>(null);
  const [errorMsg,      setErrorMsg]      = useState('');

  // Mission Z — AI Data Janitor
  const [cleanseRaw,      setCleanseRaw]      = useState('');
  const [cleansing,       setCleansing]       = useState(false);
  const [cleanseError,    setCleanseError]    = useState('');
  const [cleanseWarnings, setCleanseWarnings] = useState<string[]>([]);

  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const addLog = useCallback((msg: string, type: 'info' | 'ok' | 'err' | 'warn' = 'info') => {
    const ts = new Date().toISOString().slice(11, 19);
    setLogs(prev => [...prev, `[${ts}] ${type.toUpperCase().padEnd(4)}  ${msg}`]);
  }, []);

  useEffect(() => {
    supabase
      .from('events')
      .select('id, name')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setEvents((data ?? []).map((e: { id: string; name: string }) => ({ id: e.id, name: e.name })));
      });
  }, []);

  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setErrorMsg('Only .csv files are supported.');
      setPhase('error');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      if (!text) { setErrorMsg('Could not read file contents.'); setPhase('error'); return; }
      const { headers: h, rows } = parseCSV(text);
      if (h.length === 0 || rows.length === 0) {
        setErrorMsg('CSV appears empty or has no data rows after the header.');
        setPhase('error');
        return;
      }
      setHeaders(h);
      setRawRows(rows);
      setFileName(file.name);
      setColMap(detectColMap(h));
      setLogs([]);
      setPhase('mapped');
    };
    reader.readAsText(file, 'UTF-8');
  }, []);

  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); }, []);
  const onDragLeave = useCallback(() => setIsDragOver(false), []);
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

  // ───────────────────────────────────────────────────────────────────────
  // Mission Z — AI Cleanse pipeline
  //
  // Posts the messy paste to the `roster-janitor` Edge Function, receives
  // a strict JSON array of normalized rows, then converts those rows back
  // into the importer's RawRow + headers shape so the existing column-
  // mapping + import logic takes over without modification.
  // ───────────────────────────────────────────────────────────────────────
  const handleCleanse = useCallback(async () => {
    const raw = cleanseRaw.trim();
    if (!raw) {
      setCleanseError('Paste a roster first.');
      return;
    }
    setCleansing(true);
    setCleanseError('');
    setCleanseWarnings([]);
    addLog('AI Cleanse: dispatching to roster-janitor edge function…');

    try {
      const { data, error } = await supabase.functions.invoke(
        'roster-janitor',
        { body: { raw } },
      );

      if (error) throw new Error(error.message ?? 'Edge function returned an error.');

      const payload = data as {
        rows:     Array<Record<string, string | number | null>>;
        warnings: string[];
        usage?:   Record<string, number>;
        model?:   string;
      };

      if (!payload?.rows || !Array.isArray(payload.rows) || payload.rows.length === 0) {
        throw new Error('No rows returned from cleanse — paste may not contain athlete data.');
      }

      // Project the structured payload back into the importer's expected
      // RawRow[] / headers[] shape. Header names are chosen so the existing
      // detectColMap() auto-maps them on the first try.
      const canonicalHeaders = ['first_name', 'last_name', 'position', 'forty', 'height_in', 'weight_lb'];
      const projected: RawRow[] = payload.rows.map((r) => {
        const out: RawRow = {};
        for (const h of canonicalHeaders) {
          const v = r[h];
          out[h] = v === null || v === undefined ? '' : String(v);
        }
        return out;
      });

      setHeaders(canonicalHeaders);
      setRawRows(projected);
      setColMap(detectColMap(canonicalHeaders));
      setFileName('ai-cleansed-roster.csv');
      setLogs([]);
      setPhase('mapped');
      setCleanseWarnings(payload.warnings ?? []);

      addLog(
        `Cleansed ${payload.rows.length} row(s) via ${payload.model ?? 'claude'}.`,
        'ok',
      );
      if (payload.usage) {
        const cached = payload.usage.cache_read_input_tokens ?? 0;
        addLog(
          `tokens: in=${payload.usage.input_tokens} out=${payload.usage.output_tokens} cached=${cached}`,
        );
      }
      if (payload.warnings?.length) {
        addLog(`${payload.warnings.length} parse warning(s) — review the table.`, 'warn');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown cleanse failure.';
      setCleanseError(msg);
      addLog(`AI Cleanse failed: ${msg}`, 'err');
    } finally {
      setCleansing(false);
    }
  }, [cleanseRaw, addLog]);

  const handleImport = useCallback(async () => {
    if (!colMap || !selectedEvent || rawRows.length === 0) return;
    setPhase('importing');

    const get = (col: string, row: RawRow): string =>
      col !== NONE ? (row[col] ?? '').trim() : '';
    const num = (v: string): number | undefined => {
      const n = parseFloat(v);
      return isNaN(n) ? undefined : n;
    };

    addLog(`Parsing ${rawRows.length.toLocaleString()} rows from ${fileName}`);
    addLog(`Column mapping validated — required fields ${colMapValid(colMap) ? 'OK' : 'MISSING'}`);

    const records = rawRows.map(row => {
      const rec: Record<string, unknown> = {
        first_name: get(colMap.first_name, row),
        last_name:  get(colMap.last_name, row),
        email:      get(colMap.email, row),
        dob:        get(colMap.dob, row),
        position:   get(colMap.position, row) || 'ATH',
      };
      const drills: Record<string, string> = {
        forty:       colMap.forty,
        pro_agility: colMap.pro_agility,
        vertical:    colMap.vertical,
        broad:       colMap.broad,
      };
      for (const [field, col] of Object.entries(drills)) {
        const v = num(get(col, row));
        if (v !== undefined) rec[field] = v;
      }
      return rec;
    });

    addLog(`Submitting batch to import_legacy_results_batch RPC…`);

    try {
      const { data, error } = await supabase.rpc('import_legacy_results_batch', {
        p_event_id: selectedEvent,
        p_records:  records,
      });

      if (error) throw new Error(error.message ?? 'RPC error');

      const result = data as ImportResult;

      if (!result.success) throw new Error(result.error ?? 'Import failed');

      addLog(`${result.inserted} result(s) inserted across ${result.new_athletes} new athlete stub(s).`, 'ok');
      if (result.errors?.length > 0) addLog(`${result.errors.length} row(s) had errors.`, 'warn');
      addLog(`Complete. All records tagged is_hardware_verified = false.`, 'ok');

      setImportResult(result);
      setPhase('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected error.';
      addLog(`Import failed: ${msg}`, 'err');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [colMap, selectedEvent, rawRows, fileName, addLog]);

  const reset = useCallback(() => {
    setPhase('idle');
    setHeaders([]);
    setRawRows([]);
    setFileName('');
    setColMap(null);
    setImportResult(null);
    setErrorMsg('');
    setLogs([]);
    setCleanseRaw('');
    setCleanseError('');
    setCleanseWarnings([]);
  }, []);

  const isReady   = phase === 'mapped' && !!selectedEvent && colMapValid(colMap);
  const preview   = rawRows.slice(0, 5);
  const showLeft  = phase === 'mapped' || phase === 'importing' || phase === 'done';

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 p-4 lg:p-6 text-white">

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1.5 flex-wrap">
            <div className="p-2 bg-zinc-900 border border-zinc-800 rounded-xl">
              <Database className="w-5 h-5 text-[#c8a200]" />
            </div>
            <h1 className="text-2xl font-black uppercase tracking-tight">Enterprise Importer</h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-[10px] font-black uppercase tracking-[0.15em]">
              <Shield className="w-3 h-3" />
              Unverified Data Only
            </span>
          </div>
          <p className="text-zinc-400 text-[10px] font-black uppercase tracking-[0.2em]">
            Legacy CSV Ingestion — Mission N · All records tagged is_hardware_verified = false
          </p>
        </div>
        {fileName && (
          <button onClick={reset} className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white transition-colors mt-1">
            <X className="w-4 h-4" /> Clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5 items-start">

        {/* ── Left column ─────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Drop zone */}
          {(phase === 'idle' || phase === 'error') && (
            <>
              <div
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`relative border-2 border-dashed rounded-2xl p-14 flex flex-col items-center justify-center gap-4 transition-all cursor-pointer ${
                  isDragOver
                    ? 'border-[#c8a200]/60 bg-[#c8a200]/5'
                    : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/20'
                }`}
              >
                <label className="absolute inset-0 cursor-pointer" htmlFor="ei-csv-input" />
                <input
                  id="ei-csv-input"
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={onFileInput}
                />
                <div className={`p-4 rounded-2xl border transition-colors ${isDragOver ? 'border-[#c8a200]/30 bg-[#c8a200]/10' : 'border-zinc-800 bg-zinc-900'}`}>
                  <Upload className={`w-10 h-10 ${isDragOver ? 'text-[#c8a200]' : 'text-zinc-400'}`} />
                </div>
                <div className="text-center pointer-events-none">
                  <p className="text-white font-black text-sm">
                    {isDragOver ? 'Release to load' : 'Drop athlete CSV here or click to browse'}
                  </p>
                  <p className="text-zinc-400 text-xs mt-1 font-mono">
                    Required: First Name · Last Name · DOB · at least one drill column
                  </p>
                </div>
              </div>

              {phase === 'error' && errorMsg && (
                <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-red-300 text-xs font-mono whitespace-pre-wrap">{errorMsg}</p>
                  <button onClick={reset} className="ml-auto text-zinc-400 hover:text-white shrink-0">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* ── AI Cleanse panel (Mission Z) ──────────────────────────── */}
              <details className="bg-zinc-900 border border-zinc-800 rounded-2xl group" open>
                <summary className="cursor-pointer list-none px-5 py-4 flex items-center gap-3 select-none">
                  <div className="p-2 bg-[#c8a200]/10 border border-[#c8a200]/30 rounded-xl">
                    <Sparkles className="w-4 h-4 text-[#c8a200]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-black text-sm">AI Cleanse</p>
                    <p className="text-[10px] text-zinc-500 font-mono mt-0.5">
                      Paste any messy roster — Claude normalizes it into the strict importer schema.
                    </p>
                  </div>
                  <span className="text-[9px] text-zinc-400 font-mono uppercase tracking-widest hidden sm:inline">
                    Mission Z
                  </span>
                </summary>

                <div className="px-5 pb-5 space-y-3">
                  <textarea
                    value={cleanseRaw}
                    onChange={(e) => setCleanseRaw(e.target.value)}
                    disabled={cleansing}
                    placeholder={
                      'Paste anything — comma, tab, or space delimited. Misspellings + missing columns OK.\n\n' +
                      'Smith, John, QB, 6-2, 195, 4.6\n' +
                      'Doe Jane WR 5-10 175 4.5\n' +
                      'Garcia,Luis,RB,5\'9",185,4.78'
                    }
                    rows={6}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-[#c8a200]/30 focus:border-[#c8a200]/30 resize-y"
                  />

                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-[10px] text-zinc-400 font-mono">
                      {cleanseRaw.length.toLocaleString()} chars · max 200,000
                    </p>
                    <button
                      onClick={handleCleanse}
                      disabled={cleansing || cleanseRaw.trim().length === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-[#c8a200] hover:bg-[#e0b900] disabled:bg-zinc-800 disabled:text-zinc-400 disabled:cursor-not-allowed text-black font-black text-xs uppercase tracking-[0.15em] rounded-xl transition-colors"
                    >
                      {cleansing ? (
                        <><Loader2 className="w-3.5 h-3.5 animate-spin" />Cleansing…</>
                      ) : (
                        <><Sparkles className="w-3.5 h-3.5" />Cleanse</>
                      )}
                    </button>
                  </div>

                  {cleanseError && (
                    <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                      <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                      <p className="text-red-300 text-xs font-mono">{cleanseError}</p>
                    </div>
                  )}
                </div>
              </details>
              {/* ── /AI Cleanse panel ──────────────────────────────────────── */}

              {/* Expected columns card */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                <Label>Expected CSV Columns</Label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {COL_META.map(({ key, label, required }) => (
                    <div key={key} className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs ${
                      required
                        ? 'bg-zinc-950 border-zinc-700 text-zinc-300'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400'
                    }`}>
                      <span className={required ? 'text-[#c8a200] font-black' : 'text-zinc-700'}>
                        {required ? '✓' : '·'}
                      </span>
                      <span className="font-mono">{label}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-zinc-700 mt-3 font-mono">
                  One athlete per row · Multiple drills per row · Flexible header aliases accepted
                </p>
              </div>
            </>
          )}

          {/* File info + column mapping */}
          {showLeft && colMap !== null && (
            <>
              {cleanseWarnings.length > 0 && (
                <div className="bg-amber-500/5 border border-amber-500/30 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-[#c8a200] shrink-0" />
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#c8a200]">
                      AI Cleanse — {cleanseWarnings.length} parse warning{cleanseWarnings.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <ul className="space-y-1 max-h-32 overflow-auto">
                    {cleanseWarnings.map((w, i) => (
                      <li key={i} className="text-[11px] text-amber-200 font-mono flex gap-2">
                        <span className="text-zinc-400 shrink-0">·</span>
                        <span className="break-words">{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
                <div className="flex items-center gap-3 mb-5">
                  <FileText className="w-5 h-5 text-[#c8a200] shrink-0" />
                  <div className="min-w-0">
                    <p className="text-white text-sm font-bold truncate">{fileName}</p>
                    <p className="text-zinc-400 text-xs font-mono mt-0.5">
                      {rawRows.length.toLocaleString()} rows · {headers.length} columns
                    </p>
                  </div>
                </div>

                <Label>Column Mapping</Label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {COL_META.map(({ key, label, required }) => {
                    const mapped = colMap[key] !== NONE;
                    return (
                      <div
                        key={key}
                        className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                          mapped
                            ? 'bg-emerald-950/40 border-emerald-800/40 text-emerald-400'
                            : required
                              ? 'bg-red-950/40 border-red-800/40 text-red-400'
                              : 'bg-zinc-950 border-zinc-800 text-zinc-400'
                        }`}
                      >
                        {mapped
                          ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          : required
                            ? <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            : <div className="w-3.5 h-3.5 rounded-full border border-zinc-700 shrink-0" />
                        }
                        <span className="truncate">{label}</span>
                      </div>
                    );
                  })}
                </div>

                {!colMapValid(colMap) && (
                  <div className="mt-4 flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    <p className="text-amber-300 text-xs font-bold">
                      CSV must contain First Name, Last Name, and DOB columns to proceed.
                    </p>
                  </div>
                )}
              </div>

              {/* Preview table */}
              {preview.length > 0 && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                  <div className="px-5 py-3 border-b border-zinc-800">
                    <Label>Preview — first {preview.length} rows</Label>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="border-b border-zinc-800">
                          {headers.map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-black uppercase tracking-wide text-zinc-400 whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                            {headers.map(h => (
                              <td key={h} className="px-4 py-2.5 text-zinc-400 font-mono whitespace-nowrap max-w-[140px] truncate">
                                {row[h] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rawRows.length > 5 && (
                      <p className="px-4 py-2.5 text-[10px] text-zinc-700 border-t border-zinc-800 font-mono">
                        …and {(rawRows.length - 5).toLocaleString()} more rows not shown
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Done — stats bento */}
          {phase === 'done' && importResult && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-emerald-950/60 border border-emerald-800/40 rounded-xl">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <p className="text-white font-black">Batch Import Complete</p>
                  <p className="text-zinc-400 text-xs font-mono mt-0.5">
                    All records → is_hardware_verified = false · source_type = imported_csv
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {([
                  ['Results Inserted', importResult.inserted,              'text-emerald-400'],
                  ['New Athletes',     importResult.new_athletes,          'text-[#c8a200]'],
                  ['Rows Processed',   importResult.total,                 'text-zinc-300'],
                  ['Errors',           importResult.errors?.length ?? 0,   importResult.errors?.length > 0 ? 'text-red-400' : 'text-zinc-700'],
                ] as const).map(([label, val, color]) => (
                  <div key={label} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                    <p className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-400 mb-1">{label}</p>
                    <p className={`text-3xl font-black tabular-nums ${color}`}>{val}</p>
                  </div>
                ))}
              </div>

              {importResult.errors?.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {importResult.errors.map((e, i) => (
                    <div key={i} className="flex gap-2 text-xs bg-red-950/30 border border-red-800/30 rounded-lg px-3 py-1.5">
                      <span className="text-red-400 font-black shrink-0">Row {e.row}</span>
                      <span className="text-zinc-500">{e.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Log panel */}
          {logs.length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#c8a200] shrink-0" />
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500 flex-1">
                  Processing Log
                </p>
                {phase === 'importing' && (
                  <Loader2 className="w-3.5 h-3.5 text-[#c8a200] animate-spin" />
                )}
              </div>
              <div ref={logRef} className="p-4 max-h-52 overflow-y-auto space-y-0.5">
                {logs.map((line, i) => (
                  <p
                    key={i}
                    className={`text-[11px] font-mono leading-relaxed ${
                      line.includes(' ERR ') ? 'text-red-400' :
                      line.includes(' OK  ') ? 'text-emerald-400' :
                      line.includes(' WARN') ? 'text-amber-400' :
                      'text-zinc-500'
                    }`}
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Right sidebar ────────────────────────────────────────────────── */}
        <div className="space-y-4 xl:sticky xl:top-4">

          {/* Event selector */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
            <Label>Target Event</Label>
            {events.length === 0 ? (
              <p className="text-zinc-400 text-xs font-mono">Loading events…</p>
            ) : (
              <select
                value={selectedEvent}
                onChange={e => setSelectedEvent(e.target.value)}
                disabled={phase === 'importing'}
                className="w-full bg-zinc-950 border border-zinc-700 text-white text-sm rounded-xl px-3 py-2.5 focus:outline-none focus:border-[#c8a200]/60 focus:ring-1 focus:ring-[#c8a200]/20 transition-colors disabled:opacity-40"
              >
                <option value="">— select event —</option>
                {events.map(ev => (
                  <option key={ev.id} value={ev.id}>{ev.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Action button */}
          <button
            onClick={phase === 'done' ? reset : handleImport}
            disabled={phase === 'importing' || (phase !== 'done' && !isReady)}
            className={`w-full py-4 rounded-2xl text-sm font-black uppercase tracking-widest transition-all active:scale-95 ${
              phase === 'done'
                ? 'bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700'
                : isReady
                  ? 'bg-[#c8a200] hover:bg-[#b89200] text-zinc-950 shadow-lg shadow-[#c8a200]/15'
                  : 'bg-zinc-900 text-zinc-700 border border-zinc-800 cursor-not-allowed'
            }`}
          >
            {phase === 'importing' ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Processing…
              </span>
            ) : phase === 'done' ? (
              'Import Another File'
            ) : (
              `Process Batch (${rawRows.length.toLocaleString()} rows)`
            )}
          </button>

          {/* Verification lock notice */}
          <div className="bg-amber-500/5 border border-amber-500/15 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4 text-amber-500 shrink-0" />
              <p className="text-amber-400 text-[10px] font-black uppercase tracking-[0.2em]">
                Verification Lock
              </p>
            </div>
            <ul className="space-y-2">
              {[
                'All imported results are permanently tagged is_hardware_verified = false.',
                'Legacy data is excluded from college exports and ARMS scout reports.',
                'Duplicate athletes matched by name or email within the same event.',
                'New athlete stubs created with placeholder contact info.',
                'source_type = imported_csv is applied to every result row.',
              ].map((note, i) => (
                <li key={i} className="flex gap-2 text-[10px] text-amber-200/35">
                  <span className="text-amber-600 shrink-0 mt-px">·</span>
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
