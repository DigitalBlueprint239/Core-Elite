/**
 * useSync — PowerSync replacement for useOfflineSync
 *
 * Drop-in behavioral replacement. Existing call sites use the same
 * return shape; the internal mechanism is entirely different.
 *
 * WHAT CHANGED vs useOfflineSync:
 *   Before:  Manual IndexedDB outbox, 30s polling interval, custom retry loop
 *   After:   PowerSync ps_crud table, automatic reconnect, connector.uploadData
 *
 * WHAT DID NOT CHANGE:
 *   - HLC timestamp generation (still tick() at write time in useSyncedWrite)
 *   - submit_result_secure RPC path (connector calls it identically)
 *   - upsert_device_status_hlc RPC path (connector calls it identically)
 *   - Suspicious duplicate challenge flow (parked in outbox_meta, surfaced here)
 *   - Dead-letter visibility and force-retry (outbox_meta, surfaced here)
 *
 * WHAT WAS ELIMINATED:
 *   - initDB() / openDB() setup
 *   - addToOutbox() / removeFromOutbox() / updateOutboxItem()
 *   - getSyncableOutboxItems() + backoff arithmetic in the hook
 *   - setInterval(syncOutbox, 30000)
 *   - window.addEventListener('online') triggering syncOutbox
 *
 * PowerSync handles all of the above internally. Our job is:
 *   1. Write to local SQLite via db.execute() with HLC pre-stamped
 *   2. Query outbox_meta for UI state (pending count, dead letters, challenges)
 *   3. Expose forceRetry() and resolveDuplicateChallenge() for operator actions
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePowerSync, useStatus } from '@powersync/react';
import { tick, update as updateHlc } from '../../../src/lib/hlc';
import { DuplicateChallengeData } from './connector';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types — identical shape to useOfflineSync return for drop-in compatibility
// ---------------------------------------------------------------------------

export interface SyncState {
  isOnline:              boolean;
  pendingCount:          number;
  requiresForceSync:     number;   // dead-letter count
  lastSyncTime:          Date | null;
  duplicateChallenges:   DuplicateChallengeData[];
  syncOutbox:            () => Promise<void>;   // no-op shim; PowerSync auto-syncs
  forceSync:             (id?: string) => Promise<void>;
  updatePendingCount:    () => Promise<void>;
  resolveDuplicateChallenge: (
    itemId:     string,
    resolution: 'keep_both' | 'replace' | 'discard',
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// useSync
// ---------------------------------------------------------------------------

export function useSync(): SyncState {
  const db     = usePowerSync();
  const status = useStatus();

  const [pendingCount,        setPendingCount]        = useState(0);
  const [deadLetterCount,     setDeadLetterCount]     = useState(0);
  const [lastSyncTime,        setLastSyncTime]        = useState<Date | null>(null);
  const [duplicateChallenges, setDuplicateChallenges] = useState<DuplicateChallengeData[]>([]);

  // Derived from PowerSync status
  const isOnline = status.connected;

  // ---------------------------------------------------------------------------
  // updatePendingCount — queries outbox_meta for UI counters
  // ---------------------------------------------------------------------------
  const updatePendingCount = useCallback(async () => {
    if (!db) return;

    const [pendingRows, deadRows, reviewRows] = await Promise.all([
      db.getAll<{ c: number }>(`
        SELECT COUNT(*) as c FROM outbox_meta
        WHERE status IN ('pending', 'retrying')
      `),
      db.getAll<{ c: number }>(`
        SELECT COUNT(*) as c FROM outbox_meta WHERE status = 'dead_letter'
      `),
      db.getAll<{ id: string; challenge_json: string }>(`
        SELECT id, challenge_json FROM outbox_meta WHERE status = 'pending_review'
      `),
    ]);

    setPendingCount(pendingRows[0]?.c ?? 0);
    setDeadLetterCount(deadRows[0]?.c ?? 0);

    // Reconstruct challenge objects from stored JSON
    const challenges: DuplicateChallengeData[] = reviewRows
      .map(row => {
        try { return JSON.parse(row.challenge_json) as DuplicateChallengeData; }
        catch { return null; }
      })
      .filter((c): c is DuplicateChallengeData => c !== null);

    setDuplicateChallenges(challenges);
  }, [db]);

  // ---------------------------------------------------------------------------
  // Watch PowerSync sync status for lastSyncTime
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (status.lastSyncedAt) {
      setLastSyncTime(new Date(status.lastSyncedAt));
    }
  }, [status.lastSyncedAt]);

  // ---------------------------------------------------------------------------
  // Poll outbox_meta for pending count every 5s
  // PowerSync has no native callback for "outbox changed" on the web SDK;
  // a short poll is the pragmatic solution here.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    updatePendingCount();
    const id = setInterval(updatePendingCount, 5000);
    return () => clearInterval(id);
  }, [updatePendingCount]);

  // ---------------------------------------------------------------------------
  // syncOutbox — no-op shim.
  // PowerSync triggers uploadData automatically; this exists only for
  // call-site compatibility with the previous useOfflineSync interface.
  // ---------------------------------------------------------------------------
  const syncOutbox = useCallback(async () => {
    // PowerSync handles this. Nothing to do.
    await updatePendingCount();
  }, [updatePendingCount]);

  // ---------------------------------------------------------------------------
  // forceSync — reset dead-letter items so PowerSync retries them
  // ---------------------------------------------------------------------------
  const forceSync = useCallback(async (id?: string) => {
    if (!db) return;
    if (id) {
      await db.execute(`
        UPDATE outbox_meta SET status = 'pending', retry_count = 0,
          error_message = NULL, last_attempt_at = NULL
        WHERE id = ? AND status = 'dead_letter'
      `, [id]);
    } else {
      await db.execute(`
        UPDATE outbox_meta SET status = 'pending', retry_count = 0,
          error_message = NULL, last_attempt_at = NULL
        WHERE status = 'dead_letter'
      `);
    }
    await updatePendingCount();
    // PowerSync's next uploadData pass will pick these up automatically.
  }, [db, updatePendingCount]);

  // ---------------------------------------------------------------------------
  // resolveDuplicateChallenge — operator resolves a suspicious duplicate
  //
  // keep_both: re-write the result row with attempt_number incremented so
  //            Gate 2 in submit_result_secure skips the duplicate check.
  //
  // replace:   void the existing DB record, then clear pending_review so
  //            the item re-enters the normal upload path.
  //
  // discard:   delete the local result row and the outbox_meta row so
  //            PowerSync removes it from ps_crud.
  // ---------------------------------------------------------------------------
  const resolveDuplicateChallenge = useCallback(async (
    itemId:     string,
    resolution: 'keep_both' | 'replace' | 'discard',
  ) => {
    if (!db) return;

    const challenge = duplicateChallenges.find(c => c.itemId === itemId);
    if (!challenge) return;

    if (resolution === 'discard') {
      // Remove the local result row — PowerSync will see the DELETE and
      // either no-op (it never reached the server) or the server row
      // remains (we don't push deletes for immutable results).
      await db.execute('DELETE FROM results WHERE id = ?', [itemId]);
      await db.execute('DELETE FROM outbox_meta WHERE id = ?', [itemId]);

    } else if (resolution === 'keep_both') {
      // Read the existing result row
      const existing = await db.getOptional<{ attempt_number: number; meta: string }>(
        'SELECT attempt_number, meta FROM results WHERE id = ?', [itemId]
      );
      const newAttempt = (challenge.existingAttemptNum ?? 1) + 1;
      const metaObj    = existing?.meta ? JSON.parse(existing.meta) : {};

      // Overwrite the local row — PowerSync will see this as an UPDATE and
      // include it in the next uploadData batch with the new attempt_number.
      await db.execute(`
        UPDATE results SET attempt_number = ?, meta = ?
        WHERE id = ?
      `, [newAttempt, JSON.stringify(metaObj), itemId]);

      // Clear pending_review so uploadData picks it up again
      await db.execute(`
        UPDATE outbox_meta SET status = 'pending', retry_count = 0,
          last_attempt_at = NULL, error_message = NULL, challenge_json = NULL
        WHERE id = ?
      `, [itemId]);

    } else if (resolution === 'replace') {
      // Void the conflicting existing server record.
      // This is a direct Supabase call — not through PowerSync — because we
      // are modifying a server row that PowerSync did not create locally.
      // The audit trigger fires automatically on the server side.
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY,
      );
      await supabase
        .from('results')
        .update({ voided: true })
        .eq('id', challenge.existingResultId);

      // Clear pending_review — the voided record won't re-trigger Gate 2
      await db.execute(`
        UPDATE outbox_meta SET status = 'pending', retry_count = 0,
          last_attempt_at = NULL, error_message = NULL, challenge_json = NULL
        WHERE id = ?
      `, [itemId]);
    }

    setDuplicateChallenges(prev => prev.filter(c => c.itemId !== itemId));
    await updatePendingCount();
  }, [db, duplicateChallenges, updatePendingCount]);

  return {
    isOnline,
    pendingCount,
    requiresForceSync: deadLetterCount,
    lastSyncTime,
    duplicateChallenges,
    syncOutbox,
    forceSync,
    updatePendingCount,
    resolveDuplicateChallenge,
  };
}

// ---------------------------------------------------------------------------
// useSyncedWrite
//
// The write-side API that replaces addToOutbox() at all call sites.
// Generates HLC ONCE, writes to local PowerSync SQLite, which automatically
// queues the item in ps_crud for upload.
//
// Usage:
//   const { writeResult, writeDeviceStatus } = useSyncedWrite();
//   await writeResult({ client_result_id, athlete_id, ... });
//
// This is the ONLY place tick() is called for result/device_status writes.
// The connector reads hlc_timestamp from the stored row — it never calls tick().
// ---------------------------------------------------------------------------

export interface ResultPayload {
  client_result_id:  string;
  event_id:          string;
  athlete_id:        string;
  band_id:           string;
  station_id:        string;
  drill_type:        string;
  value_num:         number;
  attempt_number:    number;
  validation_status: 'clean' | 'extraordinary';
  /**
   * Device wall-clock ms at the moment of capture (Date.now()).
   * This is the LWW conflict resolution key (migration 018).
   * Higher device_timestamp wins when two offline devices capture the same
   * athlete at the same drill and both sync later.
   * NEVER use server time here — it must be the device clock at capture.
   */
  device_timestamp?: number;
  /**
   * 'live_ble'     — captured via BLE hardware; eligible for cryptographic verification.
   * 'manual'       — manually keyed; verification_hash will always be null.
   * 'imported_csv' — bulk-ingested historical record.
   * Defaults to 'manual' when omitted (defense-in-depth — the StationMode
   * capture path always sets this explicitly per Mission "p_source_type").
   */
  source_type?:      'live_ble' | 'manual' | 'imported_csv';
  /** Combine wave/session identifier for bulk session exports. */
  session_id?:       string;
  meta?:             Record<string, unknown>;
}

