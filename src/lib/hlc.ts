/**
 * Hybrid Logical Clock (HLC) — v2 §3.1.3, v3 §3.1.2
 *
 * Solves the core problem identified in the framework:
 *   - Date.now() collisions between offline devices are inevitable (same ms on two tablets)
 *   - Date.now() is subject to NTP/OS clock adjustments that can go backward
 *   - HLC provides a deterministic total order with no coordinator required
 *
 * String format (v3 §3.1.2):
 *   {pt padded to 16 digits}_{l padded to 10 digits}_{nodeId}
 *   e.g. "0001750000000000_0000000000_device-a1b2c3d4"
 *
 * This format is lexicographically sortable — standard IndexedDB index or
 * Postgres B-Tree index gives correct temporal order without any custom comparator.
 *
 * Total order:
 *   1. Higher physical time (pt) wins
 *   2. Tie on pt → higher logical counter (l) wins
 *   3. Tie on both → higher nodeId wins (deterministic, arbitrary tiebreak)
 *
 * Persistence:
 *   HLC state is saved to localStorage so the logical counter survives page reloads.
 *   A fresh device starts at pt=0, l=0 — the first tick() call advances pt to Date.now().
 */

import { getDeviceId } from './device';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HLCComponents {
  pt:     number;  // physical time in milliseconds
  l:      number;  // logical counter
  nodeId: string;  // device identifier
}

// Spec-form tuple representation: HLC = [pt, l, id]. Used by callers that
// prefer positional access; the canonical wire format is the formatted
// string produced by formatHlc(). The `id` slot is the same nodeId as
// HLCComponents.
export type HLCTuple = [pt: number, l: number, id: string];

/** Convert the spec tuple into the canonical pt(16)_l(10)_id wire string. */
export function tupleToHlc([pt, l, id]: HLCTuple): string {
  return formatHlc(pt, l, id);
}

