/**
 * PowerSync Local SQLite Schema
 *
 * This defines the LOCAL device-side tables that PowerSync maintains.
 * It mirrors the Supabase schema with two classes of table:
 *
 *   SYNCED tables  — pulled from Supabase by PowerSync sync rules, written
 *                    to Supabase via the uploadData connector.
 *   LOCAL tables   — device-only; never synced. Used for state that has no
 *                    server counterpart (e.g. outbox metadata for dead-letter
 *                    tracking, override PIN cache).
 *
 * HLC columns are included in every writable table. PowerSync has no HLC
 * awareness — we generate HLC in the write layer (useSyncedWrite) and store
 * it as a TEXT column so the uploadData connector can pass it to the
 * Supabase RPCs without re-computing.
 *
 * Column type mapping (PowerSync → Postgres):
 *   column.text   → TEXT
 *   column.integer → INTEGER / BIGINT
 *   column.real   → NUMERIC / FLOAT
 *
 * NOTE: PowerSync automatically adds an `id` TEXT PRIMARY KEY to every table.
 * Do NOT declare `id` in the columns list.
 */

import {
  Schema,
  Table,
  Column,
  ColumnType,
} from '@powersync/web';   // swap to @powersync/react-native on RN target

// ---------------------------------------------------------------------------
// Synced tables (pulled from Supabase, uploaded via connector)
// ---------------------------------------------------------------------------

/**
 * results — immutable timing records.
 *
 * Pull: each device receives results for its event_id.
 * Push: via submit_result_secure RPC (NOT a direct table write).
 *
 * hlc_timestamp stored here so uploadData can read it back from the pending
 * CRUD op without re-generating it.
 *
 * device_timestamp: device wall-clock ms at capture (LWW key per migration 018).
 * Higher device_timestamp wins when two offline devices captured the same athlete.
 */
const results = new Table({
  client_result_id:  new Column({ type: ColumnType.TEXT }),
  event_id:          new Column({ type: ColumnType.TEXT }),
  athlete_id:        new Column({ type: ColumnType.TEXT }),
  band_id:           new Column({ type: ColumnType.TEXT }),
  station_id:        new Column({ type: ColumnType.TEXT }),
  drill_type:        new Column({ type: ColumnType.TEXT }),
  value_num:         new Column({ type: ColumnType.REAL }),
  attempt_number:    new Column({ type: ColumnType.INTEGER }),
  validation_status: new Column({ type: ColumnType.TEXT }),
  hlc_timestamp:     new Column({ type: ColumnType.TEXT }),    // HLC: causal ordering
  device_timestamp:  new Column({ type: ColumnType.INTEGER }), // LWW key: device wall-clock ms
  source_type:       new Column({ type: ColumnType.TEXT }),    // 'live_ble' | 'manual' | 'imported_csv'
  session_id:        new Column({ type: ColumnType.TEXT }),    // combine wave/session
  verification_hash: new Column({ type: ColumnType.TEXT }),    // HMAC-SHA-256, set by Edge Fn
  recorded_at:       new Column({ type: ColumnType.TEXT }),
  meta:              new Column({ type: ColumnType.TEXT }),    // JSON string
}, { indexes: { by_athlete_drill: ['athlete_id', 'drill_type'] } });

/**
 * athletes — read-only pull; all registrations for the event.
 * Replaces the IndexedDB athlete_cache store entirely.
 */
const athletes = new Table({
  event_id:     new Column({ type: ColumnType.TEXT }),
  first_name:   new Column({ type: ColumnType.TEXT }),
  last_name:    new Column({ type: ColumnType.TEXT }),
  grade:        new Column({ type: ColumnType.TEXT }),
  position:     new Column({ type: ColumnType.TEXT }),
  band_id:      new Column({ type: ColumnType.TEXT }),
  created_at:   new Column({ type: ColumnType.TEXT }),
}, { indexes: { by_band: ['band_id'], by_event: ['event_id'] } });

/**
 * bands — read-only pull; band→athlete mapping.
 */
const bands = new Table({
  event_id:       new Column({ type: ColumnType.TEXT }),
  display_number: new Column({ type: ColumnType.INTEGER }),
  status:         new Column({ type: ColumnType.TEXT }),
  athlete_id:     new Column({ type: ColumnType.TEXT }),
}, { indexes: { by_display: ['event_id', 'display_number'] } });

/**
 * stations — read-only pull; station configuration for the event.
 */
const stations = new Table({
  event_id:   new Column({ type: ColumnType.TEXT }),
  name:       new Column({ type: ColumnType.TEXT }),
  drill_type: new Column({ type: ColumnType.TEXT }),
  enabled:    new Column({ type: ColumnType.INTEGER }),
});

/**
 * device_status — mutable upsert; one row per (event, station, device).
 * Push: via upsert_device_status_hlc RPC (HLC-guarded).
 * Pull: all device statuses for the event (admin dashboard visibility).
 */
const device_status = new Table({
  event_id:           new Column({ type: ColumnType.TEXT }),
  station_id:         new Column({ type: ColumnType.TEXT }),
  device_label:       new Column({ type: ColumnType.TEXT }),
  last_seen_at:       new Column({ type: ColumnType.TEXT }),
  is_online:          new Column({ type: ColumnType.INTEGER }),
  pending_queue_count: new Column({ type: ColumnType.INTEGER }),
  last_sync_at:       new Column({ type: ColumnType.TEXT }),
  hlc_timestamp:      new Column({ type: ColumnType.TEXT }),
}, { indexes: { by_event: ['event_id'] } });

/**
 * audit_log — append-only pull; read by admin dashboard.
 * Push: INSERT only, via direct supabase.from('audit_log').insert()
 *       wrapped in uploadData. Postgres triggers auto-populate most entries.
 */
