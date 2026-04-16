/**
 * SyncPill
 *
 * Persistent sync status indicator — always visible, never blocking.
 * Position: top-right of screen, below error banner.
 *
 * States:
 *   online  + pending=0  → gray "SYNCED" (minimal visual weight)
 *   online  + pending>0  → blue spinning "SYNCING N"
 *   offline + pending=0  → amber "OFFLINE"
 *   offline + pending>0  → amber "OFFLINE · N QUEUED" (attention needed)
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { C, S, T } from '../theme';

interface Props {
  isOnline:    boolean;
  pending:     number;
  submitting:  boolean;
}

export function SyncPill({ isOnline, pending, submitting }: Props) {
  const spin = useRef(new Animated.Value(0)).current;
  const anim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (submitting || (isOnline && pending > 0)) {
      anim.current = Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        })
      );
      anim.current.start();
    } else {
      anim.current?.stop();
      spin.setValue(0);
    }
    return () => anim.current?.stop();
  }, [submitting, isOnline, pending]);

  const rotate = spin.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  let bg:    string;
  let label: string;
  let textColor = C.white;

  if (!isOnline) {
    bg    = C.amber;
    label = pending > 0 ? `OFFLINE · ${pending} QUEUED` : 'OFFLINE';
    textColor = C.black;
  } else if (submitting || pending > 0) {
    bg    = C.blue;
    label = `SYNCING${pending > 0 ? ` ${pending}` : ''}`;
  } else {
    bg    = C.gray7;
    label = 'SYNCED';
  }

  const showSpinner = submitting || (isOnline && pending > 0);

  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {showSpinner && (
        <Animated.Text style={[styles.spinner, { transform: [{ rotate }], color: textColor }]}>
          ↻
        </Animated.Text>
      )}
      {!showSpinner && !isOnline && (
        <Text style={[styles.icon, { color: textColor }]}>⚡</Text>
      )}
      {!showSpinner && isOnline && (
        <Text style={[styles.icon, { color: textColor }]}>✓</Text>
      )}
      <Text style={[styles.label, { color: textColor }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection:   'row',
    alignItems:      'center',
    borderRadius:    100,
    paddingHorizontal: S.md,
    paddingVertical:   6,
    gap:               4,
  },

  spinner: {
    fontSize:   14,
    fontWeight: '900',
    marginRight: 2,
  },

  icon: {
    fontSize:   12,
    fontWeight: '800',
    marginRight: 2,
  },

  label: {
    fontSize:      11,
    fontWeight:    '700',
    letterSpacing: 0.8,
  },
});
