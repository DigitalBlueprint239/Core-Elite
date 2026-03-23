import { useEffect, useState, useCallback } from 'react';
import {
  getPendingOutboxItems,
  getOutboxItems,
  removeFromOutbox,
  resetFailedOutboxItems,
  updateOutboxItem,
} from '../lib/offline';
import { supabase } from '../lib/supabase';

const MAX_RETRY_ATTEMPTS = 5;

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  const updatePendingCount = useCallback(async () => {
    const items = await getOutboxItems();
    setPendingCount(items.filter(item => item.status !== 'failed').length);
    setFailedCount(items.filter(item => item.status === 'failed').length);
  }, []);

  const markSyncFailure = useCallback(async (itemId: string, currentAttempts: number, message: string) => {
    const nextAttempts = currentAttempts + 1;
    await updateOutboxItem(itemId, {
      attempts: nextAttempts,
      last_error: message,
      status: nextAttempts >= MAX_RETRY_ATTEMPTS ? 'failed' : 'pending',
    });
    setLastSyncError(message);
  }, []);

  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    const { data: { session } } = await supabase.auth.getSession();
    const items = await getPendingOutboxItems();

    if (items.length === 0) {
      await updatePendingCount();
      return;
    }

    setLastSyncError(null);

    for (const item of items) {
      try {
        if (item.type === 'result') {
          if (!session) {
            await markSyncFailure(item.id, item.attempts || 0, 'Staff session expired. Log in again before syncing queued items.');
            continue;
          }

          const { data, error } = await supabase.rpc('submit_result_atomic', {
            p_client_result_id: item.payload.client_result_id,
            p_event_id: item.payload.event_id,
            p_athlete_id: item.payload.athlete_id,
            p_band_id: item.payload.band_id,
            p_station_id: item.payload.station_id,
            p_drill_type: item.payload.drill_type,
            p_value_num: item.payload.value_num,
            p_meta: item.payload.meta || {},
            p_recorded_at: item.payload.recorded_at,
          });
          const result = Array.isArray(data) ? data[0] : data;

          if (!error && result) {
            await removeFromOutbox(item.id);

            try {
              const [{ data: athleteResults }, { data: eventData }] = await Promise.all([
                supabase.from('results').select('drill_type').eq('athlete_id', item.payload.athlete_id),
                supabase.from('events').select('required_drills').eq('id', item.payload.event_id).single()
              ]);

              if (athleteResults && eventData?.required_drills) {
                const completedDrills = new Set(athleteResults.map(r => r.drill_type));
                const allDone = eventData.required_drills.every((d: string) => completedDrills.has(d));

                if (allDone) {
                  await supabase.from('report_jobs').upsert({
                    athlete_id: item.payload.athlete_id,
                    event_id: item.payload.event_id,
                    status: 'pending'
                  }, { onConflict: 'athlete_id' });
                }
              }
            } catch (e) {
              console.error('Report trigger check failed', e);
            }
          } else if (error?.code === '23505') {
            await removeFromOutbox(item.id);
          } else {
            await markSyncFailure(item.id, item.attempts || 0, error?.message || 'Result sync failed.');
          }
        } else if (item.type === 'device_status') {
          const { error } = await supabase.from('device_status').upsert(item.payload);
          if (!error) {
            await removeFromOutbox(item.id);
          } else {
            await markSyncFailure(item.id, item.attempts || 0, error.message || 'Device heartbeat sync failed.');
          }
        }
      } catch (err: any) {
        await markSyncFailure(item.id, item.attempts || 0, err?.message || 'Unexpected sync failure.');
      }
    }

    await updatePendingCount();
    setLastSyncTime(new Date());
  }, [markSyncFailure, updatePendingCount]);

  const retryFailedItems = useCallback(async () => {
    await resetFailedOutboxItems();
    await updatePendingCount();
    if (navigator.onLine) {
      await syncOutbox();
    }
  }, [syncOutbox, updatePendingCount]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncOutbox();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    updatePendingCount();

    const interval = setInterval(() => {
      if (navigator.onLine) syncOutbox();
      updatePendingCount();
    }, 30000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [syncOutbox, updatePendingCount]);

  return {
    isOnline,
    pendingCount,
    failedCount,
    lastSyncTime,
    lastSyncError,
    syncOutbox,
    retryFailedItems,
    updatePendingCount,
  };
}
