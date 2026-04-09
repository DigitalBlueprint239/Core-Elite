import { useEffect, useState, useCallback } from 'react';
import { getOutboxItems, getSyncableOutboxItems, removeFromOutbox, updateOutboxItem, getDeadLetterItems, resetDeadLetterItem, OutboxItem } from '../lib/offline';
import { supabase } from '../lib/supabase';
import { update as updateHlc } from '../lib/hlc';

// ---------------------------------------------------------------------------
// DuplicateChallenge — surfaced to StationMode when submit_result_secure
// returns SUSPICIOUS_DUPLICATE. The outbox item is held in 'pending_review'
// until the operator resolves it via resolveDuplicateChallenge().
// ---------------------------------------------------------------------------
export interface DuplicateChallenge {
  itemId:               string;   // outbox item id (= client_result_id)
  existingResultId:     string;
  existingValue:        number;
  existingRecordedAt:   string;
  existingAttemptNum:   number;
  newValue:             number;
  athleteId:            string;
  drillType:            string;
  payload:              any;      // original outbox payload for re-submission
}
// lww.ts (addBiasedShouldKeep, deviceStatusShouldUpdate) wired in Phase 4
// when the pull path is added. The add-biased principle is applied below
// through logic rather than a direct function call.

const MAX_RETRIES = 5;

