import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion } from 'motion/react';
import {
  Activity,
  Database,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Server,
  Key,
  ArrowLeft,
  Shield,
  Columns,
} from 'lucide-react';

interface TableStatus {
  name: string;
  exists: boolean | null;
  error: string | null;
}

interface ColumnStatus {
  table: string;
  column: string;
  exists: boolean | null;
}

interface RpcStatus {
  name: string;
  installed: boolean | null;
}

export default function AdminDiagnostics() {
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'ok' | 'failed'>('checking');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tableStatuses, setTableStatuses] = useState<TableStatus[]>([]);
  const [columnStatuses, setColumnStatuses] = useState<ColumnStatus[]>([]);
  const [rpcStatuses, setRpcStatuses] = useState<RpcStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const requiredTables = [
    'events', 'athletes', 'bands', 'waivers', 'stations',
    'results', 'token_claims', 'profiles', 'report_jobs',
    'device_status', 'incidents', 'parent_portals',
  ];

  const criticalColumns = [
    { table: 'results',  column: 'client_result_id' },
    { table: 'results',  column: 'voided' },
    { table: 'athletes', column: 'band_id' },
    { table: 'bands',    column: 'athlete_id' },
    { table: 'incidents',column: 'station_id' },
  ];

  const securityRpcs = [
    'register_athlete_secure',
    'claim_band_atomic',
    'submit_result_secure',
  ];

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const maskedUrl = supabaseUrl
    ? `${supabaseUrl.substring(0, 12)}...${supabaseUrl.substring(supabaseUrl.length - 8)}`
    : 'Missing';

  useEffect(() => { runDiagnostics(); }, []);

  async function runDiagnostics() {
    setLoading(true);

    // 1. Connection
    try {
      const { error: pingError } = await supabase.from('events').select('id').limit(1);
      if (pingError && pingError.message.includes('fetch')) {
        setConnectionStatus('failed');
        setConnectionError(pingError.message);
      } else {
        setConnectionStatus('ok');
      }
    } catch (err: any) {
      setConnectionStatus('failed');
      setConnectionError(err.message);
    }

    // 2. Tables
    const tableResults: TableStatus[] = [];
    for (const table of requiredTables) {
      try {
        const { error } = await supabase.from(table).select('*').limit(1);
        if (error) {
          if (error.code === '42P01') {
            tableResults.push({ name: table, exists: false, error: 'Table not found in schema cache.' });
          } else if (error.code === '42501') {
            tableResults.push({ name: table, exists: true, error: 'RLS Blocked: Insufficient privileges.' });
          } else {
            tableResults.push({ name: table, exists: null, error: error.message });
          }
        } else {
          tableResults.push({ name: table, exists: true, error: null });
        }
      } catch (err: any) {
        tableResults.push({ name: table, exists: null, error: err.message });
      }
    }
    setTableStatuses(tableResults);

    // 3. Critical columns — probe each with a .select(column).limit(0)
    //    If the error mentions "column" or "does not exist", it's missing.
    const colResults: ColumnStatus[] = [];
    for (const { table, column } of criticalColumns) {
      try {
        const { error } = await (supabase.from(table) as any).select(column).limit(0);
        if (error) {
          const msg = error.message?.toLowerCase() || '';
          const isMissing = msg.includes('column') || msg.includes('does not exist') || error.code === '42703';
          colResults.push({ table, column, exists: isMissing ? false : null });
        } else {
          colResults.push({ table, column, exists: true });
        }
      } catch {
        colResults.push({ table, column, exists: null });
      }
    }
    setColumnStatuses(colResults);

    // 4. Security RPCs — call with empty args; if error is "missing required param"
    //    (not "function does not exist"), the RPC is installed.
    const rpcResults: RpcStatus[] = [];
    for (const rpcName of securityRpcs) {
      try {
        const { error } = await supabase.rpc(rpcName, {});
        if (error) {
          const msg = error.message?.toLowerCase() || '';
          // "function does not exist" → not installed
          // any other error (wrong params, etc.) → installed
          const notFound = msg.includes('does not exist') || msg.includes('could not find');
          rpcResults.push({ name: rpcName, installed: !notFound });
        } else {
          rpcResults.push({ name: rpcName, installed: true });
        }
      } catch {
        rpcResults.push({ name: rpcName, installed: null });
      }
    }
    setRpcStatuses(rpcResults);

    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="mb-4">
          <Link
            to="/"
            className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>

        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black uppercase italic tracking-tighter flex items-center gap-3">
              <Activity className="w-8 h-8 text-zinc-900" />
              System Diagnostics
            </h1>
            <p className="text-zinc-500">Infrastructure, database, and security health check</p>
          </div>
          <button
            onClick={runDiagnostics}
            disabled={loading}
            className="px-4 py-2 bg-zinc-900 text-white rounded-xl font-bold text-sm hover:bg-zinc-800 transition-all disabled:opacity-50"
          >
            {loading ? 'Running...' : 'Run Again'}
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Connection */}
          <section className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Server className="w-5 h-5 text-zinc-400" />
              Supabase Connection
            </h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl">
                <span className="text-xs font-bold uppercase text-zinc-500">Status</span>
                <div className="flex items-center gap-2">
                  {connectionStatus === 'checking' && <div className="w-4 h-4 border-2 border-zinc-900 border-t-transparent rounded-full animate-spin" />}
                  {connectionStatus === 'ok' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
                  {connectionStatus === 'failed' && <XCircle className="w-5 h-5 text-red-500" />}
                  <span className={`text-sm font-bold ${connectionStatus === 'ok' ? 'text-emerald-600' : connectionStatus === 'failed' ? 'text-red-600' : 'text-zinc-400'}`}>
                    {connectionStatus.toUpperCase()}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl">
                <span className="text-xs font-bold uppercase text-zinc-500">Endpoint</span>
                <span className="text-xs font-mono text-zinc-400">{maskedUrl}</span>
              </div>
              {connectionError && (
                <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs text-red-600 font-mono">
                  {connectionError}
                </div>
              )}
            </div>
          </section>

          {/* Environment */}
          <section className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <Key className="w-5 h-5 text-zinc-400" />
              Environment Config
            </h2>
            <div className="space-y-2">
              <EnvVarCheck name="VITE_SUPABASE_URL" value={import.meta.env.VITE_SUPABASE_URL} />
              <EnvVarCheck name="VITE_SUPABASE_ANON_KEY" value={import.meta.env.VITE_SUPABASE_ANON_KEY} />
            </div>
          </section>
        </div>

        {/* Table Status */}
        <section className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm space-y-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Database className="w-6 h-6 text-zinc-400" />
            Database Schema Health
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {tableStatuses.map(table => (
              <div key={table.name} className={`p-4 rounded-2xl border transition-all ${
                table.exists === true && !table.error ? 'bg-emerald-50/30 border-emerald-100' :
                table.exists === false ? 'bg-red-50/30 border-red-100' :
                table.error?.includes('RLS') ? 'bg-amber-50/30 border-amber-100' :
                'bg-zinc-50 border-zinc-100'
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-zinc-900 text-sm">{table.name}</span>
                  {table.exists === true && !table.error && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                  {table.exists === false && <XCircle className="w-4 h-4 text-red-500" />}
                  {table.error?.includes('RLS') && <ShieldAlert className="w-4 h-4 text-amber-500" />}
                </div>
                {table.error && (
                  <p className={`text-[10px] font-medium leading-tight ${table.exists === false ? 'text-red-600' : 'text-amber-600'}`}>
                    {table.error}
                  </p>
                )}
              </div>
            ))}
          </div>
          {tableStatuses.some(t => t.exists === false) && (
            <div className="p-6 bg-red-50 border border-red-100 rounded-2xl space-y-2">
              <div className="flex items-center gap-2 text-red-700 font-bold">
                <AlertTriangle className="w-5 h-5" />
                Action Required: Schema Mismatch
              </div>
              <p className="text-sm text-red-600">
                One or more required tables are missing. Run <code>supabase_schema.sql</code> and the migrations in order in your Supabase SQL Editor.
              </p>
            </div>
          )}
        </section>

        {/* Critical Column Validation */}
        <section className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm space-y-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Columns className="w-6 h-6 text-zinc-400" />
            Critical Column Validation
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {columnStatuses.map(col => (
              <div key={`${col.table}.${col.column}`} className={`p-4 rounded-2xl border flex items-center justify-between ${
                col.exists === true ? 'bg-emerald-50/30 border-emerald-100' :
                col.exists === false ? 'bg-red-50/30 border-red-100' :
                'bg-zinc-50 border-zinc-100'
              }`}>
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{col.table}</span>
                  <div className="font-bold text-sm text-zinc-900">.{col.column}</div>
                </div>
                {col.exists === true && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                {col.exists === false && <XCircle className="w-4 h-4 text-red-500 shrink-0" />}
                {col.exists === null && <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin shrink-0" />}
              </div>
            ))}
          </div>
          {columnStatuses.some(c => c.exists === false) && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600">
              <strong>Missing columns detected.</strong> Run Phase 2 migrations (007–009) to add <code>hlc_timestamp</code>, <code>attempt_number</code>, and covering indexes.
            </div>
          )}
        </section>

        {/* Security Posture */}
        <section className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-sm space-y-6">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Shield className="w-6 h-6 text-zinc-400" />
            Security Posture
          </h2>
          <p className="text-sm text-zinc-500">
            Verifies that SECURITY DEFINER RPCs are installed. These handle all public-facing mutations — if any are missing, unauthenticated writes may succeed or fail silently.
          </p>
          <div className="space-y-3">
            {rpcStatuses.map(rpc => (
              <div key={rpc.name} className={`p-4 rounded-2xl border flex items-center justify-between ${
                rpc.installed === true ? 'bg-emerald-50/30 border-emerald-100' :
                rpc.installed === false ? 'bg-red-50/30 border-red-100' :
                'bg-zinc-50 border-zinc-100'
              }`}>
                <div className="flex items-center gap-3">
                  {rpc.installed === true && <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />}
                  {rpc.installed === false && <ShieldAlert className="w-5 h-5 text-red-500 shrink-0" />}
                  {rpc.installed === null && <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin shrink-0" />}
                  <div>
                    <div className="font-bold text-sm font-mono text-zinc-900">{rpc.name}()</div>
                    <div className="text-[10px] text-zinc-400 uppercase tracking-wider">SECURITY DEFINER RPC</div>
                  </div>
                </div>
                <span className={`text-xs font-black uppercase tracking-widest ${
                  rpc.installed === true ? 'text-emerald-600' :
                  rpc.installed === false ? 'text-red-600' :
                  'text-zinc-400'
                }`}>
                  {rpc.installed === true ? 'Installed' : rpc.installed === false ? 'Missing' : 'Unknown'}
                </span>
              </div>
            ))}
          </div>
          {rpcStatuses.some(r => r.installed === false) && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600">
              <strong>Critical:</strong> One or more security RPCs are missing. Run <code>hardening_migration.sql</code> and <code>migrations/011_rate_limiting.sql</code> in your Supabase SQL Editor immediately.
            </div>
          )}
          {rpcStatuses.length > 0 && rpcStatuses.every(r => r.installed === true) && (
            <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-3 text-sm text-emerald-700 font-bold">
              <ShieldCheck className="w-5 h-5 shrink-0" />
              All security RPCs installed. Public mutations are protected.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EnvVarCheck({ name, value }: { name: string; value: string | undefined }) {
  return (
    <div className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl">
      <span className="text-[10px] font-bold uppercase text-zinc-500">{name}</span>
      {value ? (
        <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Configured</span>
      ) : (
        <span className="text-[10px] font-black text-red-600 uppercase tracking-widest">Missing</span>
      )}
    </div>
  );
}
