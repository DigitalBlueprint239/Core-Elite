/**
 * machine.test.ts
 *
 * State machine unit tests — pure reducer, no RN, no DOM.
 *
 * Tests:
 *   ✓ Full happy path: idle → drill_active → result_captured → syncing → idle
 *   ✓ Auto-advance: ATHLETE_SCANNED goes directly to drill_active (zero extra taps)
 *   ✓ INPUT_CHANGED phase transitions: '' → drill_active, non-empty → result_captured
 *   ✓ CONFIRM only valid in result_captured — ignored in other phases
 *   ✓ RESET from any phase returns to idle, clears athlete + input
 *   ✓ Error system: ADD_ERROR non-blocking (phase unchanged), DISMISS_ERROR marks dismissed
 *   ✓ Error cap: 4th error auto-dismisses oldest
 *   ✓ Attempt counter: increments on SUBMIT_DONE, persists per-athlete, resets on new athlete
 *   ✓ SET_ONLINE + PENDING_COUNT update without phase change
 */

import { describe, it, expect } from 'vitest';
import {
  captureReducer,
  initialState,
  CaptureState,
  CaptureAction,
} from '../machine';
import { Athlete, Station, Result } from '../../../../../src/lib/types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const STATION: Station = {
  id:         'station-001',
  event_id:   'event-001',
  name:       '40-Yard Dash',
  type:       'timing',
  drill_type: '40_yard_dash',
};

const ATHLETE_A: Athlete = {
  id:             'athlete-001',
  event_id:       'event-001',
  first_name:     'Marcus',
  last_name:      'Williams',
  date_of_birth:  '2009-03-15',
  grade:          '9',
  position:       'WR',
  parent_name:    'John Williams',
  parent_email:   'john@example.com',
  parent_phone:   '5555550100',
  band_id:        'band-042',
  created_at:     '2026-01-01T00:00:00Z',
  bands:          { display_number: '42' },
};

const ATHLETE_B: Athlete = {
  ...ATHLETE_A,
  id:         'athlete-002',
  first_name: 'Devon',
  last_name:  'Carter',
  band_id:    'band-007',
  bands:      { display_number: '7' },
};

const RESULT: Result = {
  id:               'result-001',
  client_result_id: 'client-001',
  athlete_id:       ATHLETE_A.id,
  band_id:          ATHLETE_A.band_id!,
  station_id:       STATION.id,
  drill_type:       STATION.drill_type,
  value_num:        4.87,
  recorded_at:      '2026-04-10T12:00:00Z',
  attempt_number:   0,
  validation_status: 'clean',
};

// Helper: apply a sequence of actions from a given state
function applyAll(state: CaptureState, actions: CaptureAction[]): CaptureState {
  return actions.reduce(captureReducer, state);
}

// ---------------------------------------------------------------------------
// Station loaded
// ---------------------------------------------------------------------------

describe('STATION_LOADED', () => {
  it('sets station without changing phase', () => {
    const s = captureReducer(initialState(), { type: 'STATION_LOADED', station: STATION });
    expect(s.station).toBe(STATION);
    expect(s.phase).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Athlete scan — zero-tap auto-advance
// ---------------------------------------------------------------------------

describe('ATHLETE_SCANNED', () => {
  it('auto-advances directly to drill_active (no confirmation tap needed)', () => {
    const s = captureReducer(initialState(), { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A });
    expect(s.phase).toBe('drill_active');
    expect(s.athlete).toBe(ATHLETE_A);
  });

  it('clears previous input on new athlete scan', () => {
    const withInput = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
    ]);
    expect(withInput.inputValue).toBe('4.87');

    // New athlete scanned — input clears
    const withNew = captureReducer(withInput, { type: 'ATHLETE_SCANNED', athlete: ATHLETE_B });
    expect(withNew.inputValue).toBe('');
    expect(withNew.athlete).toBe(ATHLETE_B);
    expect(withNew.phase).toBe('drill_active');
  });

  it('preserves attemptNumber when same athlete is re-scanned', () => {
    const after1 = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'CONFIRM' },
      { type: 'SUBMIT_DONE',     result: RESULT },
    ]);
    expect(after1.attemptNumber).toBe(1);

    // Re-scan same athlete
    const rescan = captureReducer(after1, { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A });
    expect(rescan.attemptNumber).toBe(1); // preserved
    expect(rescan.phase).toBe('drill_active');
  });

  it('resets attemptNumber when different athlete is scanned', () => {
    const after1 = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'CONFIRM' },
      { type: 'SUBMIT_DONE',     result: RESULT },
    ]);
    expect(after1.attemptNumber).toBe(1);

    const newAthlete = captureReducer(after1, { type: 'ATHLETE_SCANNED', athlete: ATHLETE_B });
    expect(newAthlete.attemptNumber).toBe(0); // reset
  });
});

