/**
 * useRFAdaptation.ts
 * Core Elite — Phase 2: RF Adaptation + Clock Sync React hook
 *
 * Subscribes to the native RF adaptation events emitted by CoreEliteBLEModule
 * (iOS) / BLETimingModule (Android) and exposes a clean React interface for:
 *   - Current RF adaptation state per connected device
 *   - Smoothed RSSI (EMA α=0.3, sourced from native layer)
 *   - Clock sync state (offset, RTT, sample count, sync quality)
 *   - Fallback gate — isFallbackActive drives the manual entry UI
 *
 * Usage:
 *   const { isFallbackActive, rfState, clockSync, resetFallback } = useRFAdaptation();
 *
 *   if (isFallbackActive) {
 *     return <ManualEntryScreen />;
 *   }
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { NativeEventEmitter } from 'react-native';
import NativeBLETimingModule from './NativeBLETimingModule';
import type {
  RFAdaptationState,
  RSSIUpdateEvent,
  RFAdaptationEvent,
  ClockSyncUpdateEvent,
  SignalDegradedEvent,
  FallbackRequiredEvent,
} from './NativeBLETimingModule';

export type { RFAdaptationState };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClockSyncInfo = {
  /** master_minus_slave offset in nanoseconds as BigInt. Positive = master ahead. */
  offsetNs: bigint;
  /** Round-trip time in nanoseconds as BigInt. Null until first sync. */
  rttNs: bigint | null;
  /** Number of valid samples in the rolling median window (max 7). */
  sampleCount: number;
  /** True iff offset magnitude is within ±1.44ms (kMaxDriftNs). */
  isSynced: boolean;
};

export type PerDeviceRFState = {
  address: string;
  state: RFAdaptationState;
  smoothedRssi: number | null;
  lastUpdatedAt: number; // Date.now() ms — for staleness detection
};

export type UseRFAdaptationReturn = {
  /**
   * True when the native layer has triggered fallback due to irrecoverable
   * signal loss or clock desync. When true, show manual entry UI immediately.
   * False after resetFallback() is called and native confirms recovery.
   */
  isFallbackActive: boolean;

  /** Reason for the most recent fallback trigger. Null if no fallback yet. */
  fallbackReason: FallbackRequiredEvent['reason'] | null;

  /**
   * RF adaptation state for each connected peripheral, keyed by address.
   * Use the address from onDeviceConnected events to look up a specific device.
   * Most combine setups have a single timing chip — use worstState for simplicity.
   */
  deviceStates: Map<string, PerDeviceRFState>;

  /**
   * The most degraded RF state across all connected devices.
   * Drives UI indicators: green=Normal, amber=Degrading/PHYCoded, red=Critical/Fallback.
   */
  worstState: RFAdaptationState;

  /** Latest clock synchronisation info. Null until the first sync completes. */
  clockSync: ClockSyncInfo | null;

  /**
   * Reset fallback state and re-enable BLE timing path.
   * Only call after operator visually confirms signal quality is acceptable.
   * This triggers a native reset, which emits onFallbackCleared on success.
   */
  resetFallback: () => void;
};

// ---------------------------------------------------------------------------
// State + reducer
// ---------------------------------------------------------------------------

type RFState = {
  isFallbackActive: boolean;
  fallbackReason: FallbackRequiredEvent['reason'] | null;
  deviceStates: Map<string, PerDeviceRFState>;
  clockSync: ClockSyncInfo | null;
};

type RFAction =
  | { type: 'RSSI_UPDATE';     payload: RSSIUpdateEvent }
  | { type: 'RF_ADAPTATION';   payload: RFAdaptationEvent }
  | { type: 'CLOCK_SYNC';      payload: ClockSyncUpdateEvent }
  | { type: 'FALLBACK_REQ';    payload: FallbackRequiredEvent }
  | { type: 'FALLBACK_CLEAR' };

const RF_STATE_ORDER: RFAdaptationState[] = [
  'Normal',
  'Degrading',
  'PHYDowngrading',
  'PHYCoded',
  'CriticalSignal',
  'FallbackActive',
];

function rfStateOrdinal(s: RFAdaptationState): number {
  return RF_STATE_ORDER.indexOf(s);
}

function computeWorstState(devices: Map<string, PerDeviceRFState>): RFAdaptationState {
  let worst: RFAdaptationState = 'Normal';
  for (const d of devices.values()) {
    if (rfStateOrdinal(d.state) > rfStateOrdinal(worst)) {
      worst = d.state;
    }
  }
  return worst;
}

