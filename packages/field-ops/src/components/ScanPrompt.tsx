/**
 * ScanPrompt
 *
 * Idle state — full-screen visual prompt to scan athlete QR.
 * Zero cognitive load: one instruction, one action.
 *
 * Design:
 *   - Dark background: high sunlight contrast
 *   - Single large icon + one-line instruction
 *   - Scan button: full-width, 72dp height (primary touch target)
 *   - Last result shown if available: "Last: Smith #42 · 4.87 sec"
 *     Gives operator confidence previous submission landed.
 */

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { C, S, T, TOUCH, LAYOUT } from '../theme';
import { Result } from '../../../../src/lib/types';

interface Props {
  stationName: string;
  lastResult:  Result | null;
  onScanPress: () => void;
  drillUnit?:  string;
}

export function ScanPrompt({ stationName, lastResult, onScanPress, drillUnit }: Props) {
  const handleScan = () => {
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    onScanPress();
  };

  return (
    <View style={styles.container}>
      {/* Station context */}
      <View style={styles.stationRow}>
        <Text style={styles.stationLabel}>STATION</Text>
        <Text style={styles.stationName}>{stationName.toUpperCase()}</Text>
      </View>

      {/* Central prompt */}
      <View style={styles.promptBlock}>
        <Text style={styles.qrIcon}>⬛</Text>
        <Text style={styles.promptTitle}>SCAN ATHLETE</Text>
        <Text style={styles.promptSub}>Point camera at wristband QR code</Text>
      </View>

      {/* Last result — social proof / confirmation previous succeeded */}
      {lastResult && (
        <View style={styles.lastResultBlock}>
          <Text style={styles.lastResultLabel}>LAST CAPTURED</Text>
          <Text style={styles.lastResultValue}>
            {lastResult.value_num.toFixed(2)}{drillUnit ? ` ${drillUnit}` : ''}
          </Text>
        </View>
      )}

      {/* Scan button — in thumb zone, full width */}
      <TouchableOpacity
        style={styles.scanButton}
        onPress={handleScan}
        activeOpacity={0.85}
        accessibilityLabel="Scan athlete wristband"
        accessibilityRole="button"
        accessibilityHint="Opens camera to scan QR code on athlete's wristband"
      >
        <Text style={styles.scanButtonIcon}>📷</Text>
        <Text style={styles.scanButtonText}>SCAN WRISTBAND</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex:             1,
    backgroundColor:  C.brand,
    paddingHorizontal: S.lg,
    paddingTop:        S.xl,
    paddingBottom:     S.xl,
    justifyContent:   'space-between',
  },

  stationRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           S.sm,
  },

  stationLabel: {
    ...T.label,
    color: C.gray5,
  },

  stationName: {
    ...T.title,
    color: C.white,
  },

  promptBlock: {
    flex:           1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            S.md,
  },

  qrIcon: {
    fontSize: 80,
    // The actual QR scan icon — in production replace with a proper SVG
  },

  promptTitle: {
    fontSize:      48,
    fontWeight:    '900',
    color:         C.white,
    letterSpacing: -1,
    textAlign:     'center',
  },

  promptSub: {
    ...T.body,
    color:     '#AAAACC',
    textAlign: 'center',
  },

  lastResultBlock: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius:    LAYOUT.borderRadius,
    paddingHorizontal: S.lg,
    paddingVertical:   S.md,
    alignItems:        'center',
    marginBottom:      S.md,
  },

  lastResultLabel: {
    ...T.label,
    color: '#AAAACC',
  },

  lastResultValue: {
    fontSize:   32,
    fontWeight: '900',
    color:      C.amber,
    marginTop:  4,
  },

  scanButton: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    backgroundColor: C.amber,
    borderRadius:    LAYOUT.borderRadius,
    height:          TOUCH.primary,
    gap:             S.sm,
  },

  scanButtonIcon: {
    fontSize: 24,
  },

  scanButtonText: {
    ...T.button,
    color: C.black,
    fontSize: 22,
  },
});
