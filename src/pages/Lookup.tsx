import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Search, Phone, CreditCard, AlertCircle, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BRAND } from '../lib/brand';

interface LookupResult {
  first_name:  string;
  last_name:   string;
  position:    string;
  band_number: number | null;
  event_name:  string;
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 3)  return digits;
  if (digits.length <= 6)  return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

export default function Lookup() {
  const [phone, setPhone]         = useState('');
  const [results, setResults]     = useState<LookupResult[] | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [searched, setSearched]   = useState(false);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) {
      setError('Please enter a complete 10-digit phone number.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);
    setSearched(false);

    try {
      // Query athletes by parent_phone — join to bands for wristband number
      // and events for event context. Only return today's or active events.
      const { data, error: dbErr } = await supabase
        .from('athletes')
        .select(`
          first_name, last_name, position,
          bands(display_number),
          events(name, status, event_date)
        `)
        .eq('parent_phone', digits)
        .in('events.status', ['active', 'complete', 'draft'])
        .order('created_at', { ascending: false })
        .limit(5);

      if (dbErr) throw dbErr;

      const mapped: LookupResult[] = (data ?? []).map((a: any) => ({
        first_name:  a.first_name,
        last_name:   a.last_name,
        position:    a.position ?? '',
        band_number: a.bands?.display_number ?? null,
        event_name:  a.events?.name ?? 'Unknown Event',
      }));

      setResults(mapped);
    } catch (err: any) {
      setError('Lookup unavailable. Please ask event staff for assistance.');
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  const digits = phone.replace(/\D/g, '');

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md mb-8">
        <Link
          to="/"
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <img
            src={BRAND.logo}
            alt="Core Elite"
            className="w-12 h-12 mx-auto mb-4 opacity-80"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <h1 className="text-3xl font-black uppercase italic tracking-tighter">
            Find Your Athlete
          </h1>
          <p className="text-zinc-500 mt-1 text-sm">
            Enter the parent phone number used at registration to look up wristband information.
          </p>
        </div>

        {/* Search form */}
        <form onSubmit={handleLookup} className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
              <Phone className="w-3.5 h-3.5" />
              Parent / Guardian Phone Number
            </label>
            <input
              type="tel"
              inputMode="numeric"
              placeholder="(555) 555-5555"
              value={phone}
              onChange={e => {
                setError(null);
                setSearched(false);
                const formatted = formatPhone(e.target.value);
                // Cap at formatted length for 10 digits
                if (e.target.value.replace(/\D/g, '').length <= 10) {
                  setPhone(formatted);
                }
              }}
              className="w-full px-4 py-3.5 bg-zinc-50 border border-zinc-200 rounded-2xl text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-zinc-900 transition-all placeholder-zinc-300"
            />
            {error && (
              <p className="flex items-center gap-1.5 text-sm text-red-600 font-medium">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || digits.length !== 10}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold text-sm uppercase tracking-wider hover:bg-zinc-800 active:scale-[0.98] transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Looking up...
              </>
            ) : (
              <>
                <Search className="w-4 h-4" />
                Find Athlete
              </>
            )}
          </button>

          <p className="text-[10px] text-zinc-400 text-center leading-relaxed">
            We only show wristband number and athlete name. Full results are sent to the registered parent email.
          </p>
        </form>

        {/* Results */}
        {searched && results !== null && (
          <div className="bg-white rounded-3xl border border-zinc-200 shadow-xl overflow-hidden">
            {results.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <AlertCircle className="w-8 h-8 text-zinc-300 mx-auto" />
                <p className="font-bold text-zinc-600">No athlete found</p>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  No registration found for this phone number. If you believe this is an error, please visit the registration table for assistance.
                </p>
              </div>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-zinc-100 bg-zinc-50">
                  <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                    {results.length} Athlete{results.length !== 1 ? 's' : ''} Found
                  </p>
                </div>
                <div className="divide-y divide-zinc-100">
                  {results.map((r, i) => (
                    <div key={i} className="px-6 py-5 flex items-center gap-4">
                      <div className="w-12 h-12 bg-zinc-900 rounded-2xl flex items-center justify-center shrink-0">
                        <CreditCard className="w-5 h-5 text-white" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-black text-lg leading-tight">
                          {r.first_name} {r.last_name}
                        </p>
                        <p className="text-sm text-zinc-500">
                          {r.position} · {r.event_name}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-400 mb-0.5">
                          Wristband
                        </p>
                        <p className="text-3xl font-black font-mono tabular-nums text-zinc-900 leading-none">
                          {r.band_number ?? '—'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="px-6 py-4 bg-emerald-50 border-t border-emerald-100 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <p className="text-xs text-emerald-700 font-medium">
                    Found your wristband number? Head to your assigned station to begin testing.
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* Fallback guidance */}
        {!searched && (
          <div className="bg-white px-6 py-5 rounded-2xl border border-zinc-100 text-center">
            <p className="text-xs text-zinc-400 leading-relaxed">
              Can't remember the phone number used? Visit the <strong className="text-zinc-600">registration table</strong> on event day and staff can assist you.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
