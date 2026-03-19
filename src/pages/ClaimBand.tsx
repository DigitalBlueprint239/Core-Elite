import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { QRScanner } from '../components/QRScanner';
import { motion } from 'motion/react';
import { QrCode, CheckCircle2, AlertCircle, User, ArrowLeft } from 'lucide-react';

// ---------------------------------------------------------------------------
// Public-safe error constants.
// Technical error details (DB messages, constraint names, table names) are
// intentionally never rendered in the UI. They are logged to the console in
// development mode only.
// ---------------------------------------------------------------------------
const PUBLIC_ERROR_BODY =
  'Please try again in a moment. If the problem continues, ask event staff for help.';

function logDevError(context: string, err: unknown) {
  if (import.meta.env.DEV) {
    console.error(`[ClaimBand] ${context}`, err);
  }
}

// ---------------------------------------------------------------------------
// RPC error code -> public-safe UI message
// Maps the structured codes returned by claim_band_atomic() to friendly text.
// Internal codes are never rendered directly.
// ---------------------------------------------------------------------------
const RPC_ERROR_MESSAGES: Record<string, string> = {
  invalid_token:      'This claim link is invalid. Please return to registration and try again.',
  expired_token:      'This claim link has expired. Please return to registration to receive a new one.',
  token_already_used: 'This registration link has already been used. If you need help, ask event staff.',
  band_not_found:     'That wristband number was not found for this event.',
  band_unavailable:   'This wristband is already assigned. Please scan a different one.',
  athlete_not_found:  "We couldn't locate your athlete record. Please ask event staff for help.",
  claim_failed:       "We're having trouble right now.",
};

// Token-level errors that should show the "invalid link" full-screen state
// rather than an inline banner (because there is no valid athlete loaded yet).
const LINK_LEVEL_CODES = new Set([
  'invalid_token',
  'expired_token',
  'token_already_used',
]);

