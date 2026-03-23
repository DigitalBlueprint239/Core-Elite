import { useEffect, useState, useCallback } from 'react';
import { getOutboxItems, removeFromOutbox, OutboxItem } from '../lib/offline';
import { supabase } from '../lib/supabase';

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  const updatePendingCount = useCallback(async () => {
    const items = await getOutboxItems();
    setPendingCount(items.length);
  }, []);

  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    const items = await getOutboxItems();
    if (items.length === 0) return;

    console.log(`Syncing ${items.length} items...`);

    for (const item of items) {
      try {
        if (item.type === 'result') {
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
          // If duplicate or already inserted, we still remove it from outbox
          if (!error && result) {
            await removeFromOutbox(item.id);

            // Check if athlete has completed all drills to trigger report
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
            console.error('Sync error for item', item.id, error);
          }
        } else if (item.type === 'device_status') {
          const { error } = await supabase.from('device_status').upsert(item.payload);
          if (!error) {
            await removeFromOutbox(item.id);
          }
        }
      } catch (err) {
        console.error('Failed to sync item', item.id, err);
      }
    }

    await updatePendingCount();
    setLastSyncTime(new Date());
  }, [updatePendingCount]);

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

  return { isOnline, pendingCount, lastSyncTime, syncOutbox, updatePendingCount };
}