// ---------------------------------------------------------------------------
// Input transitions
// ---------------------------------------------------------------------------

describe('INPUT_CHANGED phase transitions', () => {
  it('non-empty input in drill_active → result_captured', () => {
    const s = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4' },
    ]);
    expect(s.phase).toBe('result_captured');
    expect(s.inputValue).toBe('4');
  });

  it('clearing input in result_captured → drill_active', () => {
    const s = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'INPUT_CHANGED',   value: '' },
    ]);
    expect(s.phase).toBe('drill_active');
    expect(s.inputValue).toBe('');
  });

  it('does not transition if already in syncing phase', () => {
    const s = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'CONFIRM' },
      // now syncing — input changes should be ignored for phase
      { type: 'INPUT_CHANGED',   value: '' },
    ]);
    expect(s.phase).toBe('syncing'); // phase unchanged
  });
});

// ---------------------------------------------------------------------------
// Full happy path
// ---------------------------------------------------------------------------

describe('full happy path', () => {
  it('idle → drill_active → result_captured → syncing → idle in ≤3 decision taps', () => {
    const s0 = applyAll(initialState(), [
      { type: 'STATION_LOADED',  station: STATION },
    ]);
    expect(s0.phase).toBe('idle');

    // TAP 1: scan wristband (opens camera — 1 physical tap)
    // Camera reads QR → auto-dispatches ATHLETE_SCANNED
    const s1 = captureReducer(s0, { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A });
    expect(s1.phase).toBe('drill_active'); // auto-advanced, no extra tap

    // Keypad entry (data entry, not counted as decision taps)
    const s2 = applyAll(s1, [
      { type: 'INPUT_CHANGED', value: '4' },
      { type: 'INPUT_CHANGED', value: '4.' },
      { type: 'INPUT_CHANGED', value: '4.8' },
      { type: 'INPUT_CHANGED', value: '4.87' },
    ]);
    expect(s2.phase).toBe('result_captured');

    // TAP 2: CONFIRM button (1 decision tap)
    const s3 = captureReducer(s2, { type: 'CONFIRM' });
    expect(s3.phase).toBe('syncing');
    expect(s3.submitting).toBe(true);

    // Submit completes → back to idle
    const s4 = captureReducer(s3, { type: 'SUBMIT_DONE', result: RESULT });
    expect(s4.phase).toBe('idle');
    expect(s4.athlete).toBeNull();
    expect(s4.inputValue).toBe('');
    expect(s4.lastResult).toBe(RESULT);
    expect(s4.attemptNumber).toBe(1);
    expect(s4.submitting).toBe(false);

    // Total decision taps: 2 (scan + confirm) — well within 3-tap requirement
  });
});

// ---------------------------------------------------------------------------
// CONFIRM guard
// ---------------------------------------------------------------------------

describe('CONFIRM guard', () => {
  it('is ignored if phase is not result_captured', () => {
    const idle     = captureReducer(initialState(), { type: 'CONFIRM' });
    expect(idle.phase).toBe('idle');
    expect(idle.submitting).toBe(false);

    const active   = captureReducer(
      applyAll(initialState(), [{ type: 'ATHLETE_SCANNED', athlete: ATHLETE_A }]),
      { type: 'CONFIRM' }
    );
    expect(active.phase).toBe('drill_active'); // not result_captured → ignored
  });
});

// ---------------------------------------------------------------------------
// RESET
// ---------------------------------------------------------------------------

