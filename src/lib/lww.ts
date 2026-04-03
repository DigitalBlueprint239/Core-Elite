/**
 * Add-biased Last-Write-Wins (LWW) conflict resolution — v2 §3.1.2
 *
 * Core principle from the framework:
 *   "when max_t(add) = max_t(remove), preserve the record. Never silently
 *    delete a timing result."
 *
 * In the web MVP context:
 *   - Timing results are IMMUTABLE: each rep = a new record with a unique
 *     client_result_id (v1 §3.6.4). Two scouts recording the same athlete
 *     write NEW records, not updating the same one. There is no LWW conflict
 *     between them — both records survive. Best result is computed at query time.
 *
 *   - The LWW conflict scenario arises for MUTABLE records:
 *       * device_status upserts (same station_id from multiple tablets)
 *       * Any future mutable domain objects (e.g. athlete profile edits)
 *
 *   - "Add-biased" means: when add_timestamp >= remove_timestamp, keep the record.
 *     A tie (equal timestamps from two devices writing in the same millisecond)
 *     always resolves in favor of keeping data — never discarding it.
 *
 * Stack adaptation note:
 *   The framework specifies WatermelonDB/SQLite with per-column LWW resolution.
 *   On our Vite + Supabase + IndexedDB stack, LWW resolution happens in two places:
 *     1. Client-side: in useOfflineSync before pushing to Supabase
 *     2. Server-side: the submit_result_secure RPC treats duplicate client_result_id
 *        as success (effectively add-biased at the database layer)
 */

import { compareHlc } from './hlc';

// ---------------------------------------------------------------------------
// Core predicates
// ---------------------------------------------------------------------------

/**
 * Returns true if `incomingHlc` is strictly later than `existingHlc`.
 * The incoming record should replace the existing one only if it wins outright.
 *
 * Strict inequality (>) not >= ensures ties favor the existing record.
 */
export function lwwShouldReplace(
  existingHlc: string,
  incomingHlc: string,
): boolean {
  return compareHlc(incomingHlc, existingHlc) > 0;
}

/**
 * Add-biased keep decision.
 *
 * Returns true if a record with `addHlc` should be preserved when a
 * delete / overwrite operation arrives with timestamp `removeHlc`.
 *
 * Add-biased rule (v2 §3.1.2):
 *   max_t(add) >= max_t(remove)  →  keep the record  (>= catches the tie)
 *   max_t(add) <  max_t(remove)  →  allow the remove
 *
 * In practice at combine scale: the tie case (same-millisecond writes from
 * two tablets) is the primary scenario this covers. Always keeping the add
 * ensures no timing result is ever silently lost.
 */
export function addBiasedShouldKeep(
  addHlc: string,
  removeHlc: string,
): boolean {
  return compareHlc(addHlc, removeHlc) >= 0;
}

// ---------------------------------------------------------------------------
// Outbox conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a conflict between two outbox payloads competing for the same
 * logical record (same client_result_id or same station_id for device_status).
 *
 * Returns the payload that should be considered authoritative.
 *
 * Add-biased tie rule:
 *   - Equal HLC → return existing (first-write-wins as tiebreak, both survive)
 *   - Incoming strictly later → return incoming
 *   - Existing strictly later → return existing
 *
 * Important: "returning existing" for a tie does NOT discard the incoming
 * record at the outbox level. The outbox still delivers both to the server.
 * The server's `submit_result_secure` RPC treats the second delivery as
 * 'duplicate' and responds with success — both writes are idempotent.
 */
export function resolvePayloadConflict<T extends { hlc_timestamp?: string }>(
  existing: T,
  incoming: T,
): T {
  const existingHlc = existing.hlc_timestamp ?? '';
  const incomingHlc = incoming.hlc_timestamp ?? '';

  // If one side has no HLC, the other wins automatically
  if (!existingHlc && !incomingHlc) return existing;
  if (!existingHlc) return incoming;
  if (!incomingHlc) return existing;

  return lwwShouldReplace(existingHlc, incomingHlc) ? incoming : existing;
}

// ---------------------------------------------------------------------------
// Device status conflict resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a conflict between two device_status heartbeat payloads for the
 * same station_id. Unlike timing results, device_status IS mutable (upsert).
 *
 * The most-recently-observed heartbeat wins. This is the only case where
 * a record can be "replaced" — and it's intentional, not a bug.
 *
 * Returns true if the incoming status update should overwrite the stored one.
 */
export function deviceStatusShouldUpdate(
  existingHlc: string,
  incomingHlc: string,
): boolean {
  // Strict > for mutable records — ties go to existing (stable)
  return compareHlc(incomingHlc, existingHlc) > 0;
}
