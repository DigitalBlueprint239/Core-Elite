/**
 * ScannerMode.tsx
 * Core Elite — Mission Y: QR Identity Matrix (operator-side)
 *
 * Full-screen react-native-vision-camera scanner. Lives alongside
 * AthleteQRCard in the production RN component set. Imports from
 * `react-native` and `react-native-vision-camera`, neither of which is
 * resolved by `tsconfig.mobile.json` — Metro/Expo picks it up at app
 * build time. All non-UI logic (parse, cache lookup, sink dispatch)
 * goes through `armFromScan` from ../mobile/qrIdentity.ts so the
 * critical pipeline stays unit-tested in vitest.
 *
 * Operator UX targets:
 *   - Lock-in time (QR enters frame → arm complete) ≤ 250ms steady-state.
 *   - One audible/haptic confirmation per arm — no chatter on duplicate
 *     scans of the same code (debounced 1.5s).
 *   - Failure modes (rogue QR, unknown athlete) flash but do NOT arm.
 *   - Currently-armed athlete card stays visible after a successful
 *     arm so the operator can verify before triggering the laser trip.
 *
 * Permission handling:
 *   On first mount we request camera permission. If denied, we render
 *   a recoverable instruction screen rather than a blank black canvas.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  Vibration,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
  type Code,
} from 'react-native-vision-camera';

import {
  armFromScan,
  ScanDebouncer,
  type AthleteCache,
  type ArmedAthleteSink,
  type ArmedAthlete,
  type ArmFailureReason,
} from '../mobile/qrIdentity';
import { C, S, T, TOUCH } from '../theme';

export interface ScannerModeProps {
  /** Adapter over the local PowerSync/SQLite cache. Required. */
  cache: AthleteCache;

  /** Where successful arms go — host wires this to active_session_id state. */
  sink:  ArmedAthleteSink;

  /** Optional — fires after every arm attempt (success or failure). */
  onResult?: (result:
    | { ok: true;  athlete: ArmedAthlete }
    | { ok: false; reason: ArmFailureReason; raw: string },
  ) => void;

  /** Optional — operator close button. Host hides the screen. */
  onClose?: () => void;

  /** Override the debounce window (ms). Default 1.5s. */
  debounceMs?: number;
}

const FAILURE_BLURBS: Record<ArmFailureReason, string> = {
  empty:         'Empty scan — hold the code steady.',
  wrong_prefix:  'Not a Core Elite code.',
  not_uuid:      'Code is not a valid athlete identifier.',
  not_in_cache:  'Athlete not registered for this event.',
};