// ---------------------------------------------------------------------------
// Link error full-screen UI map
// ---------------------------------------------------------------------------
const LINK_ERROR_UI: Record<string, { title: string; body: string }> = {
  invalid_token: {
    title: 'Invalid or missing link',
    body: 'This claim link is invalid. Please return to registration and try again.',
  },
  expired_token: {
    title: 'Link has expired',
    body: 'This claim link has expired. Please return to registration to receive a new one.',
  },
  token_already_used: {
    title: 'Wristband already claimed',
    body: 'This registration link has already been used. If you need help, please ask event staff.',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ClaimBand() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('athleteToken');

  const [athlete, setAthlete] = useState<any>(null);
  // linkError holds a code from LINK_ERROR_UI -- shown before athlete is loaded
  const [linkError, setLinkError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // claimError is an inline public-safe string shown after a failed claim attempt
  const [claimError, setClaimError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [assignedBand, setAssignedBand] = useState<{ display_number: number; band_id: string } | null>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [bandNumber, setBandNumber] = useState('');

  // -------------------------------------------------------------------------
  // On mount: validate the token and load the athlete.
  // This is still a client-side read -- we only need to confirm the token is
  // valid and load the athlete's name for display. The actual mutation is
  // handled by the RPC.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!token) {
      setLinkError('invalid_token');
      setLoading(false);
      return;
    }

    async function fetchClaim() {
      const { data: claim, error: claimErr } = await supabase
        .from('token_claims')
        .select('*, athletes(*)')
        .eq('token_hash', token)
        .single();

      if (claimErr) {
        logDevError('fetchClaim token lookup', claimErr);
        setLinkError('invalid_token');
      } else if (!claim) {
        setLinkError('invalid_token');
      } else if (claim.used_at) {
        setLinkError('token_already_used');
      } else if (new Date(claim.expires_at) < new Date()) {
        setLinkError('expired_token');
      } else {
        setAthlete(claim.athletes);
      }
      setLoading(false);
    }
    fetchClaim();
  }, [token]);

  // -------------------------------------------------------------------------
  // handleClaim -- the single entry point for all claim attempts.
  // Calls claim_band_atomic() which executes all DB mutations in one
  // server-side transaction. If any step fails, the DB rolls back automatically.
  // -------------------------------------------------------------------------
  const handleClaim = async (bandId: string) => {
    if (success || loading) return;
    setLoading(true);
    setClaimError(null);

    try {
      const { data: result, error: rpcError } = await supabase.rpc('claim_band_atomic', {
        p_token: token,
        p_band_id: bandId,
      });

      if (rpcError) {
        // Network-level or Postgres-level error (not an application error)
        logDevError('handleClaim rpc call', rpcError);
        setClaimError(RPC_ERROR_MESSAGES['claim_failed']);
        return;
      }

      // result is the jsonb payload returned by the function
      if (!result?.success) {
        const code: string = result?.code ?? 'claim_failed';
        logDevError('handleClaim rpc returned failure', result);

        if (LINK_LEVEL_CODES.has(code)) {
          // Token became invalid between page load and claim attempt
          // (e.g., another tab used it). Show the full-screen link error.
          setLinkError(code);
          setAthlete(null);
        } else {
          setClaimError(RPC_ERROR_MESSAGES[code] ?? RPC_ERROR_MESSAGES['claim_failed']);
        }
        return;
      }

      // Success
      setAssignedBand({
        band_id: result.band_id,
        display_number: result.display_number,
      });
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // handleManualSubmit -- resolves a display_number to a band_id, then
  // delegates to handleClaim. The band lookup is a read-only SELECT; the
  // mutation still goes through the RPC.
  // -------------------------------------------------------------------------
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bandNumber || !athlete) return;

    setLoading(true);
    setClaimError(null);

    try {
      const { data: band, error: bandError } = await supabase
        .from('bands')
        .select('band_id, display_number, status')
        .eq('event_id', athlete.event_id)
        .eq('display_number', parseInt(bandNumber))
        .single();

      if (bandError || !band) {
        logDevError('handleManualSubmit band lookup', bandError);
        setClaimError(RPC_ERROR_MESSAGES['band_not_found']);
        return;
      }

      // Delegate to handleClaim -- it will call the RPC
      await handleClaim(band.band_id);
    } catch (err: unknown) {
      logDevError('handleManualSubmit unexpected', err);
      setClaimError(RPC_ERROR_MESSAGES['claim_failed']);
    } finally {
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Loading state -- shown while token is being validated on mount
  // -------------------------------------------------------------------------
  if (loading && !athlete && !linkError) {
    return <div className="p-8 text-center text-zinc-500">Verifying session...</div>;
  }

  // -------------------------------------------------------------------------
  // Invalid / expired / already-claimed link screen.
  // Shown when the token is bad before any athlete is loaded.
  // No DB errors, table names, or stack traces are ever rendered here.
  // -------------------------------------------------------------------------
  if (linkError && !athlete) {
    const { title, body } = LINK_ERROR_UI[linkError] ?? LINK_ERROR_UI['invalid_token'];
    return (
      <div className="max-w-md mx-auto px-4 py-16">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-6"
        >
          <div className="w-20 h-20 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-10 h-10" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-2">{title}</h2>
            <p className="text-zinc-500 text-sm">{body}</p>
          </div>

          <div className="space-y-3 pt-4">
            <button
              onClick={() => navigate('/register')}
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
            >
              Return to Registration
            </button>
            <button
              onClick={() => navigate('/')}
              className="w-full py-4 bg-white border border-zinc-200 text-zinc-600 rounded-2xl font-bold hover:bg-zinc-50 transition-all"
            >
              Return Home
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Main claim flow
  // -------------------------------------------------------------------------
  return (
    <div className="max-w-md mx-auto px-4 py-8">
      <div className="mb-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      <header className="text-center mb-8">
        <h1 className="text-3xl font-black uppercase italic tracking-tighter mb-2">
          Claim Wristband
        </h1>
        {athlete && (
          <div className="flex items-center justify-center gap-2 text-zinc-500">
            <User className="w-4 h-4" />
            <span>
              Athlete: <strong>{athlete.first_name} {athlete.last_name}</strong>
            </span>
          </div>
        )}
      </header>

      {/* -----------------------------------------------------------------------
          Inline error banner -- shown after a failed claim attempt while the
          athlete is already loaded. Only public-safe messages are rendered.
      ----------------------------------------------------------------------- */}
      {claimError && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 text-sm"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{claimError}</p>
            <p className="mt-1 text-red-600">{PUBLIC_ERROR_BODY}</p>
          </div>
        </motion.div>
      )}

      {!success ? (
        <div className="space-y-6">
          <div className="bg-zinc-900 text-white p-6 rounded-3xl shadow-xl">
            <div className="flex items-center gap-4 mb-4">
              <div className="p-3 bg-white/10 rounded-xl">
                <QrCode className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold">Scan Wristband QR</h3>
                <p className="text-zinc-400 text-xs">
                  Point your camera at the QR code on the athlete's wristband.
                </p>
              </div>
            </div>
            <QRScanner onScan={handleClaim} />
          </div>

          <div className="space-y-4">
            <button
              onClick={() => setManualEntry(!manualEntry)}
              className="w-full py-3 text-zinc-500 text-sm font-bold hover:text-zinc-900 transition-colors"
            >
              {manualEntry ? 'Hide manual entry' : 'Enter wristband number manually'}
            </button>

            {manualEntry && (
              <motion.form
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                onSubmit={handleManualSubmit}
                className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-4"
              >
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    Wristband Number (1-500)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={bandNumber}
                    onChange={(e) => setBandNumber(e.target.value)}
                    className="w-full p-4 text-2xl font-black bg-zinc-50 border border-zinc-100 rounded-2xl text-center outline-none focus:border-zinc-900"
                    placeholder="000"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={!bandNumber || loading}
                  className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold shadow-lg disabled:opacity-50"
                >
                  {loading ? 'Processing...' : 'Claim Wristband'}
                </button>
              </motion.form>
            )}
          </div>

          <div className="text-center text-zinc-400 text-xs px-8">
            Please ensure the wristband is securely fastened before scanning. This links the
            athlete's identity to their testing number.
          </div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-6"
        >
          <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <div>
            <h2 className="text-2xl font-bold mb-1">Wristband Assigned!</h2>
            <p className="text-zinc-500">Athlete #{assignedBand?.display_number} is ready for testing.</p>
          </div>

          <div className="p-6 bg-zinc-50 rounded-2xl border border-zinc-100">
            <div className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-1">
              Athlete Number
            </div>
            <div className="text-6xl font-black text-zinc-900">
              {String(assignedBand?.display_number ?? '').padStart(3, '0')}
            </div>
          </div>

          <button
            onClick={() => navigate('/')}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
          >
            Done -- Return Home
          </button>
        </motion.div>
      )}
    </div>
  );
        }
