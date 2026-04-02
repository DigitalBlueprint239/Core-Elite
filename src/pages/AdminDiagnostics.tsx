import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { motion } from 'motion/react';
import { 
  Activity, 
  Database, 
  ShieldAlert, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle,
  Server,
  Key,
  ArrowLeft
} from 'lucide-react';

interface TableStatus {
  name: string;
  exists: boolean | null;
  error: string | null;
}

export default function AdminDiagnostics() {
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'ok' | 'failed'>('checking');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tableStatuses, setTableStatuses] = useState<TableStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const requiredTables = [
    'events',
    'athletes',
    'bands',
    'waivers',
    'stations',
    'results',
    'token_claims',
    'profiles',
    'report_jobs',
    'device_status',
    'incidents',
    'parent_portals'
  ];

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const maskedUrl = supabaseUrl ? `${supabaseUrl.substring(0, 12)}...${supabaseUrl.substring(supabaseUrl.length - 8)}` : 'Missing';

  useEffect(() => {
    runDiagnostics();
  }, []);

  async function runDiagnostics() {
    setLoading(true);
    
    // 1. Check Connection
    try {
      const { data, error } = await supabase.rpc('get_service_status').limit(1);
      // Fallback if RPC doesn't exist
      if (error && error.code === 'P0001') {
         // RPC failed, try simple select
      }
      
      const { error: pingError } = await supabase.from('events').select('id').limit(1);
      if (pingError && pingError.code === 'PGRST116') {
        // Table not found is still a "connection ok" but "schema failed"
        setConnectionStatus('ok');
      } else if (pingError && pingError.message.includes('fetch')) {
        setConnectionStatus('failed');
        setConnectionError(pingError.message);
      } else {
        setConnectionStatus('ok');
      }
    } catch (err: any) {
      setConnectionStatus('failed');
      setConnectionError(err.message);
    }

    // 2. Check Tables
    const statuses: TableStatus[] = [];
    for (const table of requiredTables) {
      try {
        const { error } = await supabase.from(table).select('*').limit(1);
        if (error) {
          if (error.code === '42P01') { // undefined_table
            statuses.push({ name: table, exists: false, error: 'Table not found in schema cache.' });
          } else if (error.code === '42501') { // insufficient_privilege
            statuses.push({ name: table, exists: true, error: 'RLS Blocked: Insufficient privileges.' });
          } else {
            statuses.push({ name: table, exists: null, error: error.message });
          }
        } else {
          statuses.push({ name: table, exists: true, error: null });
        }
      } catch (err: any) {
        statuses.push({ name: table, exists: null, error: err.message });
      }
    }
    setTableStatuses(statuses);
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
            <p className="text-zinc-500">Infrastructure and database health check</p>
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
          {/* Connection Status */}
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
                  <span className={`text-sm font-bold ${
                    connectionStatus === 'ok' ? 'text-emerald-600' : 
                    connectionStatus === 'failed' ? 'text-red-600' : 'text-zinc-400'
                  }`}>
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

          {/* Environment Variables */}
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
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-zinc-900">{table.name}</span>
                  {table.exists === true && !table.error && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                  {table.exists === false && <XCircle className="w-4 h-4 text-red-500" />}
                  {table.error?.includes('RLS') && <ShieldAlert className="w-4 h-4 text-amber-500" />}
                </div>
                {table.error && (
                  <p className={`text-[10px] font-medium leading-tight ${
                    table.exists === false ? 'text-red-600' : 'text-amber-600'
                  }`}>
                    {table.error}
                  </p>
                )}
              </div>
            ))}
          </div>

          {tableStatuses.some(t => t.exists === false) && (
            <div className="p-6 bg-red-50 border border-red-100 rounded-2xl space-y-3">
              <div className="flex items-center gap-2 text-red-700 font-bold">
                <AlertTriangle className="w-5 h-5" />
                Action Required: Schema Mismatch
              </div>
              <p className="text-sm text-red-600">
                One or more required tables are missing from your Supabase project. 
                Please run the <code>supabase_schema.sql</code> and <code>module1_migration.sql</code> scripts in your Supabase SQL Editor.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EnvVarCheck({ name, value }: { name: string, value: string | undefined }) {
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
