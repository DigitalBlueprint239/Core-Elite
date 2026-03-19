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

export default function ClaimBand() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('athleteToken');

  const [athlete, setAthlete] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // error is always a public-safe string — never a raw DB message
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [assignedBand, setAssignedBand] = useState<any>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [bandNumber, setBandNumber] = useState('');

  useEffect(() => {
    // Missing token — friendly invalid-link message, no technical detail
    if (!token) {
      setError('invalid-link');
      setLoading(false);
      return;
    }

    async function fetchClaim() {
      const { data: claim, error: claimError } = await supabase
        .from('token_claims')
        .select('*, athletes(*)')
        .eq('token_hash', token)
        .single();

      if (claimError) {
        // Log the real error in dev; show only a safe message publicly
        logDevError('fetchClaim › token lookup', claimError);
        setError('invalid-link');
      } else if (!claim) {
        setError('invalid-link');
      } else if (claim.used_at) {
        // Already claimed — safe to tell the user this specific fact
        setError('already-claimed');
      } else if (new Date(claim.expires_at) < new Date()) {
        // Expired — safe to tell the user this specific fact
        setError('expired');
      } else {
        setAthlete(claim.athletes);
      }
      setLoading(false);
    }
    fetchClaim();
  }, [token]);

  const handleClaim = async (bandId: string) => {
    if (success || loading) return;
    setLoading(true);
    setError(null);

    try {
      // 1. Check if band is available
      const { data: band, error: bandError } = await supabase
        .from('bands')
        .select('*')
        .eq('band_id', bandId)
        .single();

      if (bandError || !band) {
        logDevError('handleClaim › band lookup', bandError);
        throw new Error('wristband-not-found');
      }
      if (band.status !== 'available') {
        throw new Error('wristband-unavailable');
      }

      // 2. Update Band
      const { error: updateBandError } = await supabase
        .from('bands')
        .update({
          status: 'assigned',
          athlete_id: athlete.id,
          assigned_at: new Date().toISOString(),
        })
        .eq('band_id', bandId);

      if (updateBandError) {
        logDevError('handleClaim › update band', updateBandError);
        throw new Error('claim-failed');
      }

      // 3. Update Athlete
      const { error: updateAthleteError } = await supabase
        .from('athletes')
        .update({ band_id: bandId })
        .eq('id', athlete.id);

      if (updateAthleteError) {
        logDevError('handleClaim › update athlete', updateAthleteError);
        throw new Error('claim-failed');
      }

      // 4. Mark Token Used
      const { error: tokenError } = await supabase
        .from('token_claims')
        .update({ used_at: new Date().toISOString() })
        .eq('token_hash', token);

      if (tokenError) {
        // Non-fatal: band and athlete are already linked. Log only.
        logDevError('handleClaim › mark token used', tokenError);
      }

      setAssignedBand(band);
      setSuccess(true);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : 'claim-failed';
      // Map internal error codes to public-safe messages
      const publicMessage = CLAIM_ERROR_MESSAGES[code] ?? CLAIM_ERROR_MESSAGES['claim-failed'];
      setError(publicMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bandNumber) return;

    setLoading(true);
    setError(null);

    try {
      const { data: band, error: bandError } = await supabase
        .from('bands')
        .select('*')
        .eq('event_id', athlete.event_id)
        .eq('display_number', parseInt(bandNumber))
        .single();

      if (bandError || !band) {
        logDevError('handleManualSubmit › band lookup', bandError);
        throw new Error('wristband-not-found');
      }

      await handleClaim(band.band_id);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : 'claim-failed';
      const publicMessage = CLAIM_ERROR_MESSAGES[code] ?? CLAIM_ERROR_MESSAGES['claim-failed'];
      setError(publicMessage);
      setLoading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  if (loading && !athlete && !error) {
    return <div className="p-8 text-center text-zinc-500">Verifying session...</div>;
  }

  // -------------------------------------------------------------------------
  // Invalid / expired / already-claimed link screen
  // Shown when there is no valid athlete loaded yet.
  // No DB errors, table names, or stack traces are ever rendered here.
  // -------------------------------------------------------------------------
  if (!athlete && error) {
    const { title, body } = LINK_ERROR_UI[error] ?? LINK_ERROR_UI['invalid-link'];
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
          Inline error banner — shown after a failed claim attempt while the
          athlete is already loaded. Only public-safe messages are rendered.
      ----------------------------------------------------------------------- */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 text-sm"
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">{error}</p>
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
            <p className="text-zinc-500">Athlete #{assignedBand.display_number} is ready for testing.</p>
          </div>

          <div className="p-6 bg-zinc-50 rounded-2xl border border-zinc-100">
            <div className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-1">
              Athlete Number
            </div>
            <div className="text-6xl font-black text-zinc-900">
              {String(assignedBand.display_number).padStart(3, '0')}
            </div>
          </div>

          <button
            onClick={() => navigate('/')}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
          >
            Done — Return Home
          </button>
        </motion.div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error message maps — all values are public-safe strings.
// Internal error codes are never exposed to the UI.
// ---------------------------------------------------------------------------

const CLAIM_ERROR_MESSAGES: Record<string, string> = {
  'wristband-not-found': 'That wristband number was not found for this event.',
  'wristband-unavailable': 'This wristband is already assigned. Please scan a different one.',
  'claim-failed': "We're having trouble right now.",
};

const LINK_ERROR_UI: Record<string, { title: string; body: string }> = {
  'invalid-link': {
    title: 'Invalid or missing link',
    body: 'This claim link is invalid. Please return to registration and try again.',
  },
  'already-claimed': {
    title: 'Wristband already claimed',
    body: 'This registration link has already been used. If you need help, please ask event staff.',
  },
  expired: {
    title: 'Link has expired',
    body: 'This claim link has expired. Please return to registration to receive a new one.',
  },
};
