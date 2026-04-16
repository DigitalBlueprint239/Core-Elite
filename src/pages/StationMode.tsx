import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Station, Athlete } from '../lib/types';
import { QRScanner } from '../components/QRScanner';
import { addToOutbox, getCachedAthlete, cacheAthlete, saveStationQueue, loadStationQueue } from '../lib/offline';
import { seedOverridePin, verifyOverridePin, isOverridePinSeeded } from '../lib/overridePin';
import { useOfflineSync } from '../hooks/useOfflineSync';
import { motion, AnimatePresence } from 'motion/react';
import { QrCode, User, Send, RefreshCw, ChevronLeft, AlertCircle, CheckCircle2, Wifi, WifiOff, History, AlertTriangle, Zap, ListOrdered, X, ShieldAlert, ArrowLeft, LayoutGrid, Delete } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { getDeviceId } from '../lib/device';
import { tick } from '../lib/hlc';
import { DRILL_CATALOG } from '../constants';
import { validateResult, DrillId, BES_ELIGIBLE_DRILLS } from '../lib/scoring';

// ---------------------------------------------------------------------------
// NumericKeypad
// Oversized touch-first keypad for drill result entry. Replaces the native
// device keyboard — eliminates layout shifts and reduces mis-taps on tablets.
// ---------------------------------------------------------------------------
const KEYPAD_KEYS = ['7','8','9','4','5','6','1','2','3','.','0','⌫'] as const;

function NumericKeypad({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const press = (key: string) => {
    if (disabled) return;
    if (key === '⌫') { onChange(value.slice(0, -1)); return; }
    if (key === '.' && value.includes('.')) return;   // one decimal only
    if (value === '0' && key !== '.') { onChange(key); return; } // no leading zero
    if (value.length >= 7) return;                              // cap at 7 chars
    onChange(value + key);
  };

  return (
    <div className="grid grid-cols-3 gap-2.5">
      {KEYPAD_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => press(key)}
          disabled={disabled}
          className={`
            h-16 rounded-2xl font-black select-none
            transition-transform active:scale-95 disabled:opacity-40
            ${key === '⌫'
              ? 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300'
              : key === '.'
              ? 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 text-3xl leading-none'
              : 'bg-white border-2 border-zinc-200 text-zinc-900 text-2xl hover:border-zinc-400 shadow-sm active:bg-zinc-50'
            }
          `}
        >
          {key === '⌫' ? <Delete className="w-6 h-6 mx-auto" /> : key}
        </button>
      ))}
    </div>
  );
}