/** Convert the canonical wire string back to the spec tuple. */
export function hlcToTuple(hlcStr: string): HLCTuple {
  const c = parseHlc(hlcStr);
  return [c.pt, c.l, c.nodeId];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const HLC_STORAGE_KEY = 'core_elite_hlc_state';

interface HLCState {
  pt: number;
  l:  number;
}

function loadState(): HLCState {
  try {
    const raw = localStorage.getItem(HLC_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<HLCState>;
      const pt = Number(parsed.pt);
      const l  = Number(parsed.l);
      if (Number.isFinite(pt) && Number.isFinite(l)) {
        return { pt, l };
      }
    }
  } catch {
    // localStorage unavailable or JSON corrupt — start fresh
  }
  return { pt: 0, l: 0 };
}

function saveState(state: HLCState): void {
  try {
    localStorage.setItem(HLC_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage write failed (private mode / quota exceeded) — state valid in memory for session
  }
}

// Module-level mutable state — single HLC per browser context (one device = one nodeId)
let _state: HLCState = loadState();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Serialize HLC components to the canonical sortable string format.
 * pt:     16 digits — covers millisecond timestamps until year 33658 CE
 * l:      10 digits — covers 10 billion logical increments (unreachable in practice)
 * nodeId: variable  — device-{8-char uuid}, e.g. "device-a1b2c3d4"
 */
export function formatHlc(pt: number, l: number, nodeId: string): string {
  return `${String(pt).padStart(16, '0')}_${String(l).padStart(10, '0')}_${nodeId}`;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * tick() — Generate a new HLC timestamp for a local write.
 *
 * Call this exactly once per mutation at the moment of write.
 * Calling it multiple times for the same logical event will advance
 * the logical counter unnecessarily — generate once, use everywhere.
 *
 * Algorithm (Kulkarni & Demirbas 2014):
 *   new_pt = max(local.pt, Date.now())
 *   new_l  = (new_pt === local.pt) ? local.l + 1 : 0
 */
export function tick(): string {
  const now    = Date.now();
  const nodeId = getDeviceId();

  const newPt = Math.max(_state.pt, now);
  const newL  = newPt === _state.pt ? _state.l + 1 : 0;

  _state = { pt: newPt, l: newL };
  saveState(_state);

  return formatHlc(newPt, newL, nodeId);
}

/**
 * update() — Advance local HLC after receiving a remote HLC string.
 *
 * Call this when processing sync data from another device (pull path).
 * Ensures the local clock is always ahead of any clock we've observed.
 *
 * Algorithm (Kulkarni & Demirbas 2014, receive event):
 *   new_pt = max(local.pt, remote.pt, Date.now())
 *   new_l  = depends on which source contributed new_pt
 */
export function update(remoteHlcStr: string): void {
  let remote: HLCComponents;
  try {
    remote = parseHlc(remoteHlcStr);
  } catch {
    return; // Malformed remote HLC — do not corrupt local state
  }

  const now = Date.now();

  const newPt = Math.max(_state.pt, remote.pt, now);

  let newL: number;
  if (newPt === _state.pt && newPt === remote.pt) {
    // Both local and remote match the new physical time — take the higher logical + 1
    newL = Math.max(_state.l, remote.l) + 1;
  } else if (newPt === _state.pt) {
    // Local physical time is dominant — advance local logical counter
    newL = _state.l + 1;
  } else if (newPt === remote.pt) {
    // Remote physical time is dominant — follow remote logical counter + 1
    newL = remote.l + 1;
  } else {
    // Wall clock (Date.now()) is ahead of both — reset logical counter
    newL = 0;
  }

  _state = { pt: newPt, l: newL };
  saveState(_state);
}

// ---------------------------------------------------------------------------
// Parsing & comparison
// ---------------------------------------------------------------------------

/**
 * Parse an HLC string into its components.
 * Throws if the string does not match the expected format.
 *
 * Note: nodeId may contain hyphens (e.g. "device-a1b2c3d4") but not underscores,
 * so splitting on '_' and rejoining from index 2 correctly handles all cases.
 */
export function parseHlc(hlcStr: string): HLCComponents {
  const parts = hlcStr.split('_');
  if (parts.length < 3) {
    throw new Error(`parseHlc: invalid format "${hlcStr}" — expected "pt_l_nodeId"`);
  }
  const pt = parseInt(parts[0], 10);
  const l  = parseInt(parts[1], 10);
  if (!Number.isFinite(pt) || !Number.isFinite(l)) {
    throw new Error(`parseHlc: non-numeric pt or l in "${hlcStr}"`);
  }
  return {
    pt,
    l,
    nodeId: parts.slice(2).join('_'),
  };
}

/**
 * Total order comparator for HLC strings.
 *
 * Because pt and l are zero-padded to fixed widths, standard lexicographic
 * string comparison gives correct temporal ordering (v3 §3.1.2).
 * No parsing required — compare the strings directly.
 *
 * Returns: negative if a < b (a is earlier), 0 if equal, positive if a > b (a is later)
 */
export function compareHlc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return  1;
  return 0;
}

/**
 * Returns the later of two HLC strings.
 */
export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

/**
 * Returns the current local HLC state without advancing it.
 * For inspection / debug only — use tick() to generate a write timestamp.
 */
export function currentHlc(): string {
  return formatHlc(_state.pt, _state.l, getDeviceId());
}

// ---------------------------------------------------------------------------
// Spec-named API (v2 corpus §3.1.3)
//
// `now`, `receive`, `compare` are the names called out in the framework
// specification. They are thin re-exports of the existing implementation
// — same algorithm, same byte-for-byte format, same lexicographic
// comparison. Adding the aliases here lets every caller speak the spec
// vocabulary without forcing a rename of the long-standing tick / update
// / compareHlc surface that the rest of the codebase already consumes.
// ---------------------------------------------------------------------------

/** Generate a new HLC timestamp for a local write (alias of tick). */
export const now: typeof tick = tick;

/** Advance the local clock past a remote HLC string (alias of update). */
export const receive: typeof update = update;

/** Lexicographic comparator for HLC strings (alias of compareHlc). */
export const compare: typeof compareHlc = compareHlc;