export function ScannerMode({
  cache,
  sink,
  onResult,
  onClose,
  debounceMs,
}: ScannerModeProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  // useState for currently-armed display + last-failure flash. Keep these
  // separate so a flash failure doesn't blow away the previous good arm.
  const [armed, setArmed] = useState<ArmedAthlete | null>(null);
  const [flash, setFlash] = useState<{ reason: ArmFailureReason; ts: number } | null>(null);
  const [busy,  setBusy]  = useState(false);

  // Debouncer is stable for the lifetime of the screen. The codeScanner
  // callback fires dozens of times per second while the QR is in frame.
  const debouncer = useMemo(() => new ScanDebouncer({ windowMs: debounceMs }), [debounceMs]);

  // Stash refs for inside-callback access — useCodeScanner closes over
  // them once and the closure must see live cache/sink after any prop
  // identity change.
  const cacheRef = useRef(cache);
  const sinkRef  = useRef(sink);
  useEffect(() => { cacheRef.current = cache; }, [cache]);
  useEffect(() => { sinkRef.current  = sink;  }, [sink]);

  // Auto-clear the failure flash after 2s — successful arms persist
  // until the next arm.
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(id);
  }, [flash]);

  // First-mount permission request. Vision Camera's hook returns a stable
  // requestPermission so we can call it inside an effect without churn.
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  const handleCode = useCallback(
    async (raw: string) => {
      if (!debouncer.shouldProcess(raw)) return;
      setBusy(true);
      try {
        const result = await armFromScan(raw, cacheRef.current, sinkRef.current);
        if (result.ok) {
          setArmed(result.athlete);
          setFlash(null);
          Vibration.vibrate(40);    // single short tick = success
          onResult?.(result);
        } else {
          setFlash({ reason: result.reason, ts: Date.now() });
          Vibration.vibrate([0, 60, 60, 60]); // double-pulse = error
          onResult?.(result);
        }
      } finally {
        setBusy(false);
      }
    },
    [debouncer, onResult],
  );

  // Vision Camera's QR code scanner. The library hands us an array of
  // codes per frame — we only care about the first one with a non-empty
  // value (multi-QR frames are rare and ambiguous).
  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes: Code[]) => {
      const value = codes.find((c) => typeof c.value === 'string' && c.value.length > 0)?.value;
      if (value) void handleCode(value);
    },
  });

  // ─── Render branches ────────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <View style={styles.fullscreen}>
        <View style={styles.permissionCard}>
          <Text style={styles.permissionTitle}>CAMERA PERMISSION REQUIRED</Text>
          <Text style={styles.permissionBody}>
            ScannerMode needs the camera to read athlete QR codes. Tap below to grant it.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [styles.permissionButton, pressed && styles.permissionButtonPressed]}
          >
            <Text style={styles.permissionButtonText}>GRANT CAMERA ACCESS</Text>
          </Pressable>
          {onClose && (
            <Pressable onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>CANCEL</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.fullscreen}>
        <ActivityIndicator color={C.amber} size="large" />
        <Text style={styles.deviceMissingText}>NO CAMERA DEVICE FOUND</Text>
      </View>
    );
  }

  return (
    <View style={styles.fullscreen}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        codeScanner={codeScanner}
      />

      {/* Reticle overlay — centred crosshair the operator aligns the QR with.
          The vision-camera bounding-box would be more precise but we want a
          single eye-target during fast back-to-back arming, not data UI. */}
      <View pointerEvents="none" style={styles.reticleWrap}>
        <View style={styles.reticleBox}>
          <View style={[styles.reticleCorner, styles.reticleCornerTL]} />
          <View style={[styles.reticleCorner, styles.reticleCornerTR]} />
          <View style={[styles.reticleCorner, styles.reticleCornerBL]} />
          <View style={[styles.reticleCorner, styles.reticleCornerBR]} />
        </View>
        <Text style={styles.reticleHint}>SCAN ATHLETE QR</Text>
      </View>

      {/* Currently-armed banner. Persists across scans so the operator can
          glance up from the laser gate to confirm the right name is locked. */}
      {armed && (
        <View style={styles.armedBanner} testID="scanner-armed-banner">
          <Text style={styles.armedLabel}>ARMED</Text>
          <Text style={styles.armedName} numberOfLines={1} adjustsFontSizeToFit>
            {armed.first_name} {armed.last_name}
          </Text>
          <View style={styles.armedMetaRow}>
            {armed.position && <Text style={styles.armedMeta}>{armed.position}</Text>}
            {armed.band_number != null && (
              <Text style={styles.armedMeta}>· #{armed.band_number}</Text>
            )}
          </View>
        </View>
      )}

      {/* Failure flash — never overlaps an armed banner because errors don't
          replace prior good arms. Auto-clears in 2s. */}
      {flash && (
        <View style={styles.flashBanner} testID="scanner-flash-banner">
          <Text style={styles.flashTitle}>SCAN REJECTED</Text>
          <Text style={styles.flashBody}>{FAILURE_BLURBS[flash.reason]}</Text>
        </View>
      )}

      {/* Operator close button — fixed to the top-right safe area. */}
      {onClose && (
        <Pressable onPress={onClose} style={styles.closeFloating}>
          <Text style={styles.closeButtonText}>CLOSE</Text>
        </Pressable>
      )}

      {/* Subtle activity indicator while a cache lookup is in flight. */}
      {busy && (
        <View pointerEvents="none" style={styles.busyDot}>
          <ActivityIndicator color={C.amber} />
        </View>
      )}
    </View>
  );
}

