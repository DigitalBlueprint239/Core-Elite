import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { SignatureCanvas } from '../components/SignatureCanvas';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Link } from 'react-router-dom';

export default function Register() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
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
    if (!signature || loading || !event) return;
    setLoading(true);
    setError(null);

    try {
      const token = uuidv4();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 2);
      const portalToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

      const { data, error: registrationError } = await supabase.rpc('register_athlete_atomic', {
        p_event_id: event.id,
        p_athlete: {
          first_name: formData.firstName,
          last_name: formData.lastName,
          date_of_birth: formData.date_of_birth,
          grade: formData.grade,
          position: formData.position,
          parent_name: formData.parentName,
          parent_email: formData.parentEmail,
          parent_phone: formData.parentPhone,
        },
        p_waiver: {
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
        },
        p_claim_token: token,
        p_claim_expires_at: expiresAt.toISOString(),
        p_portal_token: portalToken,
      });

      if (registrationError) throw registrationError;

      const registration = Array.isArray(data) ? data[0] : data;
      const claimToken = registration?.claim_token || token;

      navigate(`/claim-band?athleteToken=${claimToken}`);
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
            <h2 className="text-2xl font-bold text-zinc-900 mb-2">{error.message}</h2>
            <p className="text-zinc-500 text-sm">{error.details}</p>
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
          {import.meta.env.DEV && (
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
          <span className={step >= 1 ? "text-zinc-900 font-bold" : ""}>1. Profile</span>
          <ChevronRight className="w-4 h-4" />
          <span className={step >= 2 ? "text-zinc-900 font-bold" : ""}>2. Waiver</span>
          <ChevronRight className="w-4 h-4" />
          <span className={step >= 3 ? "text-zinc-900 font-bold" : ""}>3. Claim Band</span>
        </div>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-black uppercase italic italic tracking-tighter">
          Athlete Registration
        </h1>
        <p className="text-zinc-500">{event?.name} • {event?.location}</p>
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
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Position</label>
                <select 
                  name="position" 
                  value={formData.position} 
                  onChange={handleInputChange}
                  className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none"
                >
                  <option value="">Select Position</option>
                  <option value="QB">Quarterback</option>
                  <option value="RB">Running Back</option>
                  <option value="WR">Wide Receiver</option>
                  <option value="TE">Tight End</option>
                  <option value="OL">Offensive Line</option>
                  <option value="DL">Defensive Line</option>
                  <option value="LB">Linebacker</option>
                  <option value="DB">Defensive Back</option>
                </select>
              </div>
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
              <div className="grid grid-cols-2 gap-4">
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
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Phone</label>
                  <input 
                    type="tel"
                    name="parentPhone" 
                    value={formData.parentPhone} 
                    onChange={handleInputChange}
                    className="w-full p-3 bg-white border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 outline-none" 
                  />
                </div>
              </div>
            </div>

            <button 
              onClick={() => {
                if (!formData.firstName || !formData.lastName || !formData.date_of_birth || !formData.parentEmail) {
                  if (!formData.date_of_birth) {
                    setDateOfBirthError('Date of birth is required.');
                  }
                  setError({ message: 'Missing Required Fields', details: 'Please complete all required fields including Date of Birth.' });
                  return;
                }
                setError(null);
                setDateOfBirthError(null);
                setStep(2);
              }}
              className="w-full py-4 bg-zinc-900 text-white rounded-2xl font-bold text-lg shadow-lg hover:bg-zinc-800 transition-all flex items-center justify-center gap-2"
            >
              Continue to Waiver
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
            <div className="bg-white p-6 rounded-2xl border border-zinc-200 space-y-4 max-h-96 overflow-y-auto text-sm text-zinc-600 leading-relaxed">
              <h2 className="text-lg font-bold text-zinc-900">Release of Liability & Consent</h2>
              <p>I, the undersigned parent/guardian, hereby give permission for the athlete named above to participate in the Core Elite Combine 2026. I understand that athletic testing involves inherent risks of injury.</p>
              <p>I release Core Elite and its staff from any and all liability for injuries sustained during the event. I also consent to the use of any photos or videos taken during the event for promotional purposes.</p>
              <p>In case of emergency, I authorize the staff to seek medical attention for the athlete if I cannot be reached immediately.</p>
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

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Emergency Contact Name</label>
                  <input 
                    name="emergencyContactName" 
                    value={formData.emergencyContactName} 
                    onChange={handleInputChange}
                    className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none" 
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Emergency Contact Phone</label>
                  <input 
                    name="emergencyContactPhone" 
                    value={formData.emergencyContactPhone} 
                    onChange={handleInputChange}
                    className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none" 
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Parent/Guardian Signature</label>
              <SignatureCanvas onSave={(url) => {
                setSignature(url);
                setError(null);
              }} onClear={() => setSignature(null)} />
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm">
                <AlertCircle className="w-5 h-5" />
                <div>
                  <div className="font-bold">{error.message}</div>
                  {error.details && <div className="text-[10px] opacity-70">{error.details}</div>}
                </div>
              </div>
            )}

            <div className="flex gap-4">
              <button 
                onClick={() => setStep(1)}
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