export interface TelemetryPayload {
  /** Device-generated UUID for idempotency. Use uuidv4() at capture time. */
  client_telemetry_id:  string;
  event_id:             string;
  /** Populated once the corresponding result is written successfully. */
  result_id?:           string;
  station_id:           string;
  athlete_id:           string;
  drill_type:           string;
  /**
   * Device wall-clock ms at capture (Date.now()).
   * LWW key: higher device_timestamp wins within the 500ms conflict window.
   */
  device_timestamp:     number;
  device_id:            string;
  device_label:         string;
  captured_at:          string;          // ISO-8601
  capture_duration_ms?: number;
  ble_rssi?:            number;
  ble_phy?:             string;
  validation_status?:   string;
  was_offline:          boolean;
  /** ms between capture and this write call. Populated by the caller. */
  sync_latency_ms?:     number;
  /**
   * BLE inter-device clock offset at capture time (ms, signed).
   * From ClockSyncEngine.currentOffsetNs() / 1_000_000.
   * Embedded in the HMAC-SHA-256 verification hash by the Edge Function.
   */
  clock_offset_ms?:     number;
  /**
   * BLE clock sync round-trip time (ms).
   * From ClockSyncInfo.rttNs / 1_000_000.
   * Also embedded in the verification hash.
   */
  rtt_ms?:              number;
  meta?:                Record<string, unknown>;
}

