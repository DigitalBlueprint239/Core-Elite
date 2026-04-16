/**
 * AthleteCard
 *
 * Arm's-length readable athlete identity display.
 * Shown once athlete is scanned — persists through result entry.
 *
 * Readable at ~60cm (arm's length) requirements:
 *   - Name: 40sp, weight 900 — 15mm+ at typical phone size
 *   - Band number: 28sp, high contrast pill
 *   - Position/grade: 16sp supporting info
 *
 * Visual hierarchy:
 *   BAND ███  ← first eye target (large amber pill)
 *   LAST NAME ← dominant (capitalized, hero size)
 *   First · 8th · WR ← supporting metadata
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, S, T, LAYOUT } from '../theme';
import { Athlete } from '../../../../src/lib/types';

interface Props {
  athlete: Athlete;
  attemptNumber: number;
}

export function AthleteCard({ athlete, attemptNumber }: Props) {
  const bandNum = athlete.bands?.display_number ?? athlete.band_id?.slice(-4) ?? '—';

  return (
    <View style={styles.card}>
      {/* Band number — the operator's primary ID at arm's length */}
      <View style={styles.bandPill}>
        <Text style={styles.bandLabel}>BAND</Text>
        <Text style={styles.bandNumber}>{bandNum}</Text>
      </View>

      {/* Name — arm's length readable */}
      <View style={styles.nameBlock}>
        <Text style={styles.lastName} numberOfLines={1} adjustsFontSizeToFit>
          {athlete.last_name.toUpperCase()}
        </Text>
        <Text style={styles.firstName} numberOfLines={1}>
          {athlete.first_name}
        </Text>
      </View>

      {/* Metadata row */}
      <View style={styles.metaRow}>
        <MetaChip value={`${athlete.grade}th`}   label="GRADE" />
        <View style={styles.metaDivider} />
        <MetaChip value={athlete.position}        label="POS"   />
        {attemptNumber > 0 && (
          <>
            <View style={styles.metaDivider} />
            <MetaChip value={`ATT ${attemptNumber + 1}`} label="" />
          </>
        )}
      </View>
    </View>
  );
}

function MetaChip({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.chip}>
      {label.length > 0 && <Text style={styles.chipLabel}>{label}</Text>}
      <Text style={styles.chipValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.white,
    borderRadius:    LAYOUT.cardRadius,
    padding:         S.lg,
    // Elevation for visibility over background
    shadowColor:     C.black,
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.12,
    shadowRadius:    8,
    elevation:       4,
    gap:             S.sm,
  },

  bandPill: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.amber,
    borderRadius:    100,
    alignSelf:       'flex-start',
    paddingHorizontal: S.md,
    paddingVertical:   6,
    gap:               6,
  },

  bandLabel: {
    ...T.label,
    color: C.black,
  },

  bandNumber: {
    fontSize:      20,
    fontWeight:    '900',
    color:         C.black,
    letterSpacing: -0.5,
  },

  nameBlock: {
    gap: 2,
  },

  lastName: {
    fontSize:      40,
    fontWeight:    '900',
    color:         C.gray9,
    letterSpacing: -1,
    lineHeight:    44,
  },

  firstName: {
    ...T.heroSub,
    color: C.gray7,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems:    'center',
    marginTop:     S.xs,
    gap:           S.sm,
  },

  metaDivider: {
    width:           1,
    height:          16,
    backgroundColor: C.gray2,
  },

  chip: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  },

  chipLabel: {
    ...T.label,
    color: C.gray5,
  },

  chipValue: {
    ...T.body,
    fontWeight: '700',
    color:      C.gray7,
  },
});
