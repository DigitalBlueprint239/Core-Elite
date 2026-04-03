import { useEffect, useState, useCallback } from 'react';
import { getOutboxItems, removeFromOutbox, updateOutboxItem, OutboxItem } from '../lib/offline';
import { supabase } from '../lib/supabase';
import { update as updateHlc } from '../lib/hlc';
// lww.ts (addBiasedShouldKeep, deviceStatusShouldUpdate) wired in Phase 4
// when the pull path is added. The add-biased principle is applied below
// through logic rather than a direct function call.

const MAX_RETRIES = 5;

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  const updatePendingCount = useCallback(async () => {
    const items = await getOutboxItems();
    setPendingCount(items.filter(i => i.status !== 'dead_letter').length);
  }, []);

  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    const items = await getOutboxItems();
    const syncableItems = items.filter(i => i.status === 'pending' || i.status === 'retrying');
    
    if (syncableItems.length === 0) return;

    console.log(`Syncing ${syncableItems.length} items...`);

    for (const item of syncableItems) {
      // Check if item is ready for retry (exponential backoff)
      if (item.retry_count > 0 && item.last_attempt_at) {
        const backoffMs = Math.pow(2, item.retry_count) * 1000;
        if (Date.now() - item.last_attempt_at < backoffMs) {
          continue;
        }
      }

      try {
        let success = false;
        let errorMsg = '';

        if (item.type === 'result') {
          // Pass hlc_timestamp in meta so the server records the deterministic
          // write timestamp for any future server-side LWW conflict resolution.
          const metaWithHlc = {
            ...(item.payload.meta || {}),
            hlc_timestamp: item.hlc_timestamp,
          };

          const { data, error } = await supabase.rpc('submit_result_secure', {
            p_client_result_id: item.id,
            p_event_id: item.payload.event_id,
            p_athlete_id: item.payload.athlete_id,
            p_band_id: item.payload.band_id,
            p_station_id: item.payload.station_id,
            p_drill_type: item.payload.drill_type,
            p_value_num: item.payload.value_num,
            p_meta: metaWithHlc,
          });

          if (!error && data?.success) {
            // Advance local HLC to stay ahead of any clock we've successfully synced.
            // This ensures future writes on this device are always ordered after
            // this confirmed server write (v2 §3.1.3 receive-event rule).
            if (item.hlc_timestamp) updateHlc(item.hlc_timestamp);
            success = true;
          } else {
            errorMsg = error?.message || data?.error || 'Unknown RPC error';
            // Add-biased LWW (v2 §3.1.2): a duplicate response means the server
            // already has this record — the add operation succeeded on a prior sync.
            // addBiasedShouldKeep returns true when add_hlc >= remove_hlc (always true
            // for a straight duplicate where no delete has occurred).
            // Treat as success: never discard a timing result.
            if (
              errorMsg.includes('duplicate') ||
              (data && data.status === 'duplicate')
            ) {
              if (item.hlc_timestamp) updateHlc(item.hlc_timestamp);
              success = true;
            }
          }
        } else if (item.type === 'device_status') {
          // device_status is a mutable upsert — LWW applies.
          // deviceStatusShouldUpdate ensures a stale heartbeat from a reconnecting
          // tablet doesn't overwrite a more recent heartbeat from the same station.
          // The payload already carries hlc_timestamp in meta; the upsert proceeds
          // regardless (Supabase's upsert handles the row-level overwrite).
          const { error } = await supabase.from('device_status').upsert(item.payload);
          if (!error) {
            if (item.hlc_timestamp) updateHlc(item.hlc_timestamp);
            success = true;
          } else {
            errorMsg = error.message;
          }
        }

        if (success) {
          await removeFromOutbox(item.id);
        } else {
          // Handle failure with retry logic
          const updatedItem: OutboxItem = {
            ...item,
            retry_count: item.retry_count + 1,
            last_attempt_at: Date.now(),
            error_message: errorMsg,
            status: item.retry_count + 1 >= MAX_RETRIES ? 'dead_letter' : 'retrying'
          };
          await updateOutboxItem(updatedItem);
        }
      } catch (err: any) {
        console.error('Failed to sync item', item.id, err);
        const updatedItem: OutboxItem = {
          ...item,
          retry_count: item.retry_count + 1,
          last_attempt_at: Date.now(),
          error_message: err.message,
          status: item.retry_count + 1 >= MAX_RETRIES ? 'dead_letter' : 'retrying'
        };
        await updateOutboxItem(updatedItem);
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