const audit_log = new Table({
  event_id:    new Column({ type: ColumnType.TEXT }),
  action:      new Column({ type: ColumnType.TEXT }),
  entity_type: new Column({ type: ColumnType.TEXT }),
  entity_id:   new Column({ type: ColumnType.TEXT }),
  new_value:   new Column({ type: ColumnType.TEXT }),
  created_at:  new Column({ type: ColumnType.TEXT }),
});

/**
 * capture_telemetry — per-capture diagnostic record (migration 018).
 *
 * Pull: each device receives telemetry for its event_id.
 * Push: via upsert_capture_telemetry_lww RPC (strict device_timestamp LWW).
 *
 * device_timestamp is the LWW key. Two offline devices capturing the same
 * athlete/drill within 500ms: higher device_timestamp wins on the server.
 * client_telemetry_id provides idempotency (safe re-delivery on reconnect).
 */
const capture_telemetry = new Table({
  client_telemetry_id:   new Column({ type: ColumnType.TEXT }),
  event_id:              new Column({ type: ColumnType.TEXT }),
  result_id:             new Column({ type: ColumnType.TEXT }),  // nullable
  station_id:            new Column({ type: ColumnType.TEXT }),
  athlete_id:            new Column({ type: ColumnType.TEXT }),
  drill_type:            new Column({ type: ColumnType.TEXT }),
  device_timestamp:      new Column({ type: ColumnType.INTEGER }), // LWW key
  device_id:             new Column({ type: ColumnType.TEXT }),
  device_label:          new Column({ type: ColumnType.TEXT }),
  captured_at:           new Column({ type: ColumnType.TEXT }),
  capture_duration_ms:   new Column({ type: ColumnType.INTEGER }),
  ble_rssi:              new Column({ type: ColumnType.INTEGER }),
  ble_phy:               new Column({ type: ColumnType.TEXT }),
  validation_status:     new Column({ type: ColumnType.TEXT }),
  was_offline:           new Column({ type: ColumnType.INTEGER }), // 0|1 boolean
  sync_latency_ms:       new Column({ type: ColumnType.INTEGER }),
  clock_offset_ms:       new Column({ type: ColumnType.REAL }),   // BLE clock sync offset ms
  rtt_ms:                new Column({ type: ColumnType.REAL }),   // BLE clock sync RTT ms
  meta:                  new Column({ type: ColumnType.TEXT }),
}, {
  indexes: {
    by_event:        ['event_id'],
    by_athlete_drill: ['athlete_id', 'drill_type'],
    by_device_ts:    ['device_timestamp'],
  },
});

/**
 * result_provenance — one row per result tracking device lineage (migration 018).
 *
 * Pull: admin bucket only (non-sensitive but not needed on staff devices).
 * Push: via insert_result_provenance RPC (idempotent, UNIQUE result_id).
 */
const result_provenance = new Table({
  result_id:        new Column({ type: ColumnType.TEXT }),
  device_id:        new Column({ type: ColumnType.TEXT }),
  device_label:     new Column({ type: ColumnType.TEXT }),
  station_id:       new Column({ type: ColumnType.TEXT }),
  device_timestamp: new Column({ type: ColumnType.INTEGER }),
  hlc_timestamp:    new Column({ type: ColumnType.TEXT }),
  sync_latency_ms:  new Column({ type: ColumnType.INTEGER }),
  was_offline:      new Column({ type: ColumnType.INTEGER }),
}, { indexes: { by_device: ['device_id'] } });

// ---------------------------------------------------------------------------
// LOCAL-only tables (never synced to Supabase)
// ---------------------------------------------------------------------------

/**
 * outbox_meta — augments PowerSync's internal ps_crud table with states
 * that PowerSync does not model natively:
 *   'pending'         — normal; ps_crud will upload on reconnect
 *   'pending_review'  — parked; suspicious duplicate awaiting operator decision
 *   'dead_letter'     — MAX_RETRIES exceeded; operator must force-retry
 *
 * Keyed by client_result_id (same as the result's id in the results table).
 * PowerSync's ps_crud already guarantees delivery; this table only tracks
 * the EXTENDED states that require UI feedback.
 *
 * This is the only table that remains in-device storage. All other formerly
 * IndexedDB state moves into PowerSync SQLite.
 */
const outbox_meta = new Table({
  item_type:        new Column({ type: ColumnType.TEXT }),   // 'result' | 'device_status' | 'audit_log'
  status:           new Column({ type: ColumnType.TEXT }),   // 'pending' | 'pending_review' | 'dead_letter'
  retry_count:      new Column({ type: ColumnType.INTEGER }),
  last_attempt_at:  new Column({ type: ColumnType.INTEGER }),// Date.now() — elapsed-time only
  error_message:    new Column({ type: ColumnType.TEXT }),
  hlc_timestamp:    new Column({ type: ColumnType.TEXT }),   // copied from the result row for fast lookup
  // Suspicious duplicate challenge details (populated when status='pending_review')
  challenge_json:   new Column({ type: ColumnType.TEXT }),   // JSON string of DuplicateChallenge
}, { localOnly: true });

/**
 * event_config — device-local KV store.
 * Primary use: caching hashed admin override PIN for offline validation.
 * Replaces the IndexedDB event_config store.
 */
const event_config = new Table({
  value_json: new Column({ type: ColumnType.TEXT }),
}, { localOnly: true });

// ---------------------------------------------------------------------------
// Schema export
// ---------------------------------------------------------------------------

export const AppSchema = new Schema({
  results,
  athletes,
  bands,
  stations,
  device_status,
  audit_log,
  capture_telemetry,
  result_provenance,
  outbox_meta,
  event_config,
});

export type Database = (typeof AppSchema)['types'];
