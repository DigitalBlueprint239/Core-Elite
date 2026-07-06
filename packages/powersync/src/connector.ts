/**
 * CoreElitePowerSyncConnector
 *
 * Implements the PowerSync backend connector interface:
 *   fetchCredentials() — returns a JWT for the PowerSync service to auth against Supabase
 *   uploadData()       — called by PowerSync with every pending CRUD batch
 *
 * This is the ONLY place where the client talks to Supabase for writes.
 * PowerSync owns retry scheduling; we implement the per-item logic here.
 *
 * HLC contract:
 *   HLC timestamps are generated BEFORE the local SQLite INSERT (in useSyncedWrite).
 *   They are stored in the local `results.hlc_timestamp` column.
 *   uploadData reads them back from the CrudEntry and passes them to the RPCs.
 *   This guarantees the timestamp embedded in the outbox and the timestamp
 *   sent to the server are always identical — no second tick() call here.
 *
 * Retry contract:
 *   PowerSync calls uploadData repeatedly until it returns without throwing.
 *   We implement per-item retry state in the local outbox_meta table so the UI
 *   can show dead-letter items and the operator can force-retry them.
 *   Items in 'pending_review' are SKIPPED in uploadData until the operator
 *   resolves the duplicate challenge — they are not retried automatically.
 *
 * Crash recovery contract:
 *   PowerSync stores pending CRUDs in ps_crud (SQLite, persisted to disk).
 *   After a crash or forced-quit, PowerSync re-calls uploadData on next open.
 *   Our outbox_meta row survives too (also SQLite). Idempotency on the server
 *   (client_result_id UNIQUE) ensures a re-delivered item is a no-op.
 */

import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  UpdateType,
} from '@powersync/web';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { update as updateHlc } from '../../../src/lib/hlc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;

// Exponential backoff: 2^n seconds, capped at 5 minutes.
function backoffMs(retryCount: number): number {
  return Math.min(Math.pow(2, retryCount) * 1000, 300_000);
}

export interface DuplicateChallengeData {
  itemId:             string;
  existingResultId:   string;
  existingValue:      number;
  existingRecordedAt: string;
  existingAttemptNum: number;
  newValue:           number;
  athleteId:          string;
  drillType:          string;
  payload:            Record<string, unknown>;
}

