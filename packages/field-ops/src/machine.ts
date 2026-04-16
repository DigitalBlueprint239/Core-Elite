/**
 * Station Capture State Machine
 *
 * States:
 *   idle            — waiting for athlete QR scan
 *   athlete_scanned — athlete confirmed, awaiting result entry
 *   drill_active    — user is entering result on keypad
 *   result_captured — result entered, pending confirmation
 *   syncing         — submit in flight (optimistic UI, non-blocking)
 *
 * Transitions:
 *   idle            → athlete_scanned   : QR scan success
 *   athlete_scanned → drill_active      : AUTO (no tap required — immediate on scan)
 *   drill_active    → result_captured   : keypad entry produces non-empty value
 *   result_captured → syncing           : CONFIRM tap
 *   syncing         → idle              : submit complete (success OR queued offline)
 *   ANY             → idle              : RESET (back button / clear)
 *   ANY             → [same state]      : error arrives (non-blocking, state unchanged)
 *
 * Tap count to complete a drill capture:
 *   1. Camera opens / QR read by scanner → auto-proceeds (0 decision taps)
 *   2. Keypad digits (data entry, not decision taps)
 *   3. CONFIRM button (1 decision tap)
 *   Total decision taps: 1 (plus opening camera = 2 max)
 */

import { Athlete, Station, Result } from '../../../src/lib/types';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type CapturePhase =
  | 'idle'
  | 'athlete_scanned'
  | 'drill_active'
  | 'result_captured'
  | 'syncing';

export interface ErrorEntry {
  id:        string;
  message:   string;
  severity:  'warn' | 'error';
  at:        number;  // Date.now() — for display only, never used in conflict resolution
  dismissed: boolean;
}

export interface CaptureState {
  phase:     CapturePhase;
  station:   Station | null;
  athlete:   Athlete | null;
  inputValue: string;          // raw keypad string — e.g. "4.87"
  lastResult:    Result | null;   // most recent submitted result for this station session
  lastAthleteId: string | null;   // retained after SUBMIT_DONE to detect same-athlete re-scans
  attemptNumber: number;          // increments per submission, resets on new athlete
  errors:    ErrorEntry[];     // non-blocking persistent error list
  submitting: boolean;         // true while submit RPC in flight
  pendingCount: number;        // offline outbox depth
  isOnline:  boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type CaptureAction =
  | { type: 'STATION_LOADED';   station: Station }
  | { type: 'ATHLETE_SCANNED';  athlete: Athlete }
  | { type: 'INPUT_CHANGED';    value: string }
  | { type: 'CONFIRM' }
  | { type: 'SUBMIT_DONE';      result: Result }
  | { type: 'RESET' }
  | { type: 'SET_ONLINE';       isOnline: boolean }
  | { type: 'PENDING_COUNT';    count: number }
  | { type: 'ADD_ERROR';        message: string; severity: 'warn' | 'error'; id?: string }
  | { type: 'DISMISS_ERROR';    id: string };

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function initialState(): CaptureState {
  return {
    phase:         'idle',
    station:       null,
    athlete:       null,
    inputValue:    '',
    lastResult:    null,
    lastAthleteId: null,
    attemptNumber: 0,
    errors:        [],
    submitting:    false,
    pendingCount:  0,
    isOnline:      true,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function captureReducer(state: CaptureState, action: CaptureAction): CaptureState {
  switch (action.type) {

    case 'STATION_LOADED':
      return { ...state, station: action.station };

    case 'ATHLETE_SCANNED':
      // Auto-advance past athlete_scanned straight to drill_active.
      // No confirmation tap required — we show athlete info in the header
      // and the operator can reset immediately if it's wrong.
      //
      // Same-athlete detection: compare against lastAthleteId, not state.athlete,
      // because athlete is cleared on SUBMIT_DONE but lastAthleteId persists.
      return {
        ...state,
        phase:         'drill_active',
        athlete:       action.athlete,
        lastAthleteId: action.athlete.id,
        inputValue:    '',
        attemptNumber: (state.athlete?.id ?? state.lastAthleteId) === action.athlete.id
                         ? state.attemptNumber  // same athlete re-scan: keep count
                         : 0,                   // new athlete: reset
      };

    case 'INPUT_CHANGED': {
      const next = { ...state, inputValue: action.value };
      // Transition: any non-empty input moves us to result_captured phase.
      // Clearing input moves back to drill_active.
      if (action.value.length > 0 && state.phase === 'drill_active') {
        next.phase = 'result_captured';
      } else if (action.value.length === 0 && state.phase === 'result_captured') {
        next.phase = 'drill_active';
      }
      return next;
    }

    case 'CONFIRM':
      if (state.phase !== 'result_captured') return state;
      return { ...state, phase: 'syncing', submitting: true };

    case 'SUBMIT_DONE':
      return {
        ...state,
        phase:         'idle',
        athlete:       null,          // cleared — but lastAthleteId persists for re-scan detection
        inputValue:    '',
        lastResult:    action.result,
        attemptNumber: state.attemptNumber + 1,
        submitting:    false,
      };

    case 'RESET':
      return {
        ...state,
        phase:      'idle',
        athlete:    null,
        inputValue: '',
        submitting: false,
      };

    case 'SET_ONLINE':
      return { ...state, isOnline: action.isOnline };

    case 'PENDING_COUNT':
      return { ...state, pendingCount: action.count };

    case 'ADD_ERROR': {
      // Cap at 3 visible errors — oldest dismissed automatically
      const entry: ErrorEntry = {
        id:        action.id ?? String(Date.now()),
        message:   action.message,
        severity:  action.severity,
        at:        Date.now(),
        dismissed: false,
      };
      const existing = state.errors.filter(e => !e.dismissed);
      const pruned   = existing.length >= 3
        ? [{ ...existing[0], dismissed: true }, ...existing.slice(1)]
        : existing;
      return { ...state, errors: [...pruned, entry] };
    }

    case 'DISMISS_ERROR':
      return {
        ...state,
        errors: state.errors.map(e =>
          e.id === action.id ? { ...e, dismissed: true } : e
        ),
      };

    default:
      return state;
  }
}
