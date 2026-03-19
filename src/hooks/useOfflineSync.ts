import { useEffect, useState, useCallback } from 'react';
import {
  getOutboxItems,
  getAllOutboxItems,
  removeFromOutbox,
  updateOutboxItem,
  OutboxItem,
  MAX_RETRIES,
  computeNextRetryAt,
} from '../lib/offline';
import { supabase } from '../lib/supabase';

// ---------------------------------------------------------------------------
// Dev-only logger -- never surfaces to public UI
// ---------------------------------------------------------------------------
function logDev(message: string, ...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.log(`[OfflineSync] ${message}`, ...args);
  }
}
function logDevError(message: string, ...args: unknown[]): void {
  if (import.meta.env.DEV) {
    console.error(`[OfflineSync] ${message}`, ...args);
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [retryingCount, setRetryingCount] = useState(0);
  const [deadLetterCount, setDeadLetterCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // -------------------------------------------------------------------------
  // Refresh diagnostic counts from the full outbox (all statuses)
  // -------------------------------------------------------------------------
  const updateCounts = useCallback(async () => {
    const all = await getAllOutboxItems();
    setPendingCount(all.filter((i) => i.status === 'pending').length);
    setRetryingCount(all.filter((i) => i.status === 'retrying').length);
    setDeadLetterCount(all.filter((i) => i.status === 'dead_letter').length);
  }, []);

  // -------------------------------------------------------------------------
  // Attempt to sync a single 'result' item
  // -------------------------------------------------------------------------
  const syncResultItem = useCallback(async (item: OutboxItem): Promise<boolean> => {
    const { error } = await supabase.from('results').insert(item.payload);

    if (!error || error.code === '23505') {
      // Success or idempotent duplicate -- remove from outbox
      await removeFromOutbox(item.id);

      // Trigger report-completion check (best-effort; failure is non-fatal)
      try {
        const [{ data: athleteResults }, { data: eventData }] = await Promise.all([
          supabase
            .from('results')
            .select('drill_type')
            .eq('athlete_id', item.payload.athlete_id),
          supabase
            .from('events')
            .select('required_drills')
            .eq('id', item.payload.event_id)
            .single(),
        ]);

        if (athleteResults && eventData?.required_drills) {
          const completedDrills = new Set(athleteResults.map((r: { drill_type: string }) => r.drill_type));
          const allDone = eventData.required_drills.every((d: string) => completedDrills.has(d));
          if (allDone) {
            await supabase.from('report_jobs').upsert(
              {
                athlete_id: item.payload.athlete_id,
                event_id: item.payload.event_id,
                status: 'pending',
              },
              { onConflict: 'athlete_id' },
            );
          }
        }
      } catch (e) {
        logDevError('Report trigger check failed for item', item.id, e);
      }

      return true;
    }

    // Transient failure -- caller will handle retry bookkeeping
    logDevError('Sync error for result item', item.id, error);
    return false;
  }, []);

  // -------------------------------------------------------------------------
  // Attempt to sync a single 'device_status' item
  // -------------------------------------------------------------------------
  const syncDeviceStatusItem = useCallback(async (item: OutboxItem): Promise<boolean> => {
    const { error } = await supabase.from('device_status').upsert(item.payload);
    if (!error) {
      await removeFromOutbox(item.id);
      return true;
    }
    logDevError('Sync error for device_status item', item.id, error);
    return false;
  }, []);

  // -------------------------------------------------------------------------
  // Main sync loop -- processes all eligible items with retry governance
  // -------------------------------------------------------------------------
  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    // getOutboxItems() already filters out dead_letter and not-yet-due items
    const items = await getOutboxItems();
    if (items.length === 0) return;

    logDev(`Syncing ${items.length} eligible item(s)...`);

    for (const item of items) {
      // Mark as 'retrying' if this is not the first attempt
      if (item.retry_count > 0 && item.status !== 'retrying') {
        await updateOutboxItem(item.id, { status: 'retrying' });
      }

      let succeeded = false;
      let errorMessage: string | null = null;

      try {
        if (item.type === 'result') {
          succeeded = await syncResultItem(item);
        } else if (item.type === 'device_status') {
          succeeded = await syncDeviceStatusItem(item);
        } else {
          // Unknown item type -- treat as unrecoverable
          logDevError('Unknown outbox item type, moving to dead_letter', item);
          await updateOutboxItem(item.id, {
            status: 'dead_letter',
            error_message: `Unknown item type: ${(item as any).type}`,
            last_attempt_at: Date.now(),
          });
          continue;
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        logDevError('Unexpected exception syncing item', item.id, err);
        succeeded = false;
      }

      if (!succeeded) {
        const newRetryCount = item.retry_count + 1;

        if (newRetryCount >= MAX_RETRIES) {
          // Exhausted all retries -- move to dead letter
          logDev(`Item ${item.id} reached max retries (${MAX_RETRIES}). Moving to dead_letter.`);
          await updateOutboxItem(item.id, {
            retry_count: newRetryCount,
            last_attempt_at: Date.now(),
            next_retry_at: null,
            error_message: errorMessage ?? item.error_message,
            status: 'dead_letter',
          });
        } else {
          // Schedule next retry with exponential backoff
          const nextRetryAt = computeNextRetryAt(newRetryCount);
          logDev(
            `Item ${item.id} failed (attempt ${newRetryCount}/${MAX_RETRIES}). ` +
            `Next retry at ${new Date(nextRetryAt).toISOString()}.`,
          );
          await updateOutboxItem(item.id, {
            retry_count: newRetryCount,
            last_attempt_at: Date.now(),
            next_retry_at: nextRetryAt,
            error_message: errorMessage ?? item.error_message,
            status: 'retrying',
          });
        }
      }
    }

    await updateCounts();
    setLastSyncTime(new Date());
  }, [syncResultItem, syncDeviceStatusItem, updateCounts]);

  // -------------------------------------------------------------------------
  // Event listeners and polling interval
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncOutbox();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    updateCounts();

    // Poll every 30 s -- getOutboxItems() respects next_retry_at so this is safe
    const interval = setInterval(() => {
      if (navigator.onLine) syncOutbox();
      updateCounts();
    }, 30_000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [syncOutbox, updateCounts]);

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  return {
    isOnline,
    /** Items in 'pending' status (never attempted). */
    pendingCount,
    /** Items in 'retrying' status (failed at least once, still within retry budget). */
    retryingCount,
    /** Items in 'dead_letter' status (exhausted all retries, requires manual review). */
    deadLetterCount,
    /** Total active items = pendingCount + retryingCount. */
    activeCount: pendingCount + retryingCount,
    lastSyncTime,
    syncOutbox,
    updateCounts,
  };
}