export default function StationMode() {
  const { stationId } = useParams();
  const navigate = useNavigate();
  const { isOnline, pendingCount, requiresForceSync, lastSyncTime, syncOutbox, forceSync, updatePendingCount, duplicateChallenges, resolveDuplicateChallenge } = useOfflineSync();

  const [station, setStation] = useState<Station | null>(null);
  const [athlete, setAthlete] = useState<Athlete | any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(true);
  const [resultValue, setResultValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<number[]>([]);
  const [showOutlierModal, setShowOutlierModal] = useState(false);
  const [outlierReason, setOutlierReason] = useState('');
  const [laneMode, setLaneMode] = useState(false);
  const [queue, setQueue] = useState<any[]>([]);
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [incidentType, setIncidentType] = useState('other');
  const [incidentDesc, setIncidentDesc] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [scoutReviewPending, setScoutReviewPending] = useState<{
    flaggedValue: number;
    reason: string;
    payload: any;
    clientResultId: string;
  } | null>(null);

  // Admin override modal — for BLOCK values (Gates 2 & 3)
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overridePIN, setOverridePIN] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideAttempts, setOverrideAttempts] = useState(0);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [pinSeeded, setPinSeeded] = useState(false);

  // ---------------------------------------------------------------------------
  // Real-time validation — recomputes on every keystroke.
  // Only fires for the 5 drills that have peer-reviewed gate thresholds.
  // ---------------------------------------------------------------------------
  const liveValidation = useMemo(() => {
    if (!station?.drill_type || !resultValue) return null;
    const val = parseFloat(resultValue);
    if (isNaN(val) || val <= 0) return null;
    const drillId = station.drill_type as DrillId;
    if (!BES_ELIGIBLE_DRILLS.has(drillId)) return null;
    return validateResult(drillId, val);
  }, [resultValue, station?.drill_type]);

  // Narrow to the failed branch — TypeScript can't narrow a discriminated union
  // across a ternary, so we extract a typed intermediate first.
  const invalidResult = liveValidation?.valid === false ? liveValidation : null;
  const blockGate   = invalidResult?.gate   ?? null;
  const blockReason = invalidResult?.reason ?? null;

  /** Gates 2 & 3: physically impossible or sensor malfunction — BLOCK submission */
  const isBlocked = blockGate === 'below_physical_floor' || blockGate === 'above_max_threshold';

  /** Gate 4: valid range but extraordinary — FLAG for review (submit enabled) */
  const isFlagged = blockGate === 'extraordinary_result';

  useEffect(() => {
    async function fetchStation() {
      const { data, error } = await supabase
        .from('stations')
        .select('*')
        .eq('id', stationId)
        .single();

      if (data) {
        setStation(data);
        // Seed override PIN hash while we're online and have the event_id.
        if (navigator.onLine) {
          const { data: eventData } = await supabase
            .from('events')
            .select('override_pin')
            .eq('id', data.event_id)
            .single();
          if (eventData?.override_pin) {
            await seedOverridePin(data.event_id, eventData.override_pin);
          }
        }
        const seeded = await isOverridePinSeeded(data.event_id);
        setPinSeeded(seeded);
      }
      setLoading(false);
    }
    fetchStation();
  }, [stationId]);

  // Re-seed the override PIN hash whenever we come back online.
  // Handles: PIN rotation, first load on a device that was offline at station open.
  useEffect(() => {
    if (!isOnline || !station?.event_id) return;
    async function reseedPin() {
      const { data: eventData } = await supabase
        .from('events')
        .select('override_pin')
        .eq('id', station!.event_id)
        .single();
      if (eventData?.override_pin) {
        await seedOverridePin(station!.event_id, eventData.override_pin);
        setPinSeeded(true);
      }
    }
    reseedPin();
  }, [isOnline, station?.event_id]);

  // Restore lane-mode queue from IndexedDB on mount (survives page refresh / crash).
  useEffect(() => {
    if (!stationId) return;
    loadStationQueue(stationId).then(saved => {
      if (saved.length > 0) setQueue(saved);
    });
  }, [stationId]);

  // Persist lane-mode queue to IndexedDB on every change.
  // Runs for any queue length including 0 (clears the stored queue on submit/clear).
  useEffect(() => {
    if (!stationId) return;
    saveStationQueue(stationId, queue);
  }, [queue, stationId]);

  // Auto-dismiss success toast after 1.5 s
  useEffect(() => {
    if (!successToast) return;
    const t = setTimeout(() => setSuccessToast(null), 1500);
    return () => clearTimeout(t);
  }, [successToast]);

  useEffect(() => {
    if (!station) return;

    const deviceLabel = getDeviceId();
    
    async function sendHeartbeat() {
      // Generate HLC once for this heartbeat event, used on both the online
      // and offline paths. This ensures every write — regardless of network
      // state — carries the same deterministic write-order timestamp, so
      // upsert_device_status_hlc() can reject stale offline heartbeats that
      // arrive after a fresher online write (migration 017, v2 §3.1.2).
      const hlcTimestamp = tick();

      const basePayload = {
        event_id:           station.event_id,
        station_id:         station.id,
        device_label:       deviceLabel,
        last_seen_at:       new Date().toISOString(),
        is_online:          navigator.onLine,
        pending_queue_count: pendingCount,
        last_sync_at:       lastSyncTime?.toISOString() || null,
      };

      if (navigator.onLine) {
        // Online path: call the HLC-guarded RPC directly.
        // This prevents a stale queued heartbeat from later overwriting
        // a fresher online write (the RPC enforces strict HLC > current).
        await supabase.rpc('upsert_device_status_hlc', {
          p_event_id:      basePayload.event_id,
          p_station_id:    basePayload.station_id,
          p_device_label:  basePayload.device_label,
          p_last_seen_at:  basePayload.last_seen_at,
          p_is_online:     basePayload.is_online,
          p_pending_count: basePayload.pending_queue_count,
          p_last_sync_at:  basePayload.last_sync_at ?? null,
          p_hlc_timestamp: hlcTimestamp,
        });
      } else {
        // Offline path: queue for later sync. The outbox carries hlc_timestamp
        // so useOfflineSync calls upsert_device_status_hlc when it drains.
        await addToOutbox({
          id:            `heartbeat-${hlcTimestamp}`,
          type:          'device_status',
          payload:       basePayload,
          timestamp:     Date.now(),   // elapsed-time only, not conflict resolution
          attempts:      0,
          hlc_timestamp: hlcTimestamp,
        });
      }
    }

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, [station, pendingCount, lastSyncTime]);

  const handleScan = async (bandId: string) => {
    if (laneMode && queue.length >= 5) {
      setError('Lane queue full (max 5).');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      // Try local cache first
      let athleteData: any = null;
      const cached = await getCachedAthlete(bandId);
      
      if (cached) {
        athleteData = cached;
      } else if (isOnline) {
        const { data, error } = await supabase
          .from('bands')
          .select('*, athletes(*)')
          .eq('band_id', bandId)
          .single();

        if (error || !data || !data.athletes) {
          throw new Error('Athlete not found.');
        }

        athleteData = {
          band_id: bandId,
          athlete_id: data.athletes.id,
          display_number: data.display_number,
          name: `${data.athletes.first_name} ${data.athletes.last_name}`,
          position: data.athletes.position
        };
        await cacheAthlete(athleteData);
      } else {
        athleteData = {
          band_id: bandId,
          display_number: '???',
          name: 'Unknown (Offline)',
          isUnknown: true
        };
      }

      if (laneMode) {
        if (queue.some(a => a.band_id === bandId)) {
          throw new Error('Athlete already in queue.');
        }
        setQueue(prev => [...prev, { ...athleteData, result: '' }]);
      } else {
        setAthlete(athleteData);
        setScanning(false);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (isOutlierConfirmed = false) => {
    if (!resultValue || !athlete) return;

    const drillConfig = DRILL_CATALOG.find(d => d.id === station.drill_type);
    const val = parseFloat(resultValue);

    // Strict numeric guard — reject NaN, zero, and negative values before
    // any gate checks or DB writes. Protects against non-numeric input and
    // malformed data reaching the scoring pipeline.
    if (isNaN(val) || val <= 0) {
      setError('Please enter a valid positive number.');
      return;
    }
    // Phase 2: attempt_number is 1-based, monotonically increasing per athlete
    // per drill per session. The array holds values of prior committed reps.
    const attemptNumber = attempts.length + 1;
    const attemptsAllowed = drillConfig?.attempts_allowed || 1;

    // Outlier check — applies to every rep, not just the final one
    if (drillConfig?.recommended_range && !isOutlierConfirmed) {
      if (val < drillConfig.recommended_range.min || val > drillConfig.recommended_range.max) {
        setShowOutlierModal(true);
        return;
      }
    }

    setSubmitting(true);

    const gateCheck = validateResult(station.drill_type as DrillId, val);

    // Gate 2 & 3 safety net — these should be unreachable in normal flow because
    // the submit button is disabled when isBlocked is true. This guard prevents
    // a blocked value reaching the outbox if there is any race-condition path.
    if (
      gateCheck.valid === false &&
      (gateCheck.gate === 'below_physical_floor' || gateCheck.gate === 'above_max_threshold')
    ) {
      setError('This value is blocked. Use "Request Admin Override" if the reading is accurate.');
      setSubmitting(false);
      return;
    }

    // Gate 4 — extraordinary_result intercept (fail-soft: flag for review, do not discard).
    if (gateCheck.valid === false && gateCheck.gate === 'extraordinary_result') {
      const clientResultId = uuidv4();
      const payload = {
        client_result_id: clientResultId,
        event_id:         station.event_id,
        athlete_id:       athlete.athlete_id,
        band_id:          athlete.band_id,
        station_id:       station.id,
        drill_type:       station.drill_type,
        value_num:        val,
        attempt_number:   attemptNumber,
        meta: {
          outlier:               true,
          outlier_reason:        'scout_review_confirmed',
          extraordinary_result:  true,
          gate4_reason:          gateCheck.reason,
          device_id:             getDeviceId(),
        },
        recorded_at: new Date().toISOString(),
      };
      setScoutReviewPending({ flaggedValue: val, reason: gateCheck.reason, payload, clientResultId });
      setSubmitting(false);
      return;
    }

    const clientResultId = uuidv4();
    // Generate HLC once per rep. Never call tick() twice for the same submission.
    const hlcTimestamp = tick();
    const payload = {
      client_result_id: clientResultId,
      event_id:         station.event_id,
      athlete_id:       athlete.athlete_id,
      band_id:          athlete.band_id,
      station_id:       station.id,
      drill_type:       station.drill_type,
      value_num:        val,
      // Phase 2: each rep is its own immutable row (v1 §3.6.4).
      // Best-of-N is computed at query time — never on the client.
      attempt_number:   attemptNumber,
      meta: {
        outlier:        isOutlierConfirmed,
        outlier_reason: outlierReason || null,
        device_id:      getDeviceId(),
        hlc_timestamp:  hlcTimestamp,
      },
      recorded_at: new Date().toISOString(),
    };

    try {
      await addToOutbox({
        id:            clientResultId,
        type:          'result',
        payload,
        timestamp:     Date.now(),
        attempts:      0,
        hlc_timestamp: hlcTimestamp,
      });

      await updatePendingCount();

      const newAttempts = [...attempts, val];

      if (newAttempts.length >= attemptsAllowed) {
        // All allowed reps committed — toast fires, auto-return to scan
        setSuccessToast(`Saved: ${val} for ${athlete.name}`);
        setAthlete(null);
        setResultValue('');
        setAttempts([]);
        setOutlierReason('');
        setShowOutlierModal(false);
        setScanning(true);
      } else {
        // More reps allowed — stay on same athlete
        setAttempts(newAttempts);
        setResultValue('');
      }
    } catch (err) {
      setError('Failed to save result locally.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleScoutConfirm = async () => {
    if (!scoutReviewPending || !athlete) return;
    setSubmitting(true);
    // Generate HLC for this scout-confirmed rep (was missing before Phase 2)
    const hlcTimestamp = tick();
    try {
      await addToOutbox({
        id:   scoutReviewPending.clientResultId,
        type: 'result',
        payload: {
          ...scoutReviewPending.payload,
          meta: {
            ...scoutReviewPending.payload.meta,
            hlc_timestamp: hlcTimestamp,
          },
        },
        timestamp:     Date.now(),
        attempts:      0,
        hlc_timestamp: hlcTimestamp,
      });

      await updatePendingCount();

      const drillConfig = DRILL_CATALOG.find(d => d.id === station.drill_type);
      const attemptsAllowed = drillConfig?.attempts_allowed || 1;
      const newAttempts = [...attempts, scoutReviewPending.flaggedValue];

      if (newAttempts.length >= attemptsAllowed) {
        setSuccessToast(`Saved: ${scoutReviewPending.flaggedValue} for ${athlete.name}`);
        setScoutReviewPending(null);
        setAthlete(null);
        setResultValue('');
        setAttempts([]);
        setOutlierReason('');
        setShowOutlierModal(false);
        setScanning(true);
      } else {
        // More reps allowed — stay on same athlete
        setAttempts(newAttempts);
        setScoutReviewPending(null);
        setResultValue('');
      }
    } catch (err) {
      setError('Failed to save result locally.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleScoutDiscard = () => {
    setScoutReviewPending(null);
    setResultValue('');
    setAttempts([]);
  };

  // ---------------------------------------------------------------------------
  // Admin override — called when staff submits PIN + reason for a BLOCKED value.
  // Requires: events.override_pin column (see migration: add_override_pin_to_events).
  // Writes to audit_log on every attempt (success and failure).
  // Locks after 3 failed PIN entries.
  // ---------------------------------------------------------------------------
  const handleOverrideConfirm = async () => {
    if (!resultValue || !athlete) return;
    if (overrideAttempts >= 3) return;

    if (!overrideReason.trim()) {
      setOverrideError('A reason is required before an override can be approved.');
      return;
    }
    if (!overridePIN.trim()) {
      setOverrideError('Please enter the admin override PIN.');
      return;
    }

    setOverrideLoading(true);
    setOverrideError(null);

    try {
      // Verify PIN offline — compares PBKDF2 hash of entered PIN against the hash
      // cached in IndexedDB during station load (or on last reconnect). No network needed.
      const pinResult = await verifyOverridePin(station.event_id, overridePIN);

      if (!pinResult.valid) {
        const newAttempts = overrideAttempts + 1;
        setOverrideAttempts(newAttempts);

        if (pinResult.reason?.includes('not cached')) {
          // Hash was never seeded — only happens if the device was never online
          // after the event's PIN was set.
          setOverrideError(pinResult.reason);
          setOverrideLoading(false);
          return;
        }

        const remaining = 3 - newAttempts;
        setOverrideError(
          remaining <= 0
            ? 'Override locked — too many failed PIN attempts. Re-scan the athlete to reset.'
            : `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        );
        setOverridePIN('');
        setOverrideLoading(false);
        return;
      }

      // PIN accepted — build payload with override metadata
      const val = parseFloat(resultValue);
      const attemptNumber = attempts.length + 1;
      const clientResultId = uuidv4();
      const hlcTimestamp = tick();

      const overridePayload = {
        client_result_id: clientResultId,
        event_id:         station.event_id,
        athlete_id:       athlete.athlete_id,
        band_id:          athlete.band_id,
        station_id:       station.id,
        drill_type:       station.drill_type,
        value_num:        val,
        attempt_number:   attemptNumber,
        meta: {
          admin_override:  true,
          override_reason: overrideReason.trim(),
          gate_triggered:  blockGate,
          block_reason:    blockReason,
          device_id:       getDeviceId(),
          hlc_timestamp:   hlcTimestamp,
        },
        recorded_at: new Date().toISOString(),
      };

      await addToOutbox({
        id:            clientResultId,
        type:          'result',
        payload:       overridePayload,
        timestamp:     Date.now(),
        attempts:      0,
        hlc_timestamp: hlcTimestamp,
      });

      // Audit trail — queued through outbox so it persists and syncs offline.
      // The audit_log handler in useOfflineSync will insert this when online.
      await addToOutbox({
        id:   `audit-${clientResultId}`,
        type: 'audit_log',
        payload: {
          action:      'result_override',
          entity_type: 'result',
          entity_id:   clientResultId,
          event_id:    station.event_id,
          new_value: {
            drill_type:      station.drill_type,
            value_num:       val,
            athlete_id:      athlete.athlete_id,
            band_id:         athlete.band_id,
            override_reason: overrideReason.trim(),
            device_id:       getDeviceId(),
          },
          old_value: {
            gate_triggered: blockGate,
            block_reason:   blockReason,
          },
        },
        timestamp:     Date.now(),
        attempts:      0,
        hlc_timestamp: hlcTimestamp,
      });

      await updatePendingCount();

      // Advance attempt state
      const drillConfig = DRILL_CATALOG.find(d => d.id === station.drill_type);
      const attemptsAllowed = drillConfig?.attempts_allowed || 1;
      const newAttemptsList = [...attempts, val];

      // Reset override modal state
      setShowOverrideModal(false);
      setOverridePIN('');
      setOverrideReason('');
      setOverrideAttempts(0);
      setOverrideError(null);

      if (newAttemptsList.length >= attemptsAllowed) {
        setSuccessToast(`Override saved: ${val} for ${athlete.name}`);
        setAthlete(null);
        setResultValue('');
        setAttempts([]);
        setOutlierReason('');
        setScanning(true);
      } else {
        setAttempts(newAttemptsList);
        setResultValue('');
      }
    } catch (err) {
      setOverrideError('Failed to process override. Check your connection and try again.');
    } finally {
      setOverrideLoading(false);
    }
  };

  const handleLaneSubmit = async (index: number) => {
    const item = queue[index];
    if (!item.result) return;

    const laneVal = parseFloat(item.result);
    if (isNaN(laneVal) || laneVal <= 0) {
      setError('Please enter a valid positive number.');
      return;
    }

    // Block physically impossible values in lane mode too
    const laneGate = validateResult(station.drill_type as DrillId, laneVal);
    if (
      laneGate.valid === false &&
      (laneGate.gate === 'below_physical_floor' || laneGate.gate === 'above_max_threshold')
    ) {
      setError(`Blocked: ${laneGate.reason}`);
      return;
    }

    const laneHlcTimestamp = tick();
    const payload = {
      client_result_id: uuidv4(),
      event_id:         station.event_id,
      athlete_id:       item.athlete_id,
      band_id:          item.band_id,
      station_id:       station.id,
      drill_type:       station.drill_type,
      value_num:        laneVal,
      // Lane mode is single-rep — always attempt 1
      attempt_number:   1,
      meta: { device_id: getDeviceId(), hlc_timestamp: laneHlcTimestamp },
      recorded_at: new Date().toISOString(),
    };

    await addToOutbox({
      id: payload.client_result_id,
      type: 'result',
      payload,
      timestamp: Date.now(),
      attempts: 0,
      hlc_timestamp: laneHlcTimestamp,
    });

    await updatePendingCount();
    setQueue(prev => prev.filter((_, i) => i !== index));
  };

  const handleIncidentSubmit = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    
    const { error } = await supabase.from('incidents').insert({
      event_id: station.event_id,
      station_id: station.id,
      athlete_id: athlete?.athlete_id,
      type: incidentType,
      description: incidentDesc,
      severity: incidentSeverity,
      recorded_by: user?.id
    });

    if (error) {
      setError('Failed to log incident.');
    } else {
      setShowIncidentModal(false);
      setIncidentDesc('');
      setIncidentType('other');
      setIncidentSeverity('medium');
    }
  };

  if (loading && !station) return (
    <div className="min-h-screen bg-zinc-50 p-8 space-y-6 animate-pulse">
      <div className="h-8 bg-zinc-200 rounded w-1/3" />
      <div className="h-4 bg-zinc-100 rounded w-1/4" />
      <div className="bg-white rounded-3xl border border-zinc-200 p-8 space-y-4">
        <div className="h-6 bg-zinc-200 rounded w-1/2" />
        <div className="h-32 bg-zinc-100 rounded-2xl" />
      </div>
    </div>
  );

  return (
    <div className="max-w-md mx-auto px-4 py-6 pb-24">
      <header className="flex items-center justify-between mb-6">
        <button onClick={() => navigate('/')} className="flex items-center gap-1 p-2 -ml-2 text-zinc-400 hover:text-zinc-900 transition-colors">
          <ArrowLeft className="w-5 h-5" />
          <span className="text-xs font-bold uppercase tracking-wider">Home</span>
        </button>
        <div className="text-center">
          <h1 className="text-xl font-black uppercase italic tracking-tighter">{station?.name}</h1>
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">{station?.drill_type}</p>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => navigate('/staff/select-station')}
            className="p-2 text-zinc-400 hover:text-zinc-900 transition-colors"
            title="Change Station"
          >
            <LayoutGrid className="w-5 h-5" />
          </button>
          <button 
            onClick={() => setLaneMode(!laneMode)}
            className={`p-2 rounded-lg transition-all ${laneMode ? 'bg-amber-100 text-amber-600' : 'text-zinc-400 hover:bg-zinc-100'}`}
            title="Toggle Lane Mode"
          >
            <Zap className="w-5 h-5" />
          </button>
          <button 
            onClick={() => setShowIncidentModal(true)}
            className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
            title="Flag Incident"
          >
            <ShieldAlert className="w-5 h-5" />
          </button>
          {isOnline ? (
            <Wifi className="w-4 h-4 text-emerald-500" />
          ) : (
            <WifiOff className="w-4 h-4 text-red-500" />
          )}
        </div>
      </header>

      {laneMode && (
        <div className="mb-6 bg-amber-50 border border-amber-100 p-4 rounded-2xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ListOrdered className="w-5 h-5 text-amber-600" />
            <div>
              <div className="text-xs font-bold text-amber-800">Speed Lane Mode</div>
              <div className="text-[10px] text-amber-600 font-medium">Scan up to 5 athletes then enter results.</div>
            </div>
          </div>
          <div className="text-sm font-black text-amber-700">{queue.length}/5</div>
        </div>
      )}

      {/* Sync Status Bar */}
      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between p-3 bg-white rounded-2xl border border-zinc-100 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${pendingCount > 0 ? 'bg-amber-50 text-amber-600' : 'bg-emerald-50 text-emerald-600'}`}>
              <RefreshCw className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase text-zinc-400 leading-none">Pending Sync</div>
              <div className="text-sm font-black">{pendingCount} items</div>
            </div>
          </div>
          <button
            onClick={() => syncOutbox()}
            disabled={!isOnline || pendingCount === 0}
            className="px-3 py-1.5 bg-zinc-900 text-white rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-zinc-800 disabled:opacity-30 transition-all"
          >
            Sync Now
          </button>
        </div>
        {requiresForceSync > 0 && (
          <div className="flex items-center justify-between p-3 bg-red-50 rounded-2xl border border-red-200">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100 text-red-600">
                <AlertCircle className="w-4 h-4" />
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase text-red-500 leading-none">Sync Failed</div>
                <div className="text-sm font-black text-red-700">{requiresForceSync} item{requiresForceSync > 1 ? 's' : ''} stuck</div>
              </div>
            </div>
            <button
              onClick={() => forceSync()}
              disabled={!isOnline}
              className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-[10px] font-bold uppercase tracking-wider hover:bg-red-700 disabled:opacity-40 transition-all"
            >
              Force Sync
            </button>
          </div>
        )}
      </div>

      <AnimatePresence mode="wait">
        {laneMode ? (
          <motion.div 
            key="lane"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
          >
            <div className="bg-zinc-900 text-white p-6 rounded-3xl shadow-xl">
              <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-white/10 rounded-xl">
                  <QrCode className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold">Scan to Queue</h3>
                  <p className="text-zinc-400 text-xs">Athletes will appear below</p>
                </div>
              </div>
              <QRScanner onScan={handleScan} />
            </div>

            <div className="space-y-3">
              {queue.map((item, index) => (
                <motion.div 
                  key={item.band_id}
                  layout
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-4 rounded-2xl border border-zinc-200 shadow-sm flex items-center gap-4"
                >
                  <div className="w-10 h-10 bg-zinc-100 rounded-lg flex items-center justify-center font-black text-zinc-400">
                    {item.display_number}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate text-sm">{item.name}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input 
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={item.result}
                      onChange={(e) => {
                        const newQueue = [...queue];
                        newQueue[index].result = e.target.value;
                        setQueue(newQueue);
                      }}
                      className="w-20 p-2 bg-zinc-50 border border-zinc-100 rounded-xl font-black text-center outline-none focus:border-zinc-900"
                      placeholder="0.00"
                    />
                    <button 
                      onClick={() => handleLaneSubmit(index)}
                      disabled={!item.result}
                      className="p-2 bg-zinc-900 text-white rounded-xl disabled:opacity-30"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => setQueue(prev => prev.filter((_, i) => i !== index))}
                      className="p-2 text-zinc-400 hover:text-red-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>
              ))}
              {queue.length === 0 && (
                <div className="py-12 text-center text-zinc-400 text-sm border-2 border-dashed border-zinc-200 rounded-3xl">
                  Queue is empty. Scan an athlete to begin.
                </div>
              )}
            </div>
          </motion.div>
        ) : scanning ? (
          <motion.div 
            key="scan"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="space-y-6"
          >
            <div className="bg-zinc-900 text-white p-6 rounded-3xl shadow-xl">
              <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-white/10 rounded-xl">
                  <QrCode className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-bold">Scan Athlete</h3>
                  <p className="text-zinc-400 text-xs">Ready for next participant</p>
                </div>
              </div>
              <QRScanner onScan={handleScan} />
            </div>

          </motion.div>
        ) : (
          <motion.div 
            key="input"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="space-y-6"
          >
            <div className="bg-white p-6 rounded-3xl border border-zinc-200 shadow-xl">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-16 h-16 bg-zinc-100 rounded-2xl flex items-center justify-center text-3xl font-black">
                  {athlete.display_number}
                </div>
                <div>
                  <h2 className="text-xl font-bold">{athlete.name}</h2>
                  <p className="text-zinc-500 text-sm">{athlete.position || 'No Position'}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      Attempt {attempts.length + 1} of {DRILL_CATALOG.find(d => d.id === station.drill_type)?.attempts_allowed || 1}
                    </label>
                    {attempts.length > 0 && (
                      <div className="flex gap-1">
                        {attempts.map((a, i) => (
                          <span key={i} className="px-2 py-0.5 bg-zinc-100 rounded text-[10px] font-bold text-zinc-400">
                            A{i+1}: {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Value display — driven by the keypad; no native keyboard needed */}
                  <div className={`w-full px-6 py-5 text-5xl font-black rounded-2xl text-center border-2 transition-colors min-h-[88px] flex items-center justify-center ${
                    isBlocked
                      ? 'bg-red-50 border-red-400 text-red-700'
                      : isFlagged
                      ? 'bg-amber-50 border-amber-400 text-amber-700'
                      : 'bg-zinc-50 border-zinc-200 text-zinc-900'
                  }`}>
                    {resultValue || <span className="text-zinc-300 text-4xl font-black">—</span>}
                  </div>
                  {/* Oversized numeric keypad — always visible, zero layout shift */}
                  <NumericKeypad
                    value={resultValue}
                    onChange={setResultValue}
                    disabled={submitting}
                  />
                </div>

                {/* ── Inline validation banner ─────────────────────────── */}
                {isBlocked && (
                  <div className="rounded-2xl overflow-hidden border-2 border-red-500 shadow-lg shadow-red-100">
                    <div className="bg-red-600 px-4 py-3 flex items-center gap-3">
                      <AlertTriangle className="w-5 h-5 text-white shrink-0" />
                      <span className="text-white font-black text-sm uppercase tracking-wider">
                        BLOCKED — {blockGate === 'below_physical_floor' ? 'Sensor Error / Below Minimum' : 'Sensor Malfunction / Above Maximum'}
                      </span>
                    </div>
                    <div className="bg-red-50 px-4 py-3">
                      <p className="text-sm text-red-800 font-medium leading-snug">
                        {blockGate === 'below_physical_floor'
                          ? `${resultValue} is below the physical minimum for this drill. Re-enter or request an override if the reading is accurate.`
                          : `${resultValue} exceeds the maximum plausible value for this drill. Re-enter or request an override if the reading is accurate.`}
                      </p>
                    </div>
                    {overrideAttempts < 3 ? (
                      <button
                        type="button"
                        onClick={() => { setShowOverrideModal(true); setOverrideError(null); }}
                        className="w-full h-14 bg-red-600 text-white font-black text-sm uppercase tracking-wider hover:bg-red-700 active:bg-red-800 transition-colors flex items-center justify-center gap-2"
                      >
                        <ShieldAlert className="w-4 h-4" />
                        Request Admin Override
                      </button>
                    ) : (
                      <div className="h-10 bg-red-100 flex items-center justify-center text-xs text-red-600 font-black uppercase tracking-wider">
                        Override locked — too many failed PIN attempts
                      </div>
                    )}
                  </div>
                )}

                {isFlagged && (
                  <div className="rounded-2xl overflow-hidden border-2 border-amber-400">
                    <div className="bg-amber-500 px-4 py-3 flex items-center gap-3">
                      <AlertCircle className="w-5 h-5 text-white shrink-0" />
                      <span className="text-white font-black text-sm uppercase tracking-wider">
                        Extraordinary Result — Flagged for Scout Review
                      </span>
                    </div>
                    <div className="bg-amber-50 px-4 py-3">
                      <p className="text-sm text-amber-800 font-medium leading-snug">
                        World-record territory. Result will be saved and routed to scout review before appearing on leaderboards.
                      </p>
                    </div>
                  </div>
                )}
                {/* ─────────────────────────────────────────────────────── */}

                <div className="flex gap-3">
                  <button
                    onClick={() => { setAthlete(null); setResultValue(''); setScanning(true); }}
                    className="flex-1 h-16 border-2 border-zinc-200 rounded-2xl font-bold text-zinc-500 hover:bg-zinc-50 active:scale-95 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleSubmit()}
                    disabled={!resultValue || submitting || isBlocked}
                    className="flex-[2] h-16 bg-zinc-900 text-white rounded-2xl font-black text-lg shadow-lg flex items-center justify-center gap-2 disabled:opacity-40 active:scale-95 transition-all"
                  >
                    {submitting ? 'Saving…' : isFlagged ? 'Submit & Flag' : 'Submit Result'}
                    {!submitting && <Send className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm">
                <AlertCircle className="w-5 h-5" />
                {error}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showIncidentModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-zinc-900/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white w-full max-w-md rounded-3xl p-8 space-y-6 shadow-2xl"
            >
              <div className="flex items-center gap-3 text-red-600">
                <ShieldAlert className="w-6 h-6" />
                <h3 className="text-xl font-bold">Flag Incident</h3>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Incident Type</label>
                  <select 
                    value={incidentType}
                    onChange={(e) => setIncidentType(e.target.value)}
                    className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none"
                  >
                    <option value="injury">Injury</option>
                    <option value="equipment">Equipment Failure</option>
                    <option value="behavior">Athlete Behavior</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Severity</label>
                  <div className="grid grid-cols-4 gap-2">
                    {(['low', 'medium', 'high', 'critical'] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setIncidentSeverity(s)}
                        className={`py-2 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${
                          incidentSeverity === s ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-zinc-50 text-zinc-500 border-zinc-100'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Description</label>
                  <textarea 
                    value={incidentDesc}
                    onChange={(e) => setIncidentDesc(e.target.value)}
                    className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none h-24 resize-none"
                    placeholder="Describe what happened..."
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => setShowIncidentModal(false)}
                  className="flex-1 py-3 border border-zinc-200 rounded-xl font-bold text-zinc-500"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleIncidentSubmit}
                  disabled={!incidentDesc}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-200 disabled:opacity-50"
                >
                  Log Incident
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showOutlierModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-zinc-900/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white w-full max-w-sm rounded-3xl p-8 space-y-6 shadow-2xl"
            >
              <div className="text-center space-y-2">
                <div className="w-16 h-16 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <AlertTriangle className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold">Outlier Detected</h3>
                <p className="text-zinc-500 text-sm">This value is outside the recommended range. Is this correct?</p>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Reason (Optional)</label>
                <div className="grid grid-cols-2 gap-2">
                  {['slip', 'false start', 'trip', 'other'].map(reason => (
                    <button
                      key={reason}
                      onClick={() => setOutlierReason(reason)}
                      className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                        outlierReason === reason ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-zinc-50 text-zinc-500 border-zinc-100 hover:bg-zinc-100'
                      }`}
                    >
                      {reason.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  onClick={() => setShowOutlierModal(false)}
                  className="flex-1 py-3 border border-zinc-200 rounded-xl font-bold text-zinc-500"
                >
                  Edit Value
                </button>
                <button 
                  onClick={() => handleSubmit(true)}
                  className="flex-1 py-3 bg-zinc-900 text-white rounded-xl font-bold"
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {scoutReviewPending && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-zinc-900/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white w-full max-w-sm rounded-3xl p-8 space-y-6 shadow-2xl"
            >
              <div className="text-center space-y-2">
                <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShieldAlert className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold">Scout Review Required</h3>
                <p className="text-zinc-500 text-sm">This result requires manual confirmation before it can be recorded.</p>
              </div>

              <div className="bg-zinc-50 rounded-2xl p-4 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold uppercase text-zinc-400">Flagged Value</span>
                  <span className="text-lg font-black text-zinc-900">{scoutReviewPending.flaggedValue}</span>
                </div>
                <div className="pt-1 border-t border-zinc-200">
                  <p className="text-xs text-zinc-500 leading-relaxed">{scoutReviewPending.reason}</p>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleScoutDiscard}
                  className="flex-1 py-3 border border-zinc-200 rounded-xl font-bold text-zinc-500 hover:bg-zinc-50 transition-colors"
                >
                  Discard
                </button>
                <button
                  onClick={handleScoutConfirm}
                  disabled={submitting}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-200 hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {submitting ? 'Saving...' : 'Confirm Result'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Admin Override Modal ─────────────────────────────────────── */}
      <AnimatePresence>
        {showOverrideModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-zinc-900/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              className="bg-white w-full max-w-sm rounded-3xl p-8 space-y-6 shadow-2xl"
            >
              <div className="text-center space-y-2">
                <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShieldAlert className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold">Admin Override Required</h3>
                <p className="text-zinc-500 text-sm">
                  This value was blocked by the validation system. An admin PIN and a reason are required to save it.
                </p>
              </div>

              {/* Blocked value summary */}
              <div className="bg-red-50 border border-red-200 rounded-2xl p-4 space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold uppercase text-zinc-400">Blocked Value</span>
                  <span className="text-lg font-black text-red-700">{resultValue}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold uppercase text-zinc-400">Gate</span>
                  <span className="text-xs font-bold text-red-600 uppercase">{blockGate?.replace(/_/g, ' ')}</span>
                </div>
              </div>

              <div className="space-y-4">
                {/* Override reason — required */}
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    Reason for Override <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    className="w-full p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none text-sm"
                  >
                    <option value="">Select a reason…</option>
                    <option value="Verified by second official">Verified by second official</option>
                    <option value="Sensor recalibrated, reading confirmed">Sensor recalibrated, reading confirmed</option>
                    <option value="Video review confirms result">Video review confirms result</option>
                    <option value="Manual timing confirms result">Manual timing confirms result</option>
                    <option value="Other (documented separately)">Other (documented separately)</option>
                  </select>
                </div>

                {/* Admin PIN */}
                <div className="space-y-1">
                  <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    Admin Override PIN <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={overridePIN}
                    onChange={(e) => setOverridePIN(e.target.value.replace(/\D/g, ''))}
                    disabled={overrideAttempts >= 3}
                    className="w-full p-4 text-2xl font-black tracking-widest bg-zinc-50 border-2 border-zinc-200 rounded-xl outline-none focus:border-zinc-900 text-center disabled:opacity-40"
                    placeholder="• • • • • •"
                    autoComplete="off"
                  />
                  {overrideAttempts > 0 && overrideAttempts < 3 && (
                    <p className="text-xs text-zinc-400 text-right">
                      Attempt {overrideAttempts} of 3
                    </p>
                  )}
                </div>

                {overrideError && (
                  <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-bold">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {overrideError}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    setShowOverrideModal(false);
                    setOverridePIN('');
                    setOverrideReason('');
                    setOverrideError(null);
                  }}
                  className="flex-1 py-3 border border-zinc-200 rounded-xl font-bold text-zinc-500 hover:bg-zinc-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleOverrideConfirm}
                  disabled={overrideLoading || overrideAttempts >= 3 || !overrideReason || !overridePIN}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg shadow-red-200 hover:bg-red-700 disabled:opacity-40 transition-colors"
                >
                  {overrideLoading ? 'Verifying…' : 'Approve Override'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* ─────────────────────────────────────────────────────────────── */}

      <div className="fixed bottom-20 left-0 right-0 px-4 pointer-events-none">
        <div className="max-w-md mx-auto flex justify-center">
          <button
            onClick={() => setScanning(true)}
            disabled={scanning}
            className="pointer-events-auto bg-white border border-zinc-200 shadow-lg px-6 py-3 rounded-full text-sm font-bold flex items-center gap-2 hover:bg-zinc-50 disabled:opacity-0 transition-opacity"
          >
            <RefreshCw className="w-4 h-4" />
            Reset Scanner
          </button>
        </div>
      </div>

      {/* ── Success Toast — auto-dismisses after 1.5 s, non-blocking ─── */}
      <AnimatePresence>
        {successToast && (
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.18 }}
            className="fixed top-4 left-4 right-4 z-[60] max-w-md mx-auto pointer-events-none"
          >
            <div className={`px-5 py-4 rounded-2xl shadow-2xl flex items-center gap-3 ${
              successToast.startsWith('Override')
                ? 'bg-orange-600 text-white'
                : 'bg-zinc-900 text-white'
            }`}>
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <span className="font-bold text-sm">{successToast}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* ── Duplicate Record Challenge Modal ────────────────────────── */}
      {duplicateChallenges.length > 0 && (() => {
        const challenge = duplicateChallenges[0];
        const drillConfig = DRILL_CATALOG.find(d => d.id === challenge.drillType);
        const label = drillConfig?.label ?? challenge.drillType;
        const unit  = drillConfig?.unit  ?? '';
        const fmtVal = (v: number) => (unit === 'sec') ? v.toFixed(2) : v.toString();
        const recAt = new Date(challenge.existingRecordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return (
          <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="bg-amber-500 px-6 py-4 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
                  <span className="text-white font-black text-sm">!</span>
                </div>
                <div>
                  <p className="font-black text-white text-sm uppercase tracking-wider">Duplicate Record Detected</p>
                  <p className="text-amber-100 text-xs">Same athlete · same drill · within 2 minutes</p>
                </div>
              </div>

              {/* Comparison */}
              <div className="px-6 py-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-zinc-100 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1">Existing Record</p>
                    <p className="font-mono font-black text-2xl tabular-nums text-zinc-900">{fmtVal(challenge.existingValue)}<span className="text-xs font-bold text-zinc-400 ml-1">{unit}</span></p>
                    <p className="text-[10px] text-zinc-400 mt-1">Attempt {challenge.existingAttemptNum} · {recAt}</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-center">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-amber-500 mb-1">New Reading</p>
                    <p className="font-mono font-black text-2xl tabular-nums text-zinc-900">{fmtVal(challenge.newValue)}<span className="text-xs font-bold text-zinc-400 ml-1">{unit}</span></p>
                    <p className="text-[10px] text-zinc-400 mt-1">{label} · pending</p>
                  </div>
                </div>

                <p className="text-xs text-zinc-500 text-center">
                  Delta: <span className="font-mono font-bold text-zinc-700">{Math.abs(challenge.newValue - challenge.existingValue).toFixed(2)}{unit}</span>
                  {' '}({((Math.abs(challenge.newValue - challenge.existingValue) / challenge.existingValue) * 100).toFixed(1)}%)
                </p>
              </div>

              {/* Actions */}
              <div className="px-6 pb-6 space-y-2">
                <button
                  onClick={() => resolveDuplicateChallenge(challenge.itemId, 'keep_both')}
                  className="w-full py-3 bg-zinc-900 text-white rounded-2xl font-bold text-sm hover:bg-zinc-700 transition-colors"
                >
                  Keep Both — Save as Attempt {challenge.existingAttemptNum + 1}
                </button>
                <button
                  onClick={() => resolveDuplicateChallenge(challenge.itemId, 'replace')}
                  className="w-full py-3 bg-white border border-zinc-200 text-zinc-900 rounded-2xl font-bold text-sm hover:bg-zinc-50 transition-colors"
                >
                  Replace Existing with New Reading
                </button>
                <button
                  onClick={() => resolveDuplicateChallenge(challenge.itemId, 'discard')}
                  className="w-full py-3 text-zinc-400 rounded-2xl font-bold text-sm hover:text-zinc-700 transition-colors"
                >
                  Discard New Reading
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* ─────────────────────────────────────────────────────────────── */}
    </div>
  );
}