export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [requiresForceSync, setRequiresForceSync] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [duplicateChallenges, setDuplicateChallenges] = useState<DuplicateChallenge[]>([]);

  const updatePendingCount = useCallback(async () => {
    const items = await getOutboxItems();
    setPendingCount(items.filter(i => i.status !== 'dead_letter').length);
    setRequiresForceSync(items.filter(i => i.status === 'dead_letter').length);
  }, []);

  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    // Use by_status index (v3) — avoids full-store scan (idx_outbox_pending, v2 §3.3.3)
    const syncableItems = await getSyncableOutboxItems();

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
            p_event_id:         item.payload.event_id,
            p_athlete_id:       item.payload.athlete_id,
            p_band_id:          item.payload.band_id,
            p_station_id:       item.payload.station_id,
            p_drill_type:       item.payload.drill_type,
            p_value_num:        item.payload.value_num,
            // Phase 2: each rep is its own immutable row (v1 §3.6.4).
            p_attempt_number:   item.payload.attempt_number ?? 1,
            p_meta:             metaWithHlc,
          });

          // ── Suspicious duplicate: park for operator review ────────────────
          if (!error && data?.code === 'SUSPICIOUS_DUPLICATE') {
            await updateOutboxItem({
              ...item,
              status: 'pending_review',
              last_attempt_at: Date.now(),
            });
            setDuplicateChallenges(prev => {
              if (prev.some(c => c.itemId === item.id)) return prev;
              return [...prev, {
                itemId:             item.id,
                existingResultId:   data.existing_result_id,
                existingValue:      data.existing_value,
                existingRecordedAt: data.existing_recorded_at,
                existingAttemptNum: data.existing_attempt_num ?? 1,
                newValue:           data.new_value,
                athleteId:          data.athlete_id,
                drillType:          data.drill_type,
                payload:            item.payload,
              }];
            });
            // Item is now parked — skip success/failure handling for this iteration
            continue;
          }

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
        } else if (item.type === 'audit_log') {
          // audit_log is an append-only table — insert only, never upsert.
          // Treat duplicate key as success (add-biased): if the server already has
          // this audit entry (e.g. synced on a previous attempt), we're done.
          const { error } = await supabase.from('audit_log').insert(item.payload);
          if (!error || error.message?.includes('duplicate') || error.code === '23505') {
            success = true;
          } else {
            errorMsg = error.message;
          }
        }

        if (success) {
          await removeFromOutbox(item.id);
        } else {
          // Handle failure with retry logic — dead_letter halts background retry entirely
          const newRetryCount = item.retry_count + 1;
          const updatedItem: OutboxItem = {
            ...item,
            retry_count: newRetryCount,
            last_attempt_at: Date.now(),
            error_message: errorMsg,
            status: newRetryCount >= MAX_RETRIES ? 'dead_letter' : 'retrying'
          };
          await updateOutboxItem(updatedItem);
        }
      } catch (err: any) {
        console.error('Failed to sync item', item.id, err);
        const newRetryCount = item.retry_count + 1;
        const updatedItem: OutboxItem = {
          ...item,
          retry_count: newRetryCount,
          last_attempt_at: Date.now(),
          error_message: err.message,
          status: newRetryCount >= MAX_RETRIES ? 'dead_letter' : 'retrying'
        };
        await updateOutboxItem(updatedItem);
      }
    }

    await updatePendingCount();
    setLastSyncTime(new Date());
  }, [updatePendingCount]);

  // ---------------------------------------------------------------------------
  // resolveDuplicateChallenge — called from the StationMode modal when the
  // operator makes a decision on a SUSPICIOUS_DUPLICATE outbox item.
  //
  //   keep_both — re-queue with attempt_number incremented. Gate 2 in
  //               submit_result_secure skips when attempt_number > 1, so the
  //               second result goes straight to the write phase.
  //
  //   replace   — void the existing DB result (triggers audit log), then
  //               re-queue with attempt_number = 1 at lower priority.
  //               Gate 2 is safe because the voided record is now excluded
  //               from the suspicious-duplicate query (migration 015).
  //
  //   discard   — remove the new result from the outbox entirely. The
  //               existing DB record stands.
  // ---------------------------------------------------------------------------
  const resolveDuplicateChallenge = useCallback(async (
    itemId: string,
    resolution: 'keep_both' | 'replace' | 'discard',
  ) => {
    const challenge = duplicateChallenges.find(c => c.itemId === itemId);
    if (!challenge) return;

    if (resolution === 'discard') {
      await removeFromOutbox(itemId);

    } else if (resolution === 'keep_both') {
      const allItems = await getOutboxItems();
      const item = allItems.find(i => i.id === itemId);
      if (item) {
        await updateOutboxItem({
          ...item,
          status:          'pending',
          retry_count:     0,
          last_attempt_at: undefined,
          error_message:   undefined,
          payload: {
            ...item.payload,
            // attempt_number > 1 bypasses Gate 2 in submit_result_secure
            attempt_number: (challenge.existingAttemptNum ?? 1) + 1,
          },
        });
      }

    } else if (resolution === 'replace') {
      // Void the conflicting DB record — the audit trigger fires automatically
      await supabase
        .from('results')
        .update({ voided: true })
        .eq('id', challenge.existingResultId);

      const allItems = await getOutboxItems();
      const item = allItems.find(i => i.id === itemId);
      if (item) {
        // attempt_number stays at 1 — the voided record won't retrigger Gate 2
        await updateOutboxItem({
          ...item,
          status:          'pending',
          retry_count:     0,
          last_attempt_at: undefined,
          error_message:   undefined,
        });
      }
    }

    setDuplicateChallenges(prev => prev.filter(c => c.itemId !== itemId));
    await updatePendingCount();
    if (navigator.onLine) syncOutbox();
  }, [duplicateChallenges, updatePendingCount, syncOutbox]);

  // Force-retry one dead-letter item (or all if no id given)
  const forceSync = useCallback(async (id?: string) => {
    if (id) {
      await resetDeadLetterItem(id);
    } else {
      const deadItems = await getDeadLetterItems();
      await Promise.all(deadItems.map(item => resetDeadLetterItem(item.id)));
    }
    await updatePendingCount();
    if (navigator.onLine) syncOutbox();
  }, [updatePendingCount, syncOutbox]);

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
    requiresForceSync,
    lastSyncTime,
    syncOutbox,
    forceSync,
    updatePendingCount,
    duplicateChallenges,
    resolveDuplicateChallenge,
  };
}