export interface DeviceStatusPayload {
  event_id:            string;
  station_id:          string;
  device_label:        string;
  last_seen_at:        string;
  is_online:           boolean;
  pending_queue_count: number;
  last_sync_at?:       string | null;
}

export function useSyncedWrite() {
  const db = usePowerSync();

  const writeResult = useCallback(async (payload: ResultPayload): Promise<string> => {
    if (!db) throw new Error('Database not ready');

    // Generate HLC once at write time — stored in the row, never regenerated.
    const hlcTimestamp    = tick();
    const id              = payload.client_result_id;
    const now             = new Date().toISOString();
    const deviceTimestamp = payload.device_timestamp ?? Date.now();
    const sourceType      = payload.source_type ?? 'manual';

    await db.execute(`
      INSERT OR REPLACE INTO results (
        id, client_result_id, event_id, athlete_id, band_id,
        station_id, drill_type, value_num, attempt_number,
        validation_status, hlc_timestamp, device_timestamp,
        source_type, session_id, recorded_at, meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      payload.client_result_id,
      payload.event_id,
      payload.athlete_id,
      payload.band_id,
      payload.station_id,
      payload.drill_type,
      payload.value_num,
      payload.attempt_number,
      payload.validation_status,
      hlcTimestamp,
      deviceTimestamp,
      sourceType,
      payload.session_id ?? null,
      now,
      JSON.stringify(payload.meta ?? {}),
    ]);

    // Create outbox_meta row — tracks extended state for UI
    await db.execute(`
      INSERT OR IGNORE INTO outbox_meta (id, item_type, status, retry_count, hlc_timestamp)
      VALUES (?, 'result', 'pending', 0, ?)
    `, [id, hlcTimestamp]);

    return hlcTimestamp;
  }, [db]);

  const writeDeviceStatus = useCallback(async (payload: DeviceStatusPayload): Promise<string> => {
    if (!db) throw new Error('Database not ready');

    const hlcTimestamp = tick();
    // device_status uses a composite key — derive a stable id from the composite
    const id = `${payload.event_id}__${payload.station_id}__${payload.device_label}`;

    await db.execute(`
      INSERT OR REPLACE INTO device_status (
        id, event_id, station_id, device_label, last_seen_at,
        is_online, pending_queue_count, last_sync_at, hlc_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      payload.event_id,
      payload.station_id,
      payload.device_label,
      payload.last_seen_at,
      payload.is_online ? 1 : 0,
      payload.pending_queue_count,
      payload.last_sync_at ?? null,
      hlcTimestamp,
    ]);

    await db.execute(`
      INSERT OR IGNORE INTO outbox_meta (id, item_type, status, retry_count, hlc_timestamp)
      VALUES (?, 'device_status', 'pending', 0, ?)
    `, [id, hlcTimestamp]);

    return hlcTimestamp;
  }, [db]);

  // ---------------------------------------------------------------------------
  // writeTelemetry
  //
  // Writes a capture_telemetry row and a result_provenance row to local SQLite.
  // Both are queued by PowerSync and uploaded when connectivity is available.
  //
  // Call this AFTER writeResult succeeds to link the telemetry to the result_id.
  // The device_timestamp in the payload is the LWW key for capture_telemetry.
  //
  // No HLC tick — telemetry is analytical data, not a causal event. The
  // device_timestamp field is sufficient for ordering within this context.
  // ---------------------------------------------------------------------------
  const writeTelemetry = useCallback(async (
    payload: TelemetryPayload,
    hlcTimestamp: string, // from the corresponding writeResult call
  ): Promise<void> => {
    if (!db) throw new Error('Database not ready');

    const telemetryId = payload.client_telemetry_id;
    const now         = new Date().toISOString();

    // Write capture_telemetry row
    await db.execute(`
      INSERT OR IGNORE INTO capture_telemetry (
        id, client_telemetry_id, event_id, result_id, station_id,
        athlete_id, drill_type, device_timestamp, device_id, device_label,
        captured_at, capture_duration_ms, ble_rssi, ble_phy,
        validation_status, was_offline, sync_latency_ms,
        clock_offset_ms, rtt_ms, meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      telemetryId,
      payload.client_telemetry_id,
      payload.event_id,
      payload.result_id ?? null,
      payload.station_id,
      payload.athlete_id,
      payload.drill_type,
      payload.device_timestamp,
      payload.device_id,
      payload.device_label,
      payload.captured_at,
      payload.capture_duration_ms ?? null,
      payload.ble_rssi ?? null,
      payload.ble_phy ?? null,
      payload.validation_status ?? null,
      payload.was_offline ? 1 : 0,
      payload.sync_latency_ms ?? null,
      payload.clock_offset_ms ?? null,
      payload.rtt_ms ?? null,
      JSON.stringify(payload.meta ?? {}),
    ]);

    // Write result_provenance row (if we have a result_id to link to)
    if (payload.result_id) {
      const provenanceId = `prov_${payload.result_id}`;
      await db.execute(`
        INSERT OR IGNORE INTO result_provenance (
          id, result_id, device_id, device_label, station_id,
          device_timestamp, hlc_timestamp, sync_latency_ms, was_offline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        provenanceId,
        payload.result_id,
        payload.device_id,
        payload.device_label,
        payload.station_id,
        payload.device_timestamp,
        hlcTimestamp,
        payload.sync_latency_ms ?? null,
        payload.was_offline ? 1 : 0,
      ]);
    }
  }, [db]);

  return { writeResult, writeDeviceStatus, writeTelemetry };
}
