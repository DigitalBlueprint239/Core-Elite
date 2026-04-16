/**
 * verify-schema.mjs
 * Core Elite — Migration Schema Verification
 *
 * Connects to the live Supabase Postgres database and confirms that
 * migrations 018 and 019 applied correctly.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgres://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
 *     node scripts/verify-schema.mjs
 *
 * Or with the service role key (REST-based checks):
 *   SUPABASE_URL=https://iabyfawsaovoakzqxrde.supabase.com \
 *   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> \
 *     node scripts/verify-schema.mjs
 */

import { createClient } from '@supabase/supabase-js';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL         || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
  console.error('Example:');
  console.error('  SUPABASE_URL=https://iabyfawsaovoakzqxrde.supabase.com \\');
  console.error('  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \\');
  console.error('    node scripts/verify-schema.mjs');
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Checks ────────────────────────────────────────────────────────────────────

const checks = [];

async function columnExists(table, column) {
  const { data, error } = await supabase.rpc('exec_sql_verify', {
    sql: `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`
  }).single();

  if (error) {
    // Fallback: try direct information_schema query via PostgREST
    // PostgREST exposes information_schema if enabled, otherwise we use a workaround
    const { data: d2, error: e2 } = await supabase
      .from('information_schema.columns')
      .select('column_name')
      .eq('table_name', table)
      .eq('column_name', column);

    if (e2) return null; // Can't determine — no access
    return Array.isArray(d2) && d2.length > 0;
  }

  return data?.cnt > 0;
}

async function tableExists(table) {
  // Use a SELECT 1 FROM <table> LIMIT 0 — succeeds if table exists, errors if not
  const { error } = await supabase.from(table).select('id').limit(0);
  if (error && error.code === '42P01') return false; // relation does not exist
  if (error && error.message?.includes('does not exist')) return false;
  return true;
}

// ── Run verification ──────────────────────────────────────────────────────────

let pass = true;
const results = [];

function check(label, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) pass = false;
  results.push({ status, label, detail });
}

async function main() {
  console.log('\nCore Elite — Schema Verification');
  console.log(`Target: ${SUPABASE_URL}`);
  console.log('─'.repeat(60));

  // ── Migration 018 checks ──

  // 1. capture_telemetry table
  const ct = await tableExists('capture_telemetry');
  check('capture_telemetry table exists', ct,
    ct ? 'Table is accessible' : 'Table not found — 018 may not have run');

  // 2. result_provenance table
  const rp = await tableExists('result_provenance');
  check('result_provenance table exists', rp,
    rp ? 'Table is accessible' : 'Table not found — 018 may not have run');

  // 3. results.device_timestamp column
  // We verify this indirectly by trying to select it
  const { error: dtErr } = await supabase
    .from('results')
    .select('device_timestamp')
    .limit(1);
  const hasDeviceTs = !dtErr || !dtErr.message?.includes('device_timestamp');
  check('results.device_timestamp column exists', hasDeviceTs,
    hasDeviceTs ? 'Column is selectable' : `Column missing: ${dtErr?.message}`);

  // ── Migration 019 checks ──

  // 4. results.verification_hash column
  const { error: vhErr } = await supabase
    .from('results')
    .select('verification_hash')
    .limit(1);
  const hasVHash = !vhErr || !vhErr.message?.includes('verification_hash');
  check('results.verification_hash column exists', hasVHash,
    hasVHash ? 'Column is selectable' : `Column missing: ${vhErr?.message}`);

  // 5. results.source_type column
  const { error: stErr } = await supabase
    .from('results')
    .select('source_type')
    .limit(1);
  const hasSourceType = !stErr || !stErr.message?.includes('source_type');
  check('results.source_type column exists', hasSourceType,
    hasSourceType ? 'Column is selectable' : `Column missing: ${stErr?.message}`);

  // 6. capture_telemetry.clock_offset_ms column
  const { error: coErr } = await supabase
    .from('capture_telemetry')
    .select('clock_offset_ms')
    .limit(1);
  const hasClockOffset = !coErr || !coErr.message?.includes('clock_offset_ms');
  check('capture_telemetry.clock_offset_ms column exists', hasClockOffset,
    hasClockOffset ? 'Column is selectable' : `Column missing: ${coErr?.message}`);

  // 7. capture_telemetry.rtt_ms column
  const { error: rttErr } = await supabase
    .from('capture_telemetry')
    .select('rtt_ms')
    .limit(1);
  const hasRttMs = !rttErr || !rttErr.message?.includes('rtt_ms');
  check('capture_telemetry.rtt_ms column exists', hasRttMs,
    hasRttMs ? 'Column is selectable' : `Column missing: ${rttErr?.message}`);

  // 8. export_verified_results RPC exists
  const { error: rpcErr } = await supabase.rpc('export_verified_results', {
    p_athlete_id: null,
    p_session_id: null,
  });
  // A 406 or 400 "no rows" is acceptable — means the function exists but returned nothing
  const rpcExists = !rpcErr ||
    rpcErr.code === 'PGRST116' ||     // 0 rows — function exists
    !rpcErr.message?.includes('could not find the function');
  check('export_verified_results RPC exists', rpcExists,
    rpcExists
      ? (rpcErr ? `Function exists (returned: ${rpcErr.code})` : 'Function callable')
      : `RPC not found: ${rpcErr?.message}`);

  // ── Output ──

  console.log('');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  ${icon} [${r.status}] ${r.label}`);
    if (r.status === 'FAIL') console.log(`         → ${r.detail}`);
  }

  console.log('');
  if (pass) {
    console.log('SCHEMA VERIFICATION: PASS');
    console.log('All 8 checks passed. Migrations 018 and 019 are applied.');
  } else {
    const failed = results.filter(r => r.status === 'FAIL').map(r => r.label);
    console.log('SCHEMA VERIFICATION: FAIL');
    console.log('Failed checks:');
    failed.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
