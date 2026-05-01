import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { athleteRegistrationSchema } from '../lib/types';
import { z } from 'zod';
import type { SignatureMetadata } from '../components/SignatureCanvas';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, CheckCircle2, AlertCircle, ArrowLeft, ChevronDown } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useOrganization } from '../hooks/useOrganization';
import { BRAND } from '../lib/brand';

// SignatureCanvas pulls in signature_pad. It is only used on the final waiver
// step, so we lazy-load it — Vite emits a separate signature_pad chunk and
// the initial registration bundle stays small for the spotty-LTE first paint.
const SignatureCanvas = lazy(() =>
  import('../components/SignatureCanvas').then(m => ({ default: m.SignatureCanvas })),
);
const SignatureFallback = () => (
  <div className="h-[180px] rounded-xl border-2 border-dashed border-zinc-200 bg-white flex items-center justify-center text-xs text-zinc-400 font-medium">
    Loading signature pad…
  </div>
);

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const { org } = useOrganization();
  const [event, setEvent] = useState<any>(null);
  const [availableEvents, setAvailableEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    date_of_birth: '',
    grade: '',
    position: '',
    // Biometrics — collected on Step 1, converted to DB columns before RPC call:
    //   heightFeet + heightInches → height_in (total integer inches)
    //   weightLb                  → weight_lb
    //   highSchool                → high_school
    heightFeet: '',
    heightInches: '',
    weightLb: '',
    highSchool: '',
    film_url: '',
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

  const [signature, setSignature] = useState<SignatureMetadata | null>(null);
  const [dateOfBirthError, setDateOfBirthError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [waiverExpanded, setWaiverExpanded] = useState(false);

  useEffect(() => {
    async function checkAdmin() {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('user_id', session.user.id)
          .single();
        setIsAdmin(profile?.role === 'admin');
      }
    }
    checkAdmin();
  }, []);

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
            const isTableMissing = slugError.message.includes('Could not find the table') || slugError.code === '42P01';
            setError({ 
              message: isTableMissing ? 'Database not initialized.' : 'Database error while looking up event.', 
              details: isTableMissing
                ? 'The "events" table is missing from the database. Please run the schema migrations in Supabase.'
                : `RLS or Connection Error: ${slugError.message}` 
            });
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
          const isTableMissing = liveError.message.includes('Could not find the table') || liveError.code === '42P01';
          setError({ 
            message: isTableMissing ? 'Database not initialized.' : 'Error fetching active events.', 
            details: isTableMissing
              ? 'The "events" table is missing from the database. Please run the schema migrations in Supabase.'
              : `RLS or Connection Error: ${liveError.message}` 
          });
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
          const isTableMissing = allError.message.includes('Could not find the table') || allError.code === '42P01';
          setError({ 
            message: isTableMissing ? 'Database not initialized.' : 'Error fetching event list.', 
            details: isTableMissing 
              ? 'The "events" table is missing from the database. Please run the schema migrations in Supabase.'
              : `RLS or Connection Error: ${allError.message}` 
          });
        } else if (allEvents && allEvents.length > 0) {
          setAvailableEvents(allEvents);
        } else {
          setError({ 
            message: 'No events are currently scheduled.', 
            details: 'The events table is empty or no events are in "live" or "draft" status.' 
          });
        }
      } catch (err: any) {
        setError({ message: 'An unexpected error occurred.', details: err.message });
      } finally {
        setLoading(false);
      }
    }
    resolveEvent();
  }, [searchParams]);

  /**
   * Real-time US phone formatter.
   * Strips non-digits, caps at 10, and builds (XXX) XXX-XXXX progressively
   * so the user sees the mask form as they type.
   */
  const formatPhone = (raw: string): string => {
    const digits = raw.replace(/\D/g, '').slice(0, 10);
    if (digits.length === 0) return '';
    if (digits.length <= 3) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target as HTMLInputElement;
    if (type === 'checkbox') {
      setFormData({ ...formData, [name]: (e.target as HTMLInputElement).checked });
    } else if (name === 'parentPhone' || name === 'emergencyContactPhone') {
      const formatted = formatPhone(value);
      setFormData({ ...formData, [name]: formatted });
      // Clear phone error once the user has typed all 10 digits
      if (name === 'parentPhone') {
        const digits = value.replace(/\D/g, '');
        if (digits.length === 10) setPhoneError(null);
      }
    } else {
      setFormData({ ...formData, [name]: value });
      if (name === 'date_of_birth' && value) {
        setDateOfBirthError(null);
      }
    }
  };

  const handleSubmit = async () => {
    if (!signature) return;

    // Validate with Zod
    try {
      athleteRegistrationSchema.parse(formData);
      setFormErrors({});
    } catch (err) {
      if (err instanceof z.ZodError) {
        const errors: Record<string, string> = {};
        err.issues.forEach(e => {
          if (e.path[0]) errors[e.path[0] as string] = e.message;
        });
        setFormErrors(errors);
        return;
      }
    }

    setLoading(true);

    // Sanitize all free-text fields before submission.
    // strip() removes leading/trailing whitespace; <> removal prevents
    // HTML injection into stored PII fields.
    const sanitize = (str: string) => str.trim().replace(/[<>]/g, '');

    // ── Biometric conversion ─────────────────────────────────────────────────
    // Convert the split ft/in UI inputs into a single integer inches value for
    // the DB column (height_in). Both parts are optional — if neither is filled
    // in, pass null so the column stays NULL rather than receiving 0.
    const parsedFeet   = parseInt(formData.heightFeet,   10);
    const parsedInches = parseInt(formData.heightInches, 10);
    const hasHeight    = !isNaN(parsedFeet) || !isNaN(parsedInches);
    const heightIn: number | null = hasHeight
      ? ((!isNaN(parsedFeet) ? parsedFeet : 0) * 12) +
         (!isNaN(parsedInches) ? parsedInches : 0) || null
      : null;
    const weightLb:   number | null = parseInt(formData.weightLb, 10) || null;
    const highSchool: string | null = sanitize(formData.highSchool) || null;
    // Film URL: trim and coerce empty → null. Zod already validated URL shape
    // when non-empty. Pass raw string to the RPC; normalization lives server-side.
    const filmUrl:    string | null = formData.film_url.trim() || null;
    // ────────────────────────────────────────────────────────────────────────

    try {
      const { data, error: rpcError } = await supabase.rpc('register_athlete_secure', {
        p_event_id:                   event.id,
        p_first_name:                 sanitize(formData.firstName),
        p_last_name:                  sanitize(formData.lastName),
        p_date_of_birth:              formData.date_of_birth,
        p_grade:                      formData.grade,
        p_position:                   formData.position,
        p_parent_name:                sanitize(formData.parentName),
        p_parent_email:               formData.parentEmail.toLowerCase().trim(),
        p_parent_phone:               formData.parentPhone.trim(),
        p_guardian_relationship:      formData.guardianRelationship.trim(),
        p_emergency_contact_name:     sanitize(formData.emergencyContactName),
        p_emergency_contact_phone:    formData.emergencyContactPhone.trim(),
        p_signature_data_url:         signature?.dataUrl ?? null,
        p_injury_waiver_ack:          formData.injuryWaiverAck,
        p_media_release:              formData.mediaRelease,
        p_data_consent:               formData.dataConsent,
        p_marketing_consent:          formData.marketingConsent,
        p_height_in:                  heightIn,
        p_weight_lb:                  weightLb,
        p_high_school:                highSchool,
        p_film_url:                   filmUrl,
      });

      if (rpcError) throw rpcError;
      if (!data?.success) throw new Error(data?.error || 'Registration failed');

      // Success!
      navigate(`/claim-band?athleteToken=${data.claim_token}`);
    } catch (err: any) {
      setError({ message: 'Registration failed.', details: err.message });
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
          <h1 className="text-4xl font-black uppercase italic tracking-tighter mb-4">Choose Your Event</h1>
          <p className="text-zinc-500">Select an upcoming combine to begin your registration.</p>
        </header>

        <div className="grid gap-4">
          {availableEvents.map(ev => (
            <button
              key={ev.id}
              onClick={() => navigate(`/register?event=${ev.slug}`)}
              className="p-6 bg-white border border-zinc-200 rounded-3xl text-left hover:border-zinc-900 hover:shadow-lg transition-all group"
            >
              <div className="flex justify-between items-start mb-2">
                <h3 className="text-xl font-bold group-hover:text-zinc-900">{ev.name}</h3>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest ${
                  ev.status === 'live' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {ev.status}
                </span>
              </div>
              <div className="flex gap-4 text-sm text-zinc-400">
                <span>{new Date(ev.created_at).toLocaleDateString()}</span>
                <span>•</span>
                <span>{ev.location}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (error && !event) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
        <div className="max-w-md w-full bg-white p-8 rounded-3xl border border-zinc-200 shadow-xl text-center space-y-6">
          <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-zinc-900 mb-2">
              {(isAdmin || import.meta.env.DEV) ? error.message : "We’re having trouble loading registration right now"}
            </h2>
            <p className="text-zinc-500 text-sm">
              {(isAdmin || import.meta.env.DEV) ? error.details : "Please try again in a moment. If the issue continues, ask event staff for help."}
            </p>
          </div>
          <div className="pt-4 space-y-3">
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-zinc-900 text-white rounded-xl font-bold hover:bg-zinc-800 transition-all"
            >
              Try Again
            </button>
            <button 
              onClick={() => navigate('/')}
              className="w-full py-3 bg-white border border-zinc-200 text-zinc-600 rounded-xl font-bold hover:bg-zinc-50 transition-all"
            >
              Return Home
            </button>
          </div>
          {(isAdmin || import.meta.env.DEV) && (
            <div className="mt-8 p-4 bg-zinc-50 rounded-xl text-left">
              <p className="text-[10px] font-bold uppercase text-zinc-400 mb-2">Admin Troubleshooting</p>
              <ul className="text-[10px] text-zinc-500 list-disc pl-4 space-y-1">
                <li>Check if an event exists in the <code>events</code> table.</li>
                <li>Ensure the event <code>status</code> is set to 'live' or 'draft'.</li>
                <li>Verify RLS policies allow public SELECT on <code>events</code>.</li>
                <li>Visit <button onClick={() => navigate('/admin/diagnostics')} className="underline">Diagnostics</button></li>
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <Link 
          to="/" 
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-bold"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Link>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span className={step >= 1 ? "text-zinc-900 font-bold" : ""}>1. Essentials</span>
          <ChevronRight className="w-4 h-4" />
          <span className={step >= 2 ? "text-zinc-900 font-bold" : ""}>2. Profile</span>
          <ChevronRight className="w-4 h-4" />
          <span className={step >= 3 ? "text-zinc-900 font-bold" : ""}>3. Waiver</span>
        </div>
      </div>

      <div className="mb-8 flex items-center gap-4">
        {org.logo_url ? (
          <img src={org.logo_url} alt={org.name} className="h-10 shrink-0" />
        ) : (
          <img src={BRAND.logo} alt="Core Elite" className="w-10 h-10 shrink-0" />
        )}
        <div>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter">
            Athlete Registration
          </h1>
          <p className="text-zinc-500">{event?.name} • {event?.location}</p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div
            key="step1"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            {/* ── ESSENTIALS ONLY: Name, DOB, Phone (Event already resolved
                above the form). Optional biometrics + film URL live on Step 2
                so spotty-LTE registrants don't bounce on the first paint.
            ────────────────────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">First Name</label>
                <input
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                  placeholder="John"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Last Name</label>
                <input
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                  placeholder="Doe"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Date of Birth</label>
                <input
                  type="date"
                  name="date_of_birth"
                  value={formData.date_of_birth}
                  onChange={handleInputChange}
                  className={`w-full p-3 bg-white border ${dateOfBirthError ? 'border-red-500 ring-1 ring-red-500' : 'border-zinc-200'} rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none`}
                />
                {dateOfBirthError && <p className="text-[10px] font-bold text-red-500 mt-1">{dateOfBirthError}</p>}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Parent / Guardian Phone</label>
                <input
                  type="tel"
                  name="parentPhone"
                  value={formData.parentPhone}
                  onChange={handleInputChange}
                  placeholder="(555) 555-5555"
                  maxLength={14}
                  className={`w-full p-3 bg-white border ${phoneError ? 'border-red-500 ring-1 ring-red-500' : 'border-zinc-200'} rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none`}
                />
                {phoneError && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">{phoneError}</p>
                )}
              </div>
            </div>

            <button
              onClick={() => {
                const missingFields =
                  !formData.firstName ||
                  !formData.lastName  ||
                  !formData.date_of_birth;

                if (missingFields) {
                  if (!formData.date_of_birth) setDateOfBirthError('Date of birth is required.');
                  setError({ message: 'Missing Required Fields', details: 'Please complete all required fields.' });
                  return;
                }

                // DOB parsing with noon-UTC anchor so a "2010-01-01" entry on
                // UTC-5 doesn't roll back to 2009-12-31.
                const dob = new Date(formData.date_of_birth + 'T12:00:00Z');
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                if (isNaN(dob.getTime())) {
                  setDateOfBirthError('Please enter a valid date of birth.');
                  return;
                }
                if (dob >= today) {
                  setDateOfBirthError('Date of birth must be in the past.');
                  return;
                }

                let age = today.getFullYear() - dob.getFullYear();
                const monthDiff = today.getMonth() - dob.getMonth();
                if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
                  age -= 1;
                }

                // Hard block: combine participants must be 10–19. Mirrors the
                // Zod schema in src/lib/types.ts and the SQL GATE 1 check in
                // register_athlete_secure (migration 014).
                if (age < 10 || age > 19) {
                  setDateOfBirthError(
                    age < 10
                      ? `Athlete must be at least 10 years old to participate (calculated age: ${age}).`
                      : `Athlete must be 19 or younger to participate (calculated age: ${age}).`
                  );
                  return;
                }

                setDateOfBirthError(null);

                const phoneDigits = formData.parentPhone.replace(/\D/g, '');
                if (phoneDigits.length !== 10) {
                  setPhoneError('Please enter a complete 10-digit phone number.');
                  return;
                }

                setPhoneError(null);
                setError(null);
                setStep(2);
              }}
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold text-lg shadow-lg hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
            >
              Continue
              <ChevronRight className="w-5 h-5" />
            </button>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            key="step2"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            {/* ── PROFILE: optional biometrics + parent contact details. All
                non-essential fields live here so Step 1 is instant on LTE.
            ────────────────────────────────────────────────────────────── */}
            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Position</label>
              <select
                name="position"
                value={formData.position}
                onChange={handleInputChange}
                className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
              >
                <option value="">Select Position</option>
                <option value="ATH">ATH (Athlete)</option>
                <option value="CB">CB (Cornerback)</option>
                <option value="DB">DB (Defensive Back)</option>
                <option value="DL">DL (Defensive Line)</option>
                <option value="EDGE">EDGE (Edge Rusher)</option>
                <option value="FB">FB (Fullback)</option>
                <option value="K">K (Kicker)</option>
                <option value="LB">LB (Linebacker)</option>
                <option value="LS">LS (Long Snapper)</option>
                <option value="OL">OL (Offensive Line)</option>
                <option value="P">P (Punter)</option>
                <option value="QB">QB (Quarterback)</option>
                <option value="RB">RB (Running Back)</option>
                <option value="S">S (Safety)</option>
                <option value="TE">TE (Tight End)</option>
                <option value="WR">WR (Wide Receiver)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Height <span className="text-zinc-300 font-normal normal-case tracking-normal">(optional)</span>
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="number"
                      name="heightFeet"
                      value={formData.heightFeet}
                      onChange={handleInputChange}
                      min="3" max="8"
                      className="w-full p-3 pr-8 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                      placeholder="0"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400 pointer-events-none">ft</span>
                  </div>
                  <div className="relative flex-1">
                    <input
                      type="number"
                      name="heightInches"
                      value={formData.heightInches}
                      onChange={handleInputChange}
                      min="0" max="11"
                      className="w-full p-3 pr-8 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                      placeholder="0"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400 pointer-events-none">in</span>
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                  Weight <span className="text-zinc-300 font-normal normal-case tracking-normal">(optional)</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    name="weightLb"
                    value={formData.weightLb}
                    onChange={handleInputChange}
                    min="50" max="450"
                    className="w-full p-3 pr-12 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                    placeholder="0"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400 pointer-events-none">lbs</span>
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                High School <span className="text-zinc-300 font-normal normal-case tracking-normal">(optional)</span>
              </label>
              <input
                name="highSchool"
                value={formData.highSchool}
                onChange={handleInputChange}
                maxLength={120}
                className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                placeholder="School name"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Highlight Film URL <span className="text-zinc-300 font-normal normal-case tracking-normal">(optional)</span>
              </label>
              <input
                name="film_url"
                type="url"
                value={formData.film_url}
                onChange={handleInputChange}
                maxLength={500}
                className={`w-full p-3 bg-white border ${formErrors.film_url ? 'border-red-500 ring-1 ring-red-500' : 'border-zinc-200'} rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none`}
                placeholder="https://www.hudl.com/video/..."
                autoComplete="off"
                inputMode="url"
              />
              {formErrors.film_url ? (
                <p className="text-[10px] font-bold text-red-500 mt-1">{formErrors.film_url}</p>
              ) : (
                <p className="text-[10px] text-zinc-400 mt-1">Hudl link works best. You can add this later from your athlete profile.</p>
              )}
            </div>

            <div className="space-y-4 pt-4 border-t border-zinc-100">
              <h3 className="font-bold">Parent/Guardian Information</h3>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Full Name</label>
                <input
                  name="parentName"
                  value={formData.parentName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Email</label>
                <input
                  type="email"
                  name="parentEmail"
                  value={formData.parentEmail}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Emergency Contact Name</label>
                <input
                  name="emergencyContactName"
                  value={formData.emergencyContactName}
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Emergency Contact Phone</label>
                <input
                  type="tel"
                  name="emergencyContactPhone"
                  value={formData.emergencyContactPhone}
                  onChange={handleInputChange}
                  placeholder="(555) 555-5555"
                  maxLength={14}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                />
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setStep(1)}
                className="flex-1 py-4 border border-zinc-200 rounded-2xl font-bold text-zinc-600 hover:bg-zinc-50 transition-all"
              >
                Back
              </button>
              <button
                onClick={() => {
                  // Parent email is required for waiver delivery — gate the
                  // step transition rather than letting Zod fail later.
                  if (!formData.parentEmail) {
                    setError({ message: 'Parent email required.', details: 'Waiver and results notifications need a parent email address.' });
                    return;
                  }
                  setError(null);
                  setStep(3);
                }}
                className="flex-[2] py-4 bg-zinc-900 text-white rounded-2xl font-bold text-lg shadow-lg hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
              >
                Continue to Waiver
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div
            key="step3"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="space-y-6"
          >
            <div className="bg-white p-6 rounded-2xl border border-zinc-200 space-y-4 text-sm text-zinc-600 leading-relaxed">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-zinc-900">Release of Liability & Consent</h2>
                <button
                  type="button"
                  onClick={() => setWaiverExpanded(!waiverExpanded)}
                  className="flex items-center gap-1 text-xs font-bold text-zinc-500 hover:text-zinc-900 transition-colors"
                >
                  {waiverExpanded ? 'Collapse Waiver' : 'Read Full Waiver'}
                  <ChevronDown className={`w-3 h-3 transition-transform ${waiverExpanded ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {!waiverExpanded ? (
                <p className="text-zinc-500 italic text-xs">
                  By signing below, you authorize athletic participation, release Core Elite from liability for injuries, consent to emergency medical care, and agree to media and data collection terms. Tap "Read Full Waiver" to review all five sections.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto space-y-4 pr-1">
                  <div>
                    <h3 className="font-bold text-zinc-900 mb-1">Section 1: Assumption of Risk</h3>
                    <p>I, the undersigned parent/guardian, acknowledge that participation in athletic combine testing involves inherent risks, including but not limited to physical injury, muscle strain, sprains, fractures, and in rare cases, serious injury or death. I understand these risks are an ordinary part of athletic performance testing and I voluntarily accept them.</p>
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-900 mb-1">Section 2: Release of Liability</h3>
                    <p>I hereby release, discharge, and hold harmless Core Elite, its organizers, staff, volunteers, venue owners, and sponsors from any and all claims, demands, losses, or liabilities arising from the athlete's participation in this event, whether caused by negligence or otherwise, to the fullest extent permitted by law.</p>
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-900 mb-1">Section 3: Medical Authorization</h3>
                    <p>In the event of injury or medical emergency, I authorize Core Elite staff to seek and consent to emergency medical treatment for the athlete if I cannot be reached immediately. I understand that Core Elite will make every effort to contact me before authorizing treatment.</p>
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-900 mb-1">Section 4: Media Release</h3>
                    <p>I consent to the capture and use of photographs, video recordings, and related media of the athlete during the event for Core Elite's promotional, educational, and marketing purposes, including use on social media, websites, and printed materials.</p>
                  </div>
                  <div>
                    <h3 className="font-bold text-zinc-900 mb-1">Section 5: Data Collection Consent</h3>
                    <p>I consent to the collection, processing, and storage of the athlete's performance data, including drill results, timing data, and biometric measurements, for the purposes of athlete evaluation, reporting, and sharing with authorized college scouts and recruiting platforms.</p>
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-zinc-100 space-y-4">
                <div className="space-y-4">
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      name="injuryWaiverAck"
                      checked={formData.injuryWaiverAck}
                      onChange={handleInputChange}
                      className="mt-1 w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    <span className="text-xs font-medium text-zinc-700 group-hover:text-zinc-900">
                      I acknowledge the injury waiver and release of liability. <span className="text-red-500">*</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      name="mediaRelease"
                      checked={formData.mediaRelease}
                      onChange={handleInputChange}
                      className="mt-1 w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    <span className="text-xs font-medium text-zinc-700 group-hover:text-zinc-900">
                      I consent to the media release for promotional purposes. <span className="text-red-500">*</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      name="dataConsent"
                      checked={formData.dataConsent}
                      onChange={handleInputChange}
                      className="mt-1 w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    <span className="text-xs font-medium text-zinc-700 group-hover:text-zinc-900">
                      I consent to the collection and processing of athletic performance data. <span className="text-red-500">*</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      name="marketingConsent"
                      checked={formData.marketingConsent}
                      onChange={handleInputChange}
                      className="mt-1 w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    <span className="text-xs font-medium text-zinc-700 group-hover:text-zinc-900">
                      I would like to receive updates and marketing materials (Optional).
                    </span>
                  </label>
                </div>

              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Parent / Guardian Signature <span className="text-red-500">*</span>
              </label>
              <Suspense fallback={<SignatureFallback />}>
                <SignatureCanvas
                  signerName={formData.parentName}
                  onSave={(meta) => {
                    setSignature(meta);
                    setError(null);
                  }}
                  onClear={() => setSignature(null)}
                />
              </Suspense>
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm">
                <AlertCircle className="w-5 h-5" />
                <div>
                  <div className="font-bold">
                    {(isAdmin || import.meta.env.DEV) ? error.message : "Registration failed"}
                  </div>
                  {error.details && (
                    <div className="text-[10px] opacity-70">
                      {(isAdmin || import.meta.env.DEV) ? error.details : "Please check your information and try again."}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex gap-4">
              <button
                onClick={() => setStep(2)}
                className="flex-1 py-4 border border-zinc-200 rounded-2xl font-bold text-zinc-600 hover:bg-zinc-50 transition-all"
              >
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={!signature || !formData.injuryWaiverAck || !formData.mediaRelease || !formData.dataConsent || loading}
                className="flex-[2] py-4 bg-zinc-900 text-white rounded-2xl font-bold text-lg shadow-lg hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
              >
                {loading ? 'Processing...' : 'Complete Registration'}
                {!loading && <CheckCircle2 className="w-5 h-5" />}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