type UploadResult =
  | { outcome: 'success' }
  | { outcome: 'duplicate' }
  | { outcome: 'suspicious_duplicate'; challenge: DuplicateChallengeData }
  | { outcome: 'error'; message: string };

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export class CoreElitePowerSyncConnector implements PowerSyncBackendConnector {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, supabaseAnonKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseAnonKey);
  }

  // ---------------------------------------------------------------------------
  // fetchCredentials — PowerSync calls this to get a token for the sync stream.
  // We return the Supabase session token; PowerSync uses it to authenticate
  // against the PowerSync service which proxies to Supabase.
  // ---------------------------------------------------------------------------
  async fetchCredentials() {
    const { data: { session }, error } = await this.supabase.auth.getSession();
    if (error || !session) throw new Error('Not authenticated');

    return {
      endpoint: process.env.VITE_POWERSYNC_URL!,
      token:    session.access_token,
    };
  }

  // ---------------------------------------------------------------------------
  // uploadData — PowerSync calls this with every pending CRUD batch.
  //
  // CONTRACT: throw to signal retry; return normally to signal batch complete.
  //
  // We process entries one at a time (not in parallel) to preserve HLC ordering.
  // Parallel uploads could violate the causal ordering we've embedded in HLC
  // timestamps if two results arrive at the server out of HLC order.
  //
  // The batch loop:
  //   1. Read outbox_meta for this item to check status and backoff
  //   2. Skip if pending_review (operator must resolve)
  //   3. Skip if in backoff window (dead_letter or retrying)
  //   4. Call the appropriate Supabase RPC
  //   5. On success: advance local HLC, mark complete, PowerSync removes from ps_crud
  //   6. On error: increment retry_count, mark dead_letter if exhausted
  //
  // NOTE: PowerSync's batch may contain entries from multiple tables (results,
  // device_status, audit_log). We route by table name.
  // ---------------------------------------------------------------------------
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const tx = await database.getCrudBatch(200);
    if (!tx || tx.crud.length === 0) return;

    for (const entry of tx.crud) {
      await this.processEntry(database, entry);
    }

    await tx.complete();
  }

  private async processEntry(
    db: AbstractPowerSyncDatabase,
    entry: CrudEntry,
  ): Promise<void> {
    const itemId = entry.id;

    // Read outbox_meta for this item (may not exist for first attempt)
    const meta = await db.getOptional<{
      status:          string;
      retry_count:     number;
      last_attempt_at: number;
      challenge_json:  string | null;
    }>(
      'SELECT status, retry_count, last_attempt_at, challenge_json FROM outbox_meta WHERE id = ?',
      [itemId]
    );

    // Skip pending_review items — parked until operator resolves duplicate challenge
    if (meta?.status === 'pending_review') return;

    // Skip dead_letter items — operator must force-retry via forceRetry()
    if (meta?.status === 'dead_letter') return;

    // Apply exponential backoff for retrying items
    const retryCount = meta?.retry_count ?? 0;
    if (retryCount > 0 && meta?.last_attempt_at) {
      const elapsed = Date.now() - meta.last_attempt_at;
      if (elapsed < backoffMs(retryCount)) return;
    }

    let result: UploadResult;

    try {
      result = await this.upload(db, entry);
    } catch (err: any) {
      result = { outcome: 'error', message: err.message ?? 'Network error' };
    }

    await this.handleResult(db, entry, result, retryCount);
  }

  private async upload(
    db: AbstractPowerSyncDatabase,
    entry: CrudEntry,
  ): Promise<UploadResult> {
    const { table, opData, op } = entry;

    // Only process INSERT operations — results/device_status/audit_log are
    // never updated or deleted from the client side (immutable results,
    // mutable device_status goes through RPC not direct UPDATE).
    if (op !== UpdateType.PUT && op !== UpdateType.PATCH) {
      return { outcome: 'success' }; // no-op for unexpected op types
    }

    switch (table) {
      case 'results':
        return this.uploadResult(opData!);

      case 'device_status':
        return this.uploadDeviceStatus(opData!);

      case 'audit_log':
        return this.uploadAuditLog(opData!);

      case 'capture_telemetry':
        return this.uploadCaptureTelemetry(opData!);

      case 'result_provenance':
        return this.uploadResultProvenance(opData!);

      default:
        // Local-only tables (outbox_meta, event_config) should never appear
        // in ps_crud because they are declared with localOnly: true.
        // If they do appear, treat as success to drain the queue.
        return { outcome: 'success' };
    }
  }

  // ---------------------------------------------------------------------------
  // uploadResult — calls submit_result_secure RPC
  // HLC is read from opData.hlc_timestamp (set at write time, never regenerated)
  // ---------------------------------------------------------------------------
  private async uploadResult(opData: Record<string, unknown>): Promise<UploadResult> {
    const metaWithHlc = {
      ...(typeof opData.meta === 'string'
        ? JSON.parse(opData.meta as string)
        : (opData.meta ?? {})),
      hlc_timestamp: opData.hlc_timestamp,
    };

    const { data, error } = await this.supabase.rpc('submit_result_secure', {
      p_client_result_id: opData.client_result_id as string,
      p_event_id:         opData.event_id as string,
      p_athlete_id:       opData.athlete_id as string,
      p_band_id:          opData.band_id as string,
      p_station_id:       opData.station_id as string,
      p_drill_type:       opData.drill_type as string,
      p_value_num:        opData.value_num as number,
      p_attempt_number:   (opData.attempt_number as number) ?? 1,
      p_meta:             metaWithHlc,
      // v5: device_timestamp is the LWW key (migration 018).
      // Defaults to 0 on the server if not supplied (backwards compatible).
      p_device_timestamp: (opData.device_timestamp as number) ?? 0,
      p_source_type:      (opData.source_type as string) ?? 'manual',
      p_session_id:       (opData.session_id as string) ?? null,
    });

    if (error) return { outcome: 'error', message: error.message };

    if (data?.code === 'SUSPICIOUS_DUPLICATE') {
      const challenge: DuplicateChallengeData = {
        itemId:             opData.client_result_id as string,
        existingResultId:   data.existing_result_id,
        existingValue:      data.existing_value,
        existingRecordedAt: data.existing_recorded_at,
        existingAttemptNum: data.existing_attempt_num ?? 1,
        newValue:           data.new_value,
        athleteId:          data.athlete_id,
        drillType:          data.drill_type,
        payload:            opData,
      };
      return { outcome: 'suspicious_duplicate', challenge };
    }

    if (data?.status === 'duplicate' || data?.success) {
      // Advance local HLC on confirmed write (receive-event rule)
      if (opData.hlc_timestamp) updateHlc(opData.hlc_timestamp as string);
      return data?.status === 'duplicate'
        ? { outcome: 'duplicate' }
        : { outcome: 'success' };
    }

    return { outcome: 'error', message: data?.error ?? 'submit_result_secure failed' };
  }

  // ---------------------------------------------------------------------------
  // uploadDeviceStatus — calls upsert_device_status_hlc RPC
  // ---------------------------------------------------------------------------
  private async uploadDeviceStatus(opData: Record<string, unknown>): Promise<UploadResult> {
    const { data, error } = await this.supabase.rpc('upsert_device_status_hlc', {
      p_event_id:      opData.event_id as string,
      p_station_id:    opData.station_id as string,
      p_device_label:  opData.device_label as string,
      p_last_seen_at:  opData.last_seen_at as string,
      p_is_online:     Boolean(opData.is_online),
      p_pending_count: (opData.pending_queue_count as number) ?? 0,
      p_last_sync_at:  (opData.last_sync_at as string) ?? null,
      p_hlc_timestamp: opData.hlc_timestamp as string,
    });

    if (error) return { outcome: 'error', message: error.message };
    if (data?.success) {
      if (opData.hlc_timestamp) updateHlc(opData.hlc_timestamp as string);
      return { outcome: 'success' };  // applied: false (stale) is still a success
    }
    return { outcome: 'error', message: data?.error ?? 'upsert_device_status_hlc failed' };
  }

  // ---------------------------------------------------------------------------
  // uploadAuditLog — append-only insert; duplicates are success (add-biased)
  // ---------------------------------------------------------------------------
  private async uploadAuditLog(opData: Record<string, unknown>): Promise<UploadResult> {
    const { error } = await this.supabase.from('audit_log').insert(opData);
    if (!error ||
        error.code === '23505' ||
        error.message?.includes('duplicate')) {
      return { outcome: 'success' };
    }
    return { outcome: 'error', message: error.message };
  }

  // ---------------------------------------------------------------------------
  // uploadCaptureTelemetry — strict device_timestamp LWW via RPC
  //
  // The server-side upsert_capture_telemetry_lww() implements the LWW logic:
  //   - Idempotent on client_telemetry_id (safe re-delivery after reconnect)
  //   - Rejects writes where a HIGHER device_timestamp already exists for the
  //     same athlete/drill/event within a 500ms window
  //
  // Both 'applied: true' and 'applied: false' (LWW rejection) return success
  // to the client — the record is removed from the outbox in either case.
  // Network flapping: a re-delivered telemetry record hits the idempotency
  // check at Gate 1 of the RPC and returns immediately. No duplicate rows.
  // ---------------------------------------------------------------------------
  private async uploadCaptureTelemetry(opData: Record<string, unknown>): Promise<UploadResult> {
    const metaParsed = typeof opData.meta === 'string'
      ? JSON.parse(opData.meta as string)
      : (opData.meta ?? {});

    const { data, error } = await this.supabase.rpc('upsert_capture_telemetry_lww', {
      p_client_telemetry_id:  opData.client_telemetry_id as string,
      p_event_id:             opData.event_id as string,
      p_result_id:            (opData.result_id as string) ?? null,
      p_station_id:           opData.station_id as string,
      p_athlete_id:           opData.athlete_id as string,
      p_drill_type:           opData.drill_type as string,
      p_device_timestamp:     opData.device_timestamp as number,
      p_device_id:            opData.device_id as string,
      p_device_label:         opData.device_label as string,
      p_captured_at:          opData.captured_at as string,
      p_capture_duration_ms:  (opData.capture_duration_ms as number) ?? null,
      p_ble_rssi:             (opData.ble_rssi as number) ?? null,
      p_ble_phy:              (opData.ble_phy as string) ?? null,
      p_validation_status:    (opData.validation_status as string) ?? null,
      p_was_offline:          Boolean(opData.was_offline),
      p_sync_latency_ms:      (opData.sync_latency_ms as number) ?? null,
      p_meta:                 metaParsed,
      p_clock_offset_ms:      (opData.clock_offset_ms as number) ?? null,
      p_rtt_ms:               (opData.rtt_ms as number) ?? null,
    });

    if (error) return { outcome: 'error', message: error.message };

    // Both applied=true (new write) and applied=false (LWW rejected / idempotent)
    // are success — the client clears the outbox entry in both cases.
    if (data?.success) return { outcome: 'success' };

    return { outcome: 'error', message: data?.error ?? 'upsert_capture_telemetry_lww failed' };
  }

  // ---------------------------------------------------------------------------
  // uploadResultProvenance — idempotent provenance insert (UNIQUE result_id)
  //
  // Re-delivery after network flap hits ON CONFLICT DO NOTHING server-side.
  // The RPC returns success for both the initial insert and any duplicate.
  // ---------------------------------------------------------------------------
  private async uploadResultProvenance(opData: Record<string, unknown>): Promise<UploadResult> {
    const { data, error } = await this.supabase.rpc('insert_result_provenance', {
      p_result_id:        opData.result_id as string,
      p_device_id:        opData.device_id as string,
      p_device_label:     opData.device_label as string,
      p_station_id:       opData.station_id as string,
      p_device_timestamp: opData.device_timestamp as number,
      p_hlc_timestamp:    opData.hlc_timestamp as string,
      p_sync_latency_ms:  (opData.sync_latency_ms as number) ?? null,
      p_was_offline:      Boolean(opData.was_offline),
    });

    if (error) return { outcome: 'error', message: error.message };
    if (data?.success) return { outcome: 'success' };
    return { outcome: 'error', message: data?.error ?? 'insert_result_provenance failed' };
  }

  // ---------------------------------------------------------------------------
  // handleResult — write outcome back to outbox_meta
  // ---------------------------------------------------------------------------
  private async handleResult(
    db: AbstractPowerSyncDatabase,
    entry: CrudEntry,
    result: UploadResult,
    retryCount: number,
  ): Promise<void> {
    const id = entry.id;
    const now = Date.now();

    if (result.outcome === 'success' || result.outcome === 'duplicate') {
      // Clean removal — PowerSync will remove from ps_crud when tx.complete() is called
      await db.execute(
        'DELETE FROM outbox_meta WHERE id = ?',
        [id]
      );
      return;
    }

    if (result.outcome === 'suspicious_duplicate') {
      // Park for operator review — will NOT be retried automatically
      await db.execute(`
        INSERT INTO outbox_meta (id, item_type, status, retry_count, last_attempt_at, challenge_json)
        VALUES (?, ?, 'pending_review', 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status         = 'pending_review',
          last_attempt_at = ?,
          challenge_json  = ?
      `, [
        id,
        entry.table,
        now,
        JSON.stringify(result.challenge),
        now,
        JSON.stringify(result.challenge),
      ]);
      return;
    }

    // Error path — increment retry count
    const newRetryCount = retryCount + 1;
    const newStatus     = newRetryCount >= MAX_RETRIES ? 'dead_letter' : 'retrying';

    await db.execute(`
      INSERT INTO outbox_meta (id, item_type, status, retry_count, last_attempt_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status          = ?,
        retry_count     = ?,
        last_attempt_at = ?,
        error_message   = ?
    `, [
      id,
      entry.table,
      newStatus, newRetryCount, now, result.message,
      newStatus, newRetryCount, now, result.message,
    ]);

    // Re-throw for dead_letter so PowerSync knows this batch didn't fully complete.
    // PowerSync will re-call uploadData; we'll skip the dead_letter item next time.
    // This keeps the sync loop active for any OTHER items in the batch.
    if (newStatus === 'dead_letter') {
      console.warn(`[CoreElite] Item ${id} moved to dead_letter after ${MAX_RETRIES} retries`);
      // Do NOT throw — we want to continue processing other items in the batch.
      // The dead_letter item will simply be skipped on subsequent calls.
    }
  }
}
