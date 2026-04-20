import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { QRScanner } from '../components/QRScanner';
import { motion } from 'motion/react';
import { QrCode, CheckCircle2, AlertCircle, User, ArrowLeft, Share2, Copy, ExternalLink } from 'lucide-react';

export default function ClaimBand() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('athleteToken');

  const [athlete, setAthlete] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [assignedBand, setAssignedBand] = useState<any>(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [bandNumber, setBandNumber] = useState('');
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Invalid or missing claim token.');
      setLoading(false);
      return;
    }

    async function fetchClaim() {
      const { data: claim, error: claimError } = await supabase
        .from('token_claims')
        .select('*, athletes(*)')
        .eq('token_hash', token)
        .single();

      if (claimError || !claim) {
        setError('Claim session not found.');
      } else if (claim.used_at) {
        setError('This wristband has already been claimed.');
      } else if (new Date(claim.expires_at) < new Date()) {
        setError('Claim session has expired.');
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
      // Atomic Claim Logic via RPC
      const { data, error: rpcError } = await supabase.rpc('claim_band_atomic', {
        p_token: token,
        p_band_id: bandId,
        p_device_label: 'client-web'
      });

      if (rpcError) throw rpcError;
      if (!data?.success) throw new Error(data?.error || 'Failed to claim wristband.');

      setAssignedBand({ display_number: data.display_number });
      if (data.portal_token) setPortalToken(data.portal_token);
      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
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
      // Lookup by display_number
      const { data: band, error: bandError } = await supabase
        .from('bands')
        .select('*')
        .eq('event_id', athlete.event_id)
        .eq('display_number', parseInt(bandNumber))
        .single();

      if (bandError || !band) throw new Error('Wristband number not found for this event.');
      
      await handleClaim(band.band_id);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  if (loading && !athlete && !error) return <div className="p-8 text-center">Verifying session...</div>;

  if (error && !athlete) {
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
            <h2 className="text-2xl font-bold mb-2">Invalid or missing link</h2>
            <p className="text-zinc-500 text-sm">
              This claim link is invalid or expired. Please return to registration and try again.
            </p>
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
            <span>Athlete: <strong>{athlete.first_name} {athlete.last_name}</strong></span>
          </div>
        )}
      </header>

      {error && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 text-sm"
        >
          <AlertCircle className="w-5 h-5 shrink-0" />
          <p>{error}</p>
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
                <p className="text-zinc-400 text-xs">Point your camera at the QR code on the athlete's wristband.</p>
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
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Wristband Number (1-500)</label>
                  <input 
                    type="number"
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
            Please ensure the wristband is securely fastened before scanning. This links the athlete's identity to their testing number.
          </div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="space-y-4"
        >
          <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-4">
            <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div>
              <h2 className="text-2xl font-bold mb-1">Wristband Assigned!</h2>
              <p className="text-zinc-500">You're officially in. Time to perform.</p>
            </div>

            <div className="p-6 bg-zinc-900 rounded-2xl">
              <div className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-1">Your Athlete Number</div>
              <div className="text-7xl font-black text-white">#{assignedBand.display_number}</div>
            </div>

            <div className="p-4 bg-zinc-50 rounded-2xl border border-zinc-100 text-left text-sm text-zinc-600 space-y-1">
              <p className="font-bold text-zinc-900 text-xs uppercase tracking-wider mb-2">Event Day Instructions</p>
              <p>Your number is <strong>#{assignedBand.display_number}</strong>. Present your wristband at each testing station.</p>
              <p>Results will appear in your Parent Portal within minutes of each drill.</p>
            </div>

            {portalToken && (
              <Link
                to={`/p/${portalToken}`}
                className="block w-full py-3 border border-zinc-200 text-zinc-700 rounded-2xl font-bold text-sm hover:bg-zinc-50 transition-all text-center"
              >
                View Parent Portal →
              </Link>
            )}
          </div>

          {/* Social Sharing */}
          <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Share2 className="w-4 h-4 text-zinc-400" />
              Share Your Results
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const text = encodeURIComponent(`Just went through the Core Elite Network Combine! 💪🏈 #CoreEliteNetwork #CombineReady`);
                  window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank');
                }}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-800 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Share to X
              </button>
              {portalToken && (
                <button
                  onClick={() => {
                    const url = `${window.location.origin}/p/${portalToken}`;
                    navigator.clipboard.writeText(url).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className="flex-1 flex items-center justify-center gap-2 py-3 border border-zinc-200 text-zinc-700 rounded-xl text-sm font-bold hover:bg-zinc-50 transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  {copied ? 'Copied!' : 'Copy Portal Link'}
                </button>
              )}
            </div>
          </div>

          <button
            onClick={() => navigate('/')}
            className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
          >
            Return Home
          </button>
        </motion.div>
      )}
    </div>
  );
}