function rfReducer(state: RFState, action: RFAction): RFState {
  switch (action.type) {

    case 'RSSI_UPDATE': {
      const { address, smoothedRssi } = action.payload;
      const existing = state.deviceStates.get(address);
      const updated  = new Map(state.deviceStates);
      updated.set(address, {
        address,
        state: existing?.state ?? 'Normal',
        smoothedRssi,
        lastUpdatedAt: Date.now(),
      });
      return { ...state, deviceStates: updated };
    }

    case 'RF_ADAPTATION': {
      const { address, state: newRFState } = action.payload;
      const existing = state.deviceStates.get(address);
      const updated  = new Map(state.deviceStates);
      updated.set(address, {
        address,
        state: newRFState,
        smoothedRssi: existing?.smoothedRssi ?? null,
        lastUpdatedAt: Date.now(),
      });
      return { ...state, deviceStates: updated };
    }

    case 'CLOCK_SYNC': {
      const p = action.payload;
      const clockSync: ClockSyncInfo = {
        offsetNs:    BigInt(p.offsetNs),
        rttNs:       p.rttNs != null ? BigInt(p.rttNs) : null,
        sampleCount: p.sampleCount,
        isSynced:    p.isSynced,
      };
      return { ...state, clockSync };
    }

    case 'FALLBACK_REQ':
      return {
        ...state,
        isFallbackActive: true,
        fallbackReason: action.payload.reason,
      };

    case 'FALLBACK_CLEAR':
      return {
        ...state,
        isFallbackActive: false,
        fallbackReason:   null,
        // Reset all device RF states to Normal on recovery
        deviceStates: new Map(
          Array.from(state.deviceStates.entries()).map(([addr, d]) => [
            addr,
            { ...d, state: 'Normal' as RFAdaptationState },
          ])
        ),
      };

    default:
      return state;
  }
}

const initialState: RFState = {
  isFallbackActive: false,
  fallbackReason:   null,
  deviceStates:     new Map(),
  clockSync:        null,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRFAdaptation(): UseRFAdaptationReturn {
  const [state, dispatch] = useReducer(rfReducer, initialState);
  const emitterRef = useRef<NativeEventEmitter | null>(null);

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeBLETimingModule as any);
    emitterRef.current = emitter;

    const subs = [
      emitter.addListener('onRSSIUpdate', (e: RSSIUpdateEvent) => {
        dispatch({ type: 'RSSI_UPDATE', payload: e });
      }),
      emitter.addListener('onRFAdaptation', (e: RFAdaptationEvent) => {
        dispatch({ type: 'RF_ADAPTATION', payload: e });
      }),
      emitter.addListener('onClockSyncUpdate', (e: ClockSyncUpdateEvent) => {
        dispatch({ type: 'CLOCK_SYNC', payload: e });
      }),
      emitter.addListener('onSignalDegraded', (_e: SignalDegradedEvent) => {
        // onRFAdaptation with state=Degrading fires immediately after —
        // onSignalDegraded is informational only (drives log / analytics).
        // No state update needed here; the RF_ADAPTATION action handles it.
      }),
      emitter.addListener('onFallbackRequired', (e: FallbackRequiredEvent) => {
        dispatch({ type: 'FALLBACK_REQ', payload: e });
      }),
      emitter.addListener('onFallbackCleared', () => {
        dispatch({ type: 'FALLBACK_CLEAR' });
      }),
    ];

    // Register listener count with native module
    NativeBLETimingModule.addListener('onRSSIUpdate');
    NativeBLETimingModule.addListener('onRFAdaptation');
    NativeBLETimingModule.addListener('onClockSyncUpdate');
    NativeBLETimingModule.addListener('onSignalDegraded');
    NativeBLETimingModule.addListener('onFallbackRequired');
    NativeBLETimingModule.addListener('onFallbackCleared');

    return () => {
      subs.forEach(s => s.remove());
      NativeBLETimingModule.removeListeners(6);
    };
  }, []);

  const resetFallback = useCallback(() => {
    NativeBLETimingModule.resetFallback();
    // Optimistic local clear — native confirms with onFallbackCleared event.
    // If native rejects (e.g. signal still too weak), onFallbackRequired fires again.
  }, []);

  const worstState = computeWorstState(state.deviceStates);

  return {
    isFallbackActive: state.isFallbackActive,
    fallbackReason:   state.fallbackReason,
    deviceStates:     state.deviceStates,
    worstState,
    clockSync:        state.clockSync,
    resetFallback,
  };
}