describe('RESET', () => {
  it('returns to idle from any phase', () => {
    const phases = [
      applyAll(initialState(), [
        { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      ]),
      applyAll(initialState(), [
        { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
        { type: 'INPUT_CHANGED',   value: '4.87' },
      ]),
    ];

    for (const s of phases) {
      const reset = captureReducer(s, { type: 'RESET' });
      expect(reset.phase).toBe('idle');
      expect(reset.athlete).toBeNull();
      expect(reset.inputValue).toBe('');
      expect(reset.submitting).toBe(false);
    }
  });

  it('does not clear lastResult or station on reset', () => {
    const s = applyAll(initialState(), [
      { type: 'STATION_LOADED',  station: STATION },
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'CONFIRM' },
      { type: 'SUBMIT_DONE',     result: RESULT },
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_B },
      { type: 'RESET' },
    ]);
    expect(s.lastResult).toBe(RESULT);  // preserved
    expect(s.station).toBe(STATION);    // preserved
  });
});

// ---------------------------------------------------------------------------
// Error system — non-blocking
// ---------------------------------------------------------------------------

describe('error system', () => {
  it('ADD_ERROR does not change phase', () => {
    const scanning = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
    ]);
    const withErr = captureReducer(scanning, {
      type: 'ADD_ERROR', message: 'Network hiccup', severity: 'warn',
    });
    expect(withErr.phase).toBe('result_captured'); // unchanged
    expect(withErr.errors).toHaveLength(1);
    expect(withErr.errors[0].message).toBe('Network hiccup');
    expect(withErr.errors[0].dismissed).toBe(false);
  });

  it('DISMISS_ERROR marks only the targeted error as dismissed', () => {
    const s = applyAll(initialState(), [
      { type: 'ADD_ERROR', id: 'e1', message: 'Error A', severity: 'warn' },
      { type: 'ADD_ERROR', id: 'e2', message: 'Error B', severity: 'error' },
    ]);
    const after = captureReducer(s, { type: 'DISMISS_ERROR', id: 'e1' });
    expect(after.errors.find(e => e.id === 'e1')!.dismissed).toBe(true);
    expect(after.errors.find(e => e.id === 'e2')!.dismissed).toBe(false);
  });

  it('auto-dismisses oldest when 4th error is added (cap=3 visible)', () => {
    const s = applyAll(initialState(), [
      { type: 'ADD_ERROR', id: 'e1', message: 'E1', severity: 'warn' },
      { type: 'ADD_ERROR', id: 'e2', message: 'E2', severity: 'warn' },
      { type: 'ADD_ERROR', id: 'e3', message: 'E3', severity: 'warn' },
      { type: 'ADD_ERROR', id: 'e4', message: 'E4', severity: 'warn' },
    ]);
    const visible = s.errors.filter(e => !e.dismissed);
    expect(visible).toHaveLength(3);
    // e1 should be the auto-dismissed one
    expect(s.errors.find(e => e.id === 'e1')!.dismissed).toBe(true);
    expect(s.errors.find(e => e.id === 'e4')!.dismissed).toBe(false);
  });

  it('error during syncing returns to idle without losing lastResult', () => {
    // Simulate a network failure during submit: after CONFIRM, something
    // calls RESET (the error path in handleConfirm). The state should allow
    // immediate re-scan.
    const s = applyAll(initialState(), [
      { type: 'STATION_LOADED',  station: STATION },
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
      { type: 'CONFIRM' },
      { type: 'ADD_ERROR', message: 'Submit failed — queued offline', severity: 'warn' },
      { type: 'RESET' },
    ]);
    expect(s.phase).toBe('idle');
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].dismissed).toBe(false); // still visible
  });
});

// ---------------------------------------------------------------------------
// Network state
// ---------------------------------------------------------------------------

describe('network state', () => {
  it('SET_ONLINE and PENDING_COUNT do not affect phase', () => {
    const active = applyAll(initialState(), [
      { type: 'ATHLETE_SCANNED', athlete: ATHLETE_A },
      { type: 'INPUT_CHANGED',   value: '4.87' },
    ]);

    const offline = captureReducer(active, { type: 'SET_ONLINE', isOnline: false });
    expect(offline.phase).toBe('result_captured');
    expect(offline.isOnline).toBe(false);

    const withPending = captureReducer(offline, { type: 'PENDING_COUNT', count: 5 });
    expect(withPending.phase).toBe('result_captured');
    expect(withPending.pendingCount).toBe(5);
  });
});
