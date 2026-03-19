import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { SignatureCanvas } from '../components/SignatureCanvas';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Public-safe error message shown to unauthenticated users.
// Technical details are intentionally omitted from the UI and sent to the
// console only in development mode.
// ---------------------------------------------------------------------------
const PUBLIC_ERROR_MESSAGE = "We're having trouble right now.";
const PUBLIC_ERROR_BODY =
  'Please try again in a moment. If the problem continues, ask event staff for help.';

function logDevError(context: string, err: unknown) {
  if (import.meta.env.DEV) {
    console.error(`[Register] ${context}`, err);
  }
}

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [event, setEvent] = useState<any>(null);
  const [availableEvents, setAvailableEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // `message` is always public-safe. `details` is NEVER rendered in the UI.
  const [error, setError] = useState<{ message: string } | null>(null);

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    date_of_birth: '',
    grade: '',
    position: '',
    parentName: '',
    parentEmail: '',
    parentPhone: '',
    guardianRelationship: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    injuryWaiverAck: false,
    mediaRelease: false,
    dataConsent: false,
    marketingConsent: false,
  });

  const [signature, setSignature] = useState<string | null>(null);
  const [dateOfBirthError, setDateOfBirthError] = useState<string | null>(null);

  useEffect(() => {
    async function resolveEvent() {
      setLoading(true);
      setError(null);

      try {
        const paramSlug = searchParams.get('event') || searchParams.get('slug');

        // 1. Try to fetch by slug if provided
        if (paramSlug) {
          const { data: slugEvent, error: slugError } = await supabase
            .from('events')
            .select('*')
            .eq('slug', paramSlug)
            .maybeSingle();

          if (slugError) {
            logDevError('resolveEvent › slug lookup', slugError);
            setError({ message: PUBLIC_ERROR_MESSAGE });
            setLoading(false);
            return;
          }

          if (slugEvent) {
            setEvent(slugEvent);
            setLoading(false);
            return;
          }
        }

        // 2. If not found or no param, fetch default active event (live)
        const { data: liveEvents, error: liveError } = await supabase
          .from('events')
          .select('*')
          .eq('status', 'live')
          .order('created_at', { ascending: true })
          .limit(1);

        if (liveError) {
          logDevError('resolveEvent › live event lookup', liveError);
          setError({ message: PUBLIC_ERROR_MESSAGE });
          setLoading(false);
          return;
        }

        if (liveEvents && liveEvents.length > 0) {
          setEvent(liveEvents[0]);
          setLoading(false);
          return;
        }

        // 3. If still not found, fetch all upcoming events for picker
        const { data: allEvents, error: allError } = await supabase
          .from('events')
          .select('id, name, slug, created_at, location, status')
          .in('status', ['live', 'draft'])
          .order('created_at', { ascending: true });

        if (allError) {
          logDevError('resolveEvent › all events lookup', allError);
          setError({ message: PUBLIC_ERROR_MESSAGE });
        } else if (allEvents && allEvents.length > 0) {
          setAvailableEvents(allEvents);
        } else {
          // No events scheduled — friendly, non-technical message
          setError({
            message: 'Registration is not open yet. Please check back closer to the event date.',
          });
        }
      } catch (err: unknown) {
        logDevError('resolveEvent › unexpected', err);
        setError({ message: PUBLIC_ERROR_MESSAGE });
      } finally {
        setLoading(false);
      }
    }
    resolveEvent();
  }, [searchParams]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target as HTMLInputElement;
    if (type === 'checkbox') {
      setFormData({ ...formData, [name]: (e.target as HTMLInputElement).checked });
    } else {
      setFormData({ ...formData, [name]: value });
      if (name === 'date_of_birth' && value) {
        setDateOfBirthError(null);
      }
    }
  };

  const handleSubmit = async () => {
    if (!signature) return;
    setLoading(true);

    try {
      // 1. Create Athlete
      const { data: athlete, error: athleteError } = await supabase
        .from('athletes')
        .insert({
          event_id: event.id,
          first_name: formData.firstName,
          last_name: formData.lastName,
          date_of_birth: formData.date_of_birth,
          grade: formData.grade,
          position: formData.position,
          parent_name: formData.parentName,
          parent_email: formData.parentEmail,
          parent_phone: formData.parentPhone,
        })
        .select()
        .single();

      if (athleteError) throw athleteError;

      // 2. Create Waiver
      const { error: waiverError } = await supabase
        .from('waivers')
        .insert({
          athlete_id: athlete.id,
          event_id: event.id,
          guardian_name: formData.parentName,
          guardian_relationship: formData.guardianRelationship,
          emergency_contact_name: formData.emergencyContactName,
          emergency_contact_phone: formData.emergencyContactPhone,
          signature_data_url: signature,
          injury_waiver_ack: formData.injuryWaiverAck,
          media_release: formData.mediaRelease,
          data_consent: formData.dataConsent,
          marketing_consent: formData.marketingConsent,
          waiver_version: '2026.1',
        });

      if (waiverError) throw waiverError;

      // 3. Create Athlete Token for Band Claim
      const token = uuidv4();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 2);

      const { error: tokenError } = await supabase
        .from('token_claims')
        .insert({
          token_hash: token, // In real app, hash this
          event_id: event.id,
          athlete_id: athlete.id,
          expires_at: expiresAt.toISOString(),
        });

      if (tokenError) throw tokenError;

      // 4. Create Parent Portal Token
      const portalToken =
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15);
      await supabase.from('parent_portals').insert({
        athlete_id: athlete.id,
        event_id: event.id,
        portal_token: portalToken,
      });

      // Success!
      navigate(`/claim-band?athleteToken=${token}`);
    } catch (err: unknown) {
      logDevError('handleSubmit', err);
      setError({
        message: 'Registration could not be completed. Please try again or ask event staff for help.',
      });
      setLoading(false);
    }
  };

  if (loading && !event && availableEvents.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-zinc-900 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-zinc-500 font-medium">Resolving event details...</p>
        </div>
      </div>
    );
  }

  // Event Picker UI
  if (!event && availableEvents.length > 0) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-black uppercase italic tracking-tighter mb-4">
            Choose Your Event
          </h1>
          <p className="text-zinc-500">Select an upcoming combine to begin your registration.</p>
        </header>

        <div className="grid gap-4">
          {availableEvents.map((ev) => (
            <button
              key={ev.id}
              onClick={() => navigate(`/register?event=${ev.slug}`)}
              className="p-6 bg-white border border-zinc-200 rounded-3xl text-left hover:border-zinc-900 hover:shadow-lg transition-all group"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold group-hover:text-zinc-900">{ev.name}</h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
                    ev.status === 'live'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {ev.status}
                </span>
              </div>
              <div className="flex gap-4 text-zinc-500 text-sm">
                <span>{ev.location}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Public-safe error screen.
  // Shows a friendly message only — no DB errors, table names, or migration
  // instructions are ever rendered here.
  // -------------------------------------------------------------------------
  if (error && !event) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-4">
        <div className="bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center max-w-sm space-y-6">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-xl font-bold mb-2">{error.message}</h2>
            <p className="text-zinc-500 text-sm">{PUBLIC_ERROR_BODY}</p>
          </div>
          <div className="space-y-3 pt-2">
            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-zinc-900 text-white rounded-2xl font-bold hover:bg-zinc-800 transition-all"
            >
              Try Again
            </button>
            <button
              onClick={() => navigate('/')}
              className="w-full py-3 bg-white border border-zinc-200 text-zinc-600 rounded-2xl font-bold hover:bg-zinc-50 transition-all"
            >
              Return Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Inline submission error banner (shown mid-form after a failed handleSubmit)
  // -------------------------------------------------------------------------
  const InlineErrorBanner = () =>
    error ? (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6 p-4 bg-red-50 border border-red-200 rounded-2xl flex items-start gap-3 text-red-700 text-sm"
      >
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">{error.message}</p>
          <p className="mt-1 text-red-600">{PUBLIC_ERROR_BODY}</p>
        </div>
      </motion.div>
    ) : null;

  // -------------------------------------------------------------------------
  // Main multi-step registration form (unchanged structure)
  // -------------------------------------------------------------------------
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link
          to="/"
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
      </div>

      {event && (
        <header className="mb-8">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
                event.status === 'live'
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-amber-100 text-amber-700'
              }`}
            >
              {event.status}
            </span>
          </div>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter">
            {event.name}
          </h1>
          <p className="text-zinc-500 text-sm mt-1">{event.location}</p>
        </header>
      )}

      {/* Step progress indicator */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3].map((s) => (
          <React.Fragment key={s}>
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                step >= s
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-400'
              }`}
            >
              {step > s ? <CheckCircle2 className="w-4 h-4" /> : s}
            </div>
            {s < 3 && (
              <div
                className={`flex-1 h-0.5 transition-all ${
                  step > s ? 'bg-zinc-900' : 'bg-zinc-200'
                }`}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      <InlineErrorBanner />

      <AnimatePresence mode="wait">
        {/* Step 1 — Athlete Info */}
        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            <h2 className="text-2xl font-bold">Athlete Information</h2>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  First Name *
                </label>
                <input
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="First"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Last Name *
                </label>
                <input
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="Last"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Date of Birth *
              </label>
              <input
                type="date"
                name="date_of_birth"
                value={formData.date_of_birth}
                onChange={handleInputChange}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                required
              />
              {dateOfBirthError && (
                <p className="text-red-600 text-xs mt-1">{dateOfBirthError}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Grade
                </label>
                <select
                  name="grade"
                  value={formData.grade}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                >
                  <option value="">Select grade</option>
                  {['6th', '7th', '8th', '9th', '10th', '11th', '12th'].map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Position
                </label>
                <select
                  name="position"
                  value={formData.position}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                >
                  <option value="">Select position</option>
                  {['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'DB', 'K/P', 'ATH'].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              onClick={() => {
                if (!formData.firstName || !formData.lastName || !formData.date_of_birth) {
                  setDateOfBirthError(!formData.date_of_birth ? 'Date of birth is required.' : null);
                  return;
                }
                setStep(2);
              }}
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all"
            >
              Continue <ChevronRight className="w-5 h-5" />
            </button>
          </motion.div>
        )}

        {/* Step 2 — Parent / Guardian Info */}
        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            <div className="flex items-center gap-3 mb-2">
              <button
                onClick={() => setStep(1)}
                className="p-2 rounded-xl hover:bg-zinc-100 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-2xl font-bold">Parent / Guardian</h2>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Parent / Guardian Name *
              </label>
              <input
                name="parentName"
                value={formData.parentName}
                onChange={handleInputChange}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                placeholder="Full name"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Email *
                </label>
                <input
                  type="email"
                  name="parentEmail"
                  value={formData.parentEmail}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="email@example.com"
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Phone *
                </label>
                <input
                  type="tel"
                  name="parentPhone"
                  value={formData.parentPhone}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="(555) 000-0000"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Relationship to Athlete
              </label>
              <select
                name="guardianRelationship"
                value={formData.guardianRelationship}
                onChange={handleInputChange}
                className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
              >
                <option value="">Select relationship</option>
                {['Parent', 'Guardian', 'Grandparent', 'Other'].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Emergency Contact Name
                </label>
                <input
                  name="emergencyContactName"
                  value={formData.emergencyContactName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="Full name"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Emergency Contact Phone
                </label>
                <input
                  type="tel"
                  name="emergencyContactPhone"
                  value={formData.emergencyContactPhone}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:border-zinc-900 transition-colors"
                  placeholder="(555) 000-0000"
                />
              </div>
            </div>

            <button
              onClick={() => {
                if (!formData.parentName || !formData.parentEmail || !formData.parentPhone) return;
                setStep(3);
              }}
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all"
            >
              Continue <ChevronRight className="w-5 h-5" />
            </button>
          </motion.div>
        )}

        {/* Step 3 — Waiver & Signature */}
        {step === 3 && (
          <motion.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            <div className="flex items-center gap-3 mb-2">
              <button
                onClick={() => setStep(2)}
                className="p-2 rounded-xl hover:bg-zinc-100 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-2xl font-bold">Waiver & Consent</h2>
            </div>

            <div className="bg-zinc-50 p-4 rounded-2xl border border-zinc-200 text-xs text-zinc-600 space-y-2 max-h-40 overflow-y-auto">
              <p className="font-bold">Participation Waiver — Core Elite Combine 2026</p>
              <p>
                By signing below, I acknowledge that participation in athletic combine activities
                involves inherent risks of injury. I voluntarily assume all risks associated with
                participation and release Core Elite and its organizers from any liability.
              </p>
              <p>
                I consent to emergency medical treatment if necessary. I grant permission for
                photographs and video taken during the event to be used for promotional purposes
                unless I opt out below.
              </p>
            </div>

            <div className="space-y-3">
              {[
                { name: 'injuryWaiverAck', label: 'I acknowledge the injury waiver and assume all risks *' },
                { name: 'dataConsent', label: "I consent to my athlete's data being stored and used for combine results *" },
                { name: 'mediaRelease', label: 'I grant media release permission for photos/video (optional)' },
                { name: 'marketingConsent', label: 'I agree to receive event updates and marketing communications (optional)' },
              ].map(({ name, label }) => (
                <label key={name} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    name={name}
                    checked={formData[name as keyof typeof formData] as boolean}
                    onChange={handleInputChange}
                    className="mt-0.5 w-4 h-4 rounded accent-zinc-900"
                  />
                  <span className="text-sm text-zinc-700">{label}</span>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Guardian Signature *
              </label>
              <SignatureCanvas onSave={setSignature} />
              {signature && (
                <p className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Signature captured
                </p>
              )}
            </div>

            <button
              onClick={handleSubmit}
              disabled={
                !signature ||
                !formData.injuryWaiverAck ||
                !formData.dataConsent ||
                loading
              }
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Registering...
                </>
              ) : (
                <>
                  Complete Registration <CheckCircle2 className="w-5 h-5" />
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
      }