const RETICLE = 240;
const RETICLE_CORNER = 28;

const styles = StyleSheet.create({
  fullscreen: {
    flex:           1,
    backgroundColor: C.black,
    alignItems:     'center',
    justifyContent: 'center',
  },
  reticleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            S.md,
  },
  reticleBox: {
    width:  RETICLE,
    height: RETICLE,
  },
  reticleCorner: {
    position:       'absolute',
    width:          RETICLE_CORNER,
    height:         RETICLE_CORNER,
    borderColor:    C.amber,
  },
  reticleCornerTL: { top: 0, left: 0,  borderLeftWidth: 4, borderTopWidth: 4 },
  reticleCornerTR: { top: 0, right: 0, borderRightWidth: 4, borderTopWidth: 4 },
  reticleCornerBL: { bottom: 0, left: 0,  borderLeftWidth: 4, borderBottomWidth: 4 },
  reticleCornerBR: { bottom: 0, right: 0, borderRightWidth: 4, borderBottomWidth: 4 },
  reticleHint: {
    ...T.label,
    color:           C.white,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: S.md,
    paddingVertical:   S.xs,
    borderRadius:     S.xs,
    letterSpacing:   3,
  },
  armedBanner: {
    position:        'absolute',
    bottom:          S.xl,
    left:            S.md,
    right:           S.md,
    backgroundColor: C.green,
    borderRadius:    S.md,
    padding:         S.md,
    gap:             S.xs,
    minHeight:       TOUCH.primary,
  },
  armedLabel: {
    ...T.label,
    color: C.black,
    letterSpacing: 3,
  },
  armedName: {
    ...T.hero,
    color: C.black,
  },
  armedMetaRow: {
    flexDirection: 'row',
    gap:           S.xs,
  },
  armedMeta: {
    ...T.body,
    color: C.black,
    fontWeight: '700',
  },
  flashBanner: {
    position:        'absolute',
    top:             S.xl,
    left:            S.md,
    right:           S.md,
    backgroundColor: C.red,
    borderRadius:    S.md,
    padding:         S.md,
    gap:             S.xs,
  },
  flashTitle: {
    ...T.label,
    color: C.white,
    letterSpacing: 3,
  },
  flashBody: {
    ...T.body,
    color: C.white,
    fontWeight: '700',
  },
  closeFloating: {
    position:           'absolute',
    top:                S.xl,
    right:              S.md,
    paddingVertical:    S.sm,
    paddingHorizontal:  S.md,
    backgroundColor:    'rgba(0,0,0,0.6)',
    borderRadius:       S.sm,
  },
  closeButton: {
    paddingVertical:   S.sm,
    paddingHorizontal: S.md,
  },
  closeButtonText: {
    ...T.label,
    color: C.white,
    letterSpacing: 3,
  },
  busyDot: {
    position: 'absolute',
    top:      S.xl + S.xl,
    alignSelf: 'center',
  },
  permissionCard: {
    marginHorizontal: S.lg,
    padding:          S.xl,
    backgroundColor:  C.brand,
    borderRadius:     S.lg,
    gap:              S.md,
    alignItems:       'center',
  },
  permissionTitle: {
    ...T.title,
    color:    C.amber,
    textAlign: 'center',
    letterSpacing: 2,
  },
  permissionBody: {
    ...T.body,
    color:    C.gray2,
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor:   C.amber,
    paddingVertical:   S.md,
    paddingHorizontal: S.lg,
    borderRadius:      S.sm,
    minHeight:         TOUCH.primary,
    alignItems:        'center',
    justifyContent:    'center',
  },
  permissionButtonPressed: {
    backgroundColor: C.amberDark,
  },
  permissionButtonText: {
    ...T.button,
    color: C.black,
  },
  deviceMissingText: {
    ...T.label,
    color:     C.amber,
    marginTop: S.lg,
    letterSpacing: 3,
  },
});
