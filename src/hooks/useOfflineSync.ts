import { useEffect, useState, useCallback, useRef } from 'react';
import { getOutboxItems, getSyncableOutboxItems, removeFromOutbox, updateOutboxItem, getDeadLetterItems, resetDeadLetterItem, OutboxItem, ResultOutboxPayload, chunkOutboxItems, OUTBOX_BATCH_SIZE } from '../lib/offline';
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
  // Original payload preserved for re-submission. Always a ResultOutboxPayload
  // — duplicate challenges only arise from the 'result' RPC path.
  payload:              ResultOutboxPayload;
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

  // ── Sync re-entrancy lock ──────────────────────────────────────────────
  //
  // Three triggers can fire syncOutbox simultaneously:
  //   - the navigator 'online' event handler
  //   - the 30-second background interval
  //   - StationMode's manual "Force Sync" button
  //
  // Without this guard, two concurrent flushes would race the same outbox
  // items: both read pending=N, both POST the first item, the server
  // returns one success and one duplicate, and the two flushes increment
  // retry_count out of sync. The ref MUST clear in `finally` so a network
  // failure mid-batch doesn't leave the system permanently locked
  // (Mission "Sync Lock Hardening" anti-pattern).
  const isSyncingRef = useRef<boolean>(false);

  const updatePendingCount = useCallback(async () => {
    const items = await getOutboxItems();
    setPendingCount(items.filter(i => i.status !== 'dead_letter').length);
    setRequiresForceSync(items.filter(i => i.status === 'dead_letter').length);
  }, []);

  const syncOutbox = useCallback(async () => {
    if (!navigator.onLine) return;

    // Re-entrancy guard — if another invocation is already draining the
    // outbox, defer. The ref is cleared in `finally` (success AND failure)
    // below, so a transient network error never permanently halts sync.
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {

    // Use by_status_timestamp compound index (v5) — bounded key range, no
    // full partition scan, FIFO order preserved within each status.
    const syncableItems = await getSyncableOutboxItems();

    if (syncableItems.length === 0) return;

    // Mission "Sync Lock Hardening": chunk into ≤50-item batches when the
    // queue is large. Each batch is processed serially internally to
    // preserve HLC causal ordering (parallel uploads could violate the
    // server-side LWW invariant). Between batches we yield to the event
    // loop with a microtask so IndexedDB locks release and StationMode's
    // capture path can interleave a fresh addToOutbox without blocking.
    const batches = chunkOutboxItems(syncableItems, OUTBOX_BATCH_SIZE);
    console.log(
      `Syncing ${syncableItems.length} items in ${batches.length} batch(es) of ${OUTBOX_BATCH_SIZE}...`,
    );

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      // Yield between batches (skip the very first one — no point pausing
      // before any work). setTimeout(..., 0) is the canonical way to let
      // the IndexedDB transaction queue drain on iPad Safari.
      if (batchIdx > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      for (const item of batch) {
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
            // Mission "p_source_type": provenance discriminator. Mandated
            // at the OutboxItem type level, so item.payload.source_type is
            // guaranteed-present for every 'result' variant — no fallback,
            // no silent default. Bad values are rejected by the RPC with
            // {success: false, error: 'invalid source_type'}.
            p_source_type:      item.payload.source_type,
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
          // device_status is a mutable upsert — strict HLC LWW applies.
          //
          // We call upsert_device_status_hlc() (migration 017) instead of a
          // bare .upsert(). The RPC enforces: only write if incoming HLC >
          // current HLC on the server row (deviceStatusShouldUpdate, v2 §3.1.2).
          //
          // This prevents a stale heartbeat queued during an offline period from
          // overwriting a fresher heartbeat that arrived via the online fast-path.
          //
          // applied: false → stale write rejected by HLC guard. Still a success —
          // the outbox item is removed so it does not retry forever.
          const p = item.payload;
          const { data: statusData, error: statusError } = await supabase.rpc(
            'upsert_device_status_hlc',
            {
              p_event_id:      p.event_id,
              p_station_id:    p.station_id,
              p_device_label:  p.device_label,
              p_last_seen_at:  p.last_seen_at,
              p_is_online:     p.is_online,
              p_pending_count: p.pending_queue_count ?? 0,
              p_last_sync_at:  p.last_sync_at ?? null,
              p_hlc_timestamp: item.hlc_timestamp,
            },
          );

          if (!statusError && statusData?.success) {
            if (item.hlc_timestamp) updateHlc(item.hlc_timestamp);
            success = true;
          } else {
            errorMsg = statusError?.message ?? statusData?.error ?? 'upsert_device_status_hlc failed';
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
      } catch (err: unknown) {
        console.error('Failed to sync item', item.id, err);
        const newRetryCount = item.retry_count + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const updatedItem: OutboxItem = {
          ...item,
          retry_count: newRetryCount,
          last_attempt_at: Date.now(),
          error_message: errorMessage,
          status: newRetryCount >= MAX_RETRIES ? 'dead_letter' : 'retrying'
        };
        await updateOutboxItem(updatedItem);
      }
      } // end inner per-item for-of
    }   // end outer batch loop

    await updatePendingCount();
    setLastSyncTime(new Date());

    } finally {
      // Mission "Sync Lock Hardening" anti-pattern: the ref MUST clear
      // here, regardless of how the body exited (early return on empty
      // queue, normal completion, or unhandled exception bubbling out
      // of a per-item processor). Without this, a single network blip
      // would permanently lock background syncs.
      isSyncingRef.current = false;
    }
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
      // Duplicate-challenge items are always 'result' rows (see Gate 2 path
      // in syncOutbox). The narrow guard keeps TS happy and documents intent.
      if (item && item.type === 'result') {
        const updated: OutboxItem = {
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
        };
        await updateOutboxItem(updated);
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
