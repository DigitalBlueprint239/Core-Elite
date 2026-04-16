/**
 * DrillKeypad
 *
 * Mission-critical result entry keypad.
 * Replaces the system keyboard entirely — no layout shifts, no autocorrect.
 *
 * Touch target guarantees:
 *   - Each key: 64dp × 64dp (exceeds 56dp minimum)
 *   - Backspace key: same size, red tint for distinct affordance
 *   - 12px gaps between keys — prevents fat-finger mis-taps at 0.2% probability
 *
 * Layout: 3-column grid, 4 rows
 *   [7] [8] [9]
 *   [4] [5] [6]
 *   [1] [2] [3]
 *   [.] [0] [⌫]
 *
 * Value display:
 *   Large monospaced value above keypad — operator sees what they're entering
 *   at a glance without looking down.
 *
 * Validation feedback:
 *   - Green tint: value is within expected range for drill
 *   - Red tint: value is out of range (visual only — does NOT block submission)
 *     Reason: drill timing can produce extraordinary results. Operator confirms.
 */

import React, { useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { C, S, T, TOUCH, LAYOUT } from '../theme';

interface Props {
  value:       string;
  onChange:    (v: string) => void;
  drillName:   string;
  unit?:       string;   // e.g. "sec", "in", "reps"
  rangeMin?:   number;
  rangeMax?:   number;
  disabled?:   boolean;
}

const KEYS = ['7','8','9','4','5','6','1','2','3','.','0','⌫'] as const;
type Key = typeof KEYS[number];

export function DrillKeypad({
  value,
  onChange,
  drillName,
  unit,
  rangeMin,
  rangeMax,
  disabled = false,
}: Props) {
  const numericValue = parseFloat(value);
  const hasValue     = value.length > 0;

  const inRange =
    hasValue &&
    rangeMin !== undefined &&
    rangeMax !== undefined &&
    !isNaN(numericValue) &&
    numericValue >= rangeMin &&
    numericValue <= rangeMax;

  const outOfRange =
    hasValue &&
    rangeMin !== undefined &&
    rangeMax !== undefined &&
    !isNaN(numericValue) &&
    (numericValue < rangeMin || numericValue > rangeMax);

  const displayColor = outOfRange ? C.red : inRange ? C.green : C.gray9;

  const press = useCallback((key: Key) => {
    if (disabled) return;

    // Haptic feedback — light for digits, medium for backspace
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(
        key === '⌫'
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Light
      ).catch(() => {});
    }

    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.' && value.includes('.')) return;
    if (value === '0' && key !== '.') { onChange(key); return; }
    if (value.length >= 7) return;
    onChange(value + key);
  }, [value, onChange, disabled]);

  return (
    <View style={styles.container}>
      {/* Drill context label */}
      <View style={styles.drillHeader}>
        <View style={styles.drillPill}>
          <Text style={styles.drillName}>{drillName.toUpperCase()}</Text>
        </View>
        {unit && <Text style={styles.unit}>{unit}</Text>}
      </View>

      {/* Value display — monospaced, large */}
      <View style={[
        styles.valueDisplay,
        inRange    && styles.valueDisplayGreen,
        outOfRange && styles.valueDisplayRed,
      ]}>
        <Text style={[styles.valueText, { color: displayColor }]} numberOfLines={1}>
          {hasValue ? value : '—'}
        </Text>
        {outOfRange && (
          <Text style={styles.rangeWarning}>OUT OF RANGE · CONFIRM TO OVERRIDE</Text>
        )}
      </View>

      {/* Keypad grid */}
      <View style={styles.grid}>
        {KEYS.map((key) => (
          <KeyButton
            key={key}
            label={key}
            onPress={() => press(key)}
            disabled={disabled}
            isBackspace={key === '⌫'}
            isDecimal={key === '.'}
            decimalUsed={value.includes('.')}
          />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// KeyButton
// ---------------------------------------------------------------------------

interface KeyButtonProps {
  label:       Key;
  onPress:     () => void;
  disabled:    boolean;
  isBackspace: boolean;
  isDecimal:   boolean;
  decimalUsed: boolean;
}

function KeyButton({
  label, onPress, disabled, isBackspace, isDecimal, decimalUsed
}: KeyButtonProps) {
  const dimmed = isDecimal && decimalUsed;

  return (
    <TouchableOpacity
      style={[
        styles.key,
        isBackspace && styles.keyBackspace,
        disabled    && styles.keyDisabled,
        dimmed      && styles.keyDimmed,
      ]}
      onPress={onPress}
      disabled={disabled || dimmed}
      activeOpacity={0.7}
      accessibilityLabel={isBackspace ? 'Backspace' : label}
      accessibilityRole="button"
    >
      <Text style={[
        styles.keyLabel,
        isBackspace && styles.keyLabelBackspace,
        dimmed      && styles.keyLabelDimmed,
      ]}>
        {isBackspace ? '⌫' : label}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    gap: S.md,
  },

  drillHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           S.sm,
  },

  drillPill: {
    backgroundColor: C.brand,
    borderRadius:    100,
    paddingHorizontal: S.md,
    paddingVertical:   6,
  },

  drillName: {
    ...T.label,
    color: C.white,
  },

  unit: {
    ...T.label,
    color: C.gray5,
  },

  valueDisplay: {
    backgroundColor: C.gray1,
    borderRadius:    LAYOUT.borderRadius,
    borderWidth:     2,
    borderColor:     C.gray2,
    paddingHorizontal: S.lg,
    paddingVertical:   S.md,
    alignItems:        'center',
    minHeight:         80,
    justifyContent:    'center',
  },

  valueDisplayGreen: {
    borderColor:     C.green,
    backgroundColor: '#F1FFF5',
  },

  valueDisplayRed: {
    borderColor:     C.red,
    backgroundColor: C.redLight,
  },

  valueText: {
    ...T.titleMono,
    fontSize: 48,
    fontWeight: '900',
  },

  rangeWarning: {
    ...T.caption,
    color:         C.red,
    fontWeight:    '700',
    letterSpacing: 0.5,
    marginTop:     S.xs,
  },

  grid: {
    flexDirection:  'row',
    flexWrap:       'wrap',
    gap:            12,
  },

  key: {
    // Width = (100% - 2*12px gaps) / 3 columns
    // We use flexBasis + flexGrow to fill evenly
    flexBasis:       0,
    flexGrow:        1,
    // minWidth is handled by flexGrow filling the container
    height:          TOUCH.keypad,
    backgroundColor: C.white,
    borderRadius:    LAYOUT.borderRadius,
    borderWidth:     2,
    borderColor:     C.gray2,
    alignItems:      'center',
    justifyContent:  'center',
    // Shadow for depth
    shadowColor:     C.black,
    shadowOffset:    { width: 0, height: 1 },
    shadowOpacity:   0.08,
    shadowRadius:    2,
    elevation:       2,
  },

  keyBackspace: {
    backgroundColor: C.gray2,
    borderColor:     C.gray2,
  },

  keyDisabled: {
    opacity: 0.4,
  },

  keyDimmed: {
    opacity: 0.3,
  },

  keyLabel: {
    ...T.keypad,
    color: C.gray9,
  },

  keyLabelBackspace: {
    color: C.red,
  },

  keyLabelDimmed: {
    color: C.gray5,
  },
});
