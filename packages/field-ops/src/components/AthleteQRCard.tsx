/**
 * AthleteQRCard.tsx
 * Core Elite — Mission Y: QR Identity Matrix (athlete-side)
 *
 * The check-in code an athlete shows the operator. Massive, high-contrast,
 * arm's-length-readable under direct Florida sun. Not a marketing surface
 * — a working machine-readable label.
 *
 * Component lives alongside DebugLaserTripButton (Mission W) in the
 * production RN component set. It imports from `react-native`,
 * `react-native-qrcode-svg`, and `react-native-svg`, none of which are
 * resolved by `tsconfig.mobile.json` — Metro/Expo picks it up at app
 * build time. The framework-agnostic core (`encodeAthleteQRPayload`,
 * `parseAthleteQR`) lives in ../mobile/qrIdentity.ts so the encoding
 * stays unit-tested in vitest.
 *
 * Engineering targets (matches `theme.ts`):
 *   - QR module: 16dp per cell, 256dp QR side at minimum
 *   - Background: pure white (#FFFFFF) — required for camera contrast
 *   - Border: 8dp pure black, with an animated amber pulse layer
 *     between border and QR matrix (operator's eye lock target)
 *   - Athlete name printed under the QR at hero size — backup if a
 *     scanner is failing (the operator can manually type the band)
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { encodeAthleteQRPayload } from '../mobile/qrIdentity';
import { C, S, T } from '../theme';

export interface AthleteQRCardProps {
  /** Supabase auth.users UUID for this athlete. */
  athleteId: string;
  /** Display name shown beneath the QR (backup ID, never injected into QR). */
  displayName: string;
  /** Optional — band number rendered as a corner pill for fallback typing. */
  bandNumber?: number | null;
  /** Edge length of the QR matrix in dp. Default 280 — fills most of an iPad mini. */
  qrSize?: number;
  /** Optional override of the encoded payload — useful for diagnostics. */
  rawValue?: string;
}

const DEFAULT_QR_SIZE = 280;
const PULSE_DURATION_MS = 1600;

export function AthleteQRCard({
  athleteId,
  displayName,
  bandNumber,
  qrSize = DEFAULT_QR_SIZE,
  rawValue,
}: AthleteQRCardProps) {
  // Encode once per athleteId — useMemo guards against extra QR re-renders
  // from parent state churn. encodeAthleteQRPayload throws on a non-UUID
  // input; we catch and render a fallback rather than crashing the screen.
  const { value, encodeError } = useMemo(() => {
    if (rawValue) return { value: rawValue, encodeError: null as string | null };
    try {
      return { value: encodeAthleteQRPayload(athleteId), encodeError: null };
    } catch (err) {
      return { value: '', encodeError: (err as Error).message };
    }
  }, [athleteId, rawValue]);

  // Pulse animation — drives the border colour + scale. We use Animated
  // (not Reanimated) so this works without the worklets runtime, which
  // matters when the camera screen mounts above us and Reanimated is
  // already busy on its own UI thread.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: PULSE_DURATION_MS / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: PULSE_DURATION_MS / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const pulseColor   = pulse.interpolate({ inputRange: [0, 1], outputRange: [C.black, C.amber] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] });

  if (encodeError) {
    return (
      <View style={[styles.wrap, styles.errorWrap]}>
        <Text style={styles.errorTitle}>QR ENCODE FAILED</Text>
        <Text style={styles.errorBody}>{encodeError}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {/* Brand header — operator visually confirms this is a Core Elite QR
          before scanning, defending against rogue lookalikes. */}
      <View style={styles.brandRow}>
        <View style={styles.brandDot} />
        <Text style={styles.brandText}>[ CORE ELITE ]</Text>
        <View style={styles.brandDot} />
      </View>

      {/* QR + animated pulse border. Background is forced pure white — the
          QR cell decoder needs the absolute brightest white available. */}
      <Animated.View
        style={[
          styles.qrFrame,
          {
            borderColor: pulseColor,
            opacity:     pulseOpacity,
            width:       qrSize + S.lg * 2,
            height:      qrSize + S.lg * 2,
          },
        ]}
      >
        <View style={styles.qrInner}>
          <QRCode
            value={value}
            size={qrSize}
            backgroundColor={C.white}
            color={C.black}
            ecl="H"
            testID="athlete-qr-code"
          />
        </View>
      </Animated.View>

      {/* Identity readout — backup channel if scanning fails for any reason. */}
      <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit>
        {displayName.toUpperCase()}
      </Text>

      {bandNumber != null && (
        <View style={styles.bandPill}>
          <Text style={styles.bandLabel}>BAND</Text>
          <Text style={styles.bandValue}>{bandNumber}</Text>
        </View>
      )}

      <Text style={styles.scanHint}>HOLD STEADY · 12 IN FROM SCANNER</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: C.brand,
    borderRadius:    S.lg,
    paddingVertical: S.xl,
    paddingHorizontal: S.lg,
    alignItems:      'center',
    gap:             S.lg,
  },
  brandRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            S.sm,
  },
  brandDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: C.amber,
  },
  brandText: {
    ...T.label,
    color: C.amber,
    letterSpacing: 4,
  },
  qrFrame: {
    borderWidth:    8,
    borderRadius:   S.md,
    alignItems:     'center',
    justifyContent: 'center',
    backgroundColor: C.white,
  },
  qrInner: {
    backgroundColor: C.white,
    padding:         S.md,
    borderRadius:    S.sm,
  },
  name: {
    ...T.hero,
    color:         C.white,
    textAlign:     'center',
    paddingHorizontal: S.md,
  },
  bandPill: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              S.sm,
    paddingVertical:   S.sm,
    paddingHorizontal: S.md,
    backgroundColor:  C.amber,
    borderRadius:     S.sm,
  },
  bandLabel: {
    ...T.label,
    color: C.black,
  },
  bandValue: {
    ...T.titleMono,
    color: C.black,
  },
  scanHint: {
    ...T.label,
    color: C.gray5,
  },
  errorWrap: {
    backgroundColor: C.red,
  },
  errorTitle: {
    ...T.title,
    color: C.white,
  },
  errorBody: {
    ...T.caption,
    color: C.redLight,
    textAlign: 'center',
  },
});
