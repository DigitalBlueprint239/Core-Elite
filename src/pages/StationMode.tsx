import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Station, Athlete } from '../lib/types';
import { QRScanner } from '../components/QRScanner';
import { addToOutbox, getCachedAthlete, cacheAthlete } from '../lib/offline';
import { useOfflineSync } from '../hooks/useOfflineSync';
import { motion, AnimatePresence } from 'motion/react';
import { QrCode, User, Send, RefreshCw, ChevronLeft, AlertCircle, CheckCircle2, Wifi, WifiOff, History, AlertTriangle, Zap, ListOrdered, X, ShieldAlert, ArrowLeft, LayoutGrid } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { getDeviceId } from '../lib/device';
import { DRILL_CATALOG } from '../constants';

export default function StationMode() {
  const { stationId } = useParams();
  const navigate = useNavigate();
  const { isOnline, pendingCount, lastSyncTime, syncOutbox, updatePendingCount } = useOfflineSync();

  const [station, setStation] = useState<Station | null>(null);
  const [athlete, setAthlete] = useState<Athlete | any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(true);
  const [resultValue, setResultValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSubmitted, setLastSubmitted] = useState<any>(null);
  const [attempts, setAttempts] = useState<number[]>([]);
  const [showOutlierModal, setShowOutlierModal] = useState(false);
  const [outlierReason, setOutlierReason] = useState('');
  const [laneMode, setLaneMode] = useState(false);
  const [queue, setQueue] = useState<any[]>([]);
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [incidentType, setIncidentType] = useState('other');
  const [incidentDesc, setIncidentDesc] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');

  useEffect(() => {
    async function fetchStation() {
      const { data, error } = await supabase
        .from('stations')
        .select('*')
        .eq('id', stationId)
        .single();
      
      if (data) setStation(data);
      setLoading(false);
    }
    fetchStation();
  }, [stationId]);

  useEffect(() => {
    if (!station) return;

    const deviceLabel = getDeviceId();
    
    async function sendHeartbeat() {
      const payload = {
        event_id: station.event_id,
        station_id: station.id,
        device_label: deviceLabel,
        last_seen_at: new Date().toISOString(),
        is_online: navigator.onLine,
        pending_queue_count: pendingCount,
        last_sync_at: lastSyncTime?.toISOString() || null
      };

      if (navigator.onLine) {
        await supabase.from('device_status').upsert(payload);
      } else {
        // Queue heartbeat for later if offline
        await addToOutbox({
          id: `heartbeat-${Date.now()}`,
          type: 'device_status',
          payload,
          timestamp: Date.now(),
          attempts: 0
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

    // Outlier check
    if (drillConfig?.recommended_range && !isOutlierConfirmed) {
      if (val < drillConfig.recommended_range.min || val > drillConfig.recommended_range.max) {
        setShowOutlierModal(true);
        return;
      }
    }

    setSubmitting(true);

    const newAttempts = [...attempts, val];
    const attemptsAllowed = drillConfig?.attempts_allowed || 1;
    
    // If more attempts allowed, just save to local state and reset input
    if (newAttempts.length < attemptsAllowed) {
      setAttempts(newAttempts);
      setResultValue('');
      setSubmitting(false);
      return;
    }

    // Final submission
    let finalValue = val;
    if (drillConfig?.use_best_attempt) {
      // Lower is better for sec, higher for others
      if (drillConfig.unit === 'sec') {
        finalValue = Math.min(...newAttempts);
      } else {
        finalValue = Math.max(...newAttempts);
      }
    }

    const clientResultId = uuidv4();
    const payload = {
      client_result_id: clientResultId,
      event_id: station.event_id,
      athlete_id: athlete.athlete_id,
      band_id: athlete.band_id,
      station_id: station.id,
      drill_type: station.drill_type,
      value_num: finalValue,
      meta: {
        attempts: newAttempts,
        outlier: isOutlierConfirmed,
        outlier_reason: outlierReason || null,
        device_id: getDeviceId()
      },
      recorded_at: new Date().toISOString()
    };

    try {
      await addToOutbox({
        id: clientResultId,
        type: 'result',
        payload,
        timestamp: Date.now(),
        attempts: 0
      });

      await updatePendingCount();
      
      setLastSubmitted({
        athleteName: athlete.name,
        athleteNumber: athlete.display_number,
        value: finalValue,
        attempts: newAttempts
      });

      // Reset for next athlete
      setAthlete(null);
      setResultValue('');
      setAttempts([]);
      setOutlierReason('');
      setShowOutlierModal(false);
      setScanning(true);
    } catch (err) {
      setError('Failed to save result locally.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLaneSubmit = async (index: number) => {
    const item = queue[index];
    if (!item.result) return;

    const payload = {
      client_result_id: uuidv4(),
      event_id: station.event_id,
      athlete_id: item.athlete_id,
      band_id: item.band_id,
      station_id: station.id,
      drill_type: station.drill_type,
      value_num: parseFloat(item.result),
      meta: { device_id: getDeviceId() },
      recorded_at: new Date().toISOString()
    };

    await addToOutbox({
      id: payload.client_result_id,
      type: 'result',
      payload,
      timestamp: Date.now(),
      attempts: 0
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

  if (loading && !station) return <div className="p-8 text-center">Loading station...</div>;

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
      <div className="mb-6 flex items-center justify-between p-3 bg-white rounded-2xl border border-zinc-100 shadow-sm">
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

            {lastSubmitted && (
              <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <div className="text-sm">
                  <span className="font-bold text-emerald-800">Saved:</span> {lastSubmitted.athleteName} (#{lastSubmitted.athleteNumber}) - {lastSubmitted.value}
                </div>
              </div>
            )}
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
                  <input 
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={resultValue}
                    onChange={(e) => setResultValue(e.target.value)}
                    className="w-full p-6 text-4xl font-black bg-zinc-50 border-2 border-zinc-100 rounded-2xl outline-none focus:border-zinc-900 text-center"
                    placeholder="0.00"
                    autoFocus
                  />
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={() => { setAthlete(null); setScanning(true); }}
                    className="flex-1 py-4 border border-zinc-200 rounded-2xl font-bold text-zinc-500 hover:bg-zinc-50"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => handleSubmit()}
                    disabled={!resultValue || submitting}
                    className="flex-[2] py-4 bg-zinc-900 text-white rounded-2xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {submitting ? 'Saving...' : 'Submit Result'}
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
    </div>
  );
}
