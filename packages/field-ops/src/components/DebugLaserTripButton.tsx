/**
 * DebugLaserTripButton.tsx
 * Core Elite — Mission W: UI test harness
 *
 * A massive, high-contrast React Native Pressable wired to the Dashr mock
 * sentinel. Lives in the field-ops component set (alongside AthleteCard,
 * DrillKeypad, etc.) and is intentionally **not** included in the
 * `tsconfig.mobile.json` compile graph — it imports from 'react-native',
 * which isn't installed on the framework-agnostic verifier. The Metro /
 * Expo build picks it up through its own module resolution.
 *
 * Wiring (at the app-shell level):
 *
 *   const listener = initializeBLEListener();
 *   startLaserTripPipeline({ listener, hlc, sink });   // HLC + outbox
 *   <DebugLaserTripButton listener={listener} />       // fires sentinel
 *
 * When the button is tapped, `simulateDashrTrip(listener)` pushes
 * MOCK_DASHR_TRIP_HEX into the raw-bytes pipeline. The existing
 * subscription inside startLaserTripPipeline catches it and runs the
 * full HLC → outbox flow. No direct outbox writes from the button.
 *
 * Design targets (matches `theme.ts` engineering constraints):
 *   - Contrast: amber (#FFB800) on black, 9:1  (sunlight-visible)
 *   - Height: 2× TOUCH.primary (144dp) — the button is `massive` per spec
 *   - Label: `T.hero` (40sp, 900 weight) for arm's-length visibility
 *   - Shows a tiny `✓ DASHR TRIP FIRED` micro-confirmation after tap,
 *     automatically clears after 1s so the harness can fire repeatedly.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { simulateDashrTrip } from '../mobile/debugTrip';
import type { MockBLEListener, PushRawHexResult } from '@core-elite/native-ble/src/stub';
import { MOCK_DASHR_TRIP_HEX } from '@core-elite/native-ble/src/stub';
import { C, S, T, TOUCH } from '../theme';

export interface DebugLaserTripButtonProps {
  listener: MockBLEListener;
  /**
   * Optional callback fired after every push — useful for tying a screen-
   * level toast / haptic to the same event that flows through the outbox.
   * Purely cosmetic; the HLC + outbox path runs regardless.
   */
  onTrip?: (result: PushRawHexResult) => void;
}

const FLASH_MS = 1000;

export function DebugLaserTripButton({ listener, onTrip }: DebugLaserTripButtonProps) {
  const [flashing, setFlashing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel pending timers on unmount — the screen can dismount while a
  // flash is still scheduled (e.g. operator navigates away).
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handlePress = useCallback(() => {
    const result = simulateDashrTrip(listener);
    onTrip?.(result);

    if (timerRef.current) clearTimeout(timerRef.current);
    setFlashing(true);
    timerRef.current = setTimeout(() => setFlashing(false), FLASH_MS);
  }, [listener, onTrip]);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Simulate Dashr laser trip"
        testID="debug-laser-trip-button"
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text style={styles.label}>[ SIMULATE DASHR LASER TRIP ]</Text>
        <Text style={styles.sentinel}>hex = {MOCK_DASHR_TRIP_HEX}</Text>
      </Pressable>

      {flashing && (
        <View style={styles.flash} accessibilityLiveRegion="polite">
          <Text style={styles.flashText}>✓ DASHR TRIP FIRED</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: S.md,
    gap:     S.sm,
  },
  button: {
    minHeight:       TOUCH.primary * 2,          // 144dp — "massive"
    backgroundColor: C.amber,
    borderColor:     C.black,
    borderWidth:     4,
    borderRadius:    S.md,
    paddingVertical: S.xl,
    paddingHorizontal: S.lg,
    alignItems:      'center',
    justifyContent:  'center',
  },
  buttonPressed: {
    backgroundColor: C.amberDark,
    transform:       [{ scale: 0.98 }],
  },
  label: {
    ...T.hero,
    color:       C.black,
    textAlign:   'center',
  },
  sentinel: {
    ...T.label,
    color:       C.gray9,
    marginTop:   S.sm,
    fontVariant: ['tabular-nums'] as any,
  },
  flash: {
    backgroundColor: C.green,
    borderRadius:    S.sm,
    paddingVertical: S.sm,
    paddingHorizontal: S.md,
    alignSelf:       'center',
  },
  flashText: {
    ...T.button,
    color: C.black,
  },
});
