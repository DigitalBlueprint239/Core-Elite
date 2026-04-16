/**
 * ErrorBanner
 *
 * Non-blocking persistent error display.
 * Sits at the TOP of the screen so it never covers controls.
 * Does NOT pause workflow — operator dismisses when convenient.
 *
 * Design contract:
 *   - Always visible: positioned above all content, never in thumb zone
 *   - Color-coded: orange=warn, red=error
 *   - Auto-dismiss after 8s for warn, never auto-dismiss for error
 *   - Multiple errors stack (max 3 visible)
 *   - Each error has an explicit × dismiss button (56dp touch target)
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { C, S, T, TOUCH } from '../theme';
import { ErrorEntry } from '../machine';

interface Props {
  errors: ErrorEntry[];
  onDismiss: (id: string) => void;
}

function ErrorRow({ entry, onDismiss }: { entry: ErrorEntry; onDismiss: (id: string) => void }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, []);

  useEffect(() => {
    if (entry.severity === 'warn') {
      const timer = setTimeout(() => onDismiss(entry.id), 8000);
      return () => clearTimeout(timer);
    }
  }, [entry.id, entry.severity]);

  const bg    = entry.severity === 'error' ? C.red    : '#E65100';
  const label = entry.severity === 'error' ? 'ERROR'  : 'WARN';

  return (
    <Animated.View style={[styles.row, { backgroundColor: bg, opacity }]}>
      <View style={styles.pill}>
        <Text style={styles.pillText}>{label}</Text>
      </View>
      <Text style={styles.message} numberOfLines={2}>{entry.message}</Text>
      <TouchableOpacity
        style={styles.dismiss}
        onPress={() => onDismiss(entry.id)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="Dismiss error"
        accessibilityRole="button"
      >
        <Text style={styles.dismissText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function ErrorBanner({ errors, onDismiss }: Props) {
  const visible = errors.filter(e => !e.dismissed);
  if (visible.length === 0) return null;

  return (
    <View style={styles.container} pointerEvents="box-none">
      {visible.map(entry => (
        <ErrorRow key={entry.id} entry={entry} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position:  'absolute',
    top:       0,
    left:      0,
    right:     0,
    zIndex:    100,
    // Safe area handled by parent — this just stacks from top:0
  },

  row: {
    flexDirection:  'row',
    alignItems:     'center',
    paddingHorizontal: S.md,
    paddingVertical:   S.sm,
    marginBottom:      2,
    minHeight:         TOUCH.nav,
  },

  pill: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius:    4,
    paddingHorizontal: 6,
    paddingVertical:   2,
    marginRight:       S.sm,
    flexShrink:        0,
  },

  pillText: {
    color:      C.white,
    fontSize:   10,
    fontWeight: '800',
    letterSpacing: 1,
  },

  message: {
    ...T.body,
    color:      C.white,
    flex:       1,
    marginRight: S.sm,
  },

  dismiss: {
    width:           TOUCH.nav,
    height:          TOUCH.nav,
    alignItems:      'center',
    justifyContent:  'center',
    flexShrink:      0,
  },

  dismissText: {
    color:      C.white,
    fontSize:   20,
    fontWeight: '700',
  },
});
