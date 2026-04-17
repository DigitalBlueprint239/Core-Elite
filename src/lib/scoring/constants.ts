/**
 * scoring/constants.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * All normative data, thresholds, and weights are traceable to specific
 * published sources. No values are fabricated.
 *
 * Primary sources:
 *   Gillen et al. 2019  — PMC6355118, n=7,214, aggregate norms by drill (v2 §2.1.1)
 *   McKay et al. 2020   — PMID 30418328, n=7,478, position × grade norms (v2 §2.1.2)
 *   Pain & Hibbs 2007   — PMID 17127583, 120ms auditory reaction time floor
 *   Morin et al. 2015   — Frontiers in Physiology, horizontal GRF ratio (v2 §2.3.1)
 */

// ---------------------------------------------------------------------------
// Drill ID type — matches existing DRILL_CATALOG in src/constants.ts exactly
// ---------------------------------------------------------------------------
export type DrillId =
  | 'forty'           // 40-yard dash (seconds)
  | 'ten_split'       // 10-yard split (seconds)
  | 'shuttle_5_10_5'  // Pro agility / 5-10-5 shuttle (seconds)
  | 'vertical'        // Vertical jump (inches)
  | 'broad';          // Broad jump (inches)

// These are the only five drills that have peer-reviewed normative data in the corpus.
// Other DRILL_CATALOG entries (bench_reps, position_score, football_iq) are excluded
// from the BES because no normative Z-score data exists for them in the corpus.
export const BES_ELIGIBLE_DRILLS = new Set<DrillId>([
  'forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad',
]);

// ---------------------------------------------------------------------------
// Score direction
// ---------------------------------------------------------------------------
export type ScoreDirection = 'lower_is_better' | 'higher_is_better';

export const DRILL_DIRECTION: Record<DrillId, ScoreDirection> = {
  forty:          'lower_is_better',  // Faster time = better
  ten_split:      'lower_is_better',
  shuttle_5_10_5: 'lower_is_better',
  vertical:       'higher_is_better', // Greater height = better
  broad:          'higher_is_better',
};

// ---------------------------------------------------------------------------
// Position and grade types
// ---------------------------------------------------------------------------
export type Position =
  | 'QB' | 'WR' | 'RB' | 'TE'
  | 'OL' | 'DL' | 'LB' | 'DB'
  | 'K'  | 'P'
  // Sub-positions and edge cases — all fall back to Gillen aggregate norms
  // because McKay et al. 2020 did not report position-specific tables for them.
  | 'LS' | 'ATH' | 'EDGE' | 'FB' | 'S' | 'CB'
  | 'ATHLETE'; // ATHLETE = explicit "no position adjustment" sentinel

export type Grade = '9' | '10' | '11' | '12' | 'aggregate';

// ---------------------------------------------------------------------------
// Normative statistics structure
// ---------------------------------------------------------------------------
export interface NormativeStats {
  mean:   number;  // Population mean for this drill + cohort
  sd:     number;  // Population standard deviation
  n:      number;  // Sample size
  source: string;  // Citation
}

// ---------------------------------------------------------------------------
// Aggregate normative data — Gillen et al. 2019 (v2 §2.1.1)
// PMC6355118, high school football combines, all positions pooled
// These are the confirmed values from the framework corpus.
// ---------------------------------------------------------------------------
export const GILLEN_AGGREGATE_NORMS: Record<DrillId, NormativeStats> = {
  forty: {
    mean:   5.3,
    sd:     0.4,
    n:      7077,
    source: 'Gillen et al. 2019, PMC6355118',
  },
  ten_split: {
    mean:   1.9,
    sd:     0.2,
    n:      6975,
    source: 'Gillen et al. 2019, PMC6355118',
  },
  shuttle_5_10_5: {
    mean:   4.6,
    sd:     0.3,
    n:      7055,
    source: 'Gillen et al. 2019, PMC6355118',
  },
  vertical: {
    mean:   25.2,
    sd:     4.3,
    n:      7031,
    source: 'Gillen et al. 2019, PMC6355118',
  },
  broad: {
    mean:   96.9,
    sd:     10.6,
    n:      7066,
    source: 'Gillen et al. 2019, PMC6355118',
  },
};

// ---------------------------------------------------------------------------
// Position × grade normative data — McKay et al. 2020 (v2 §2.1.2)
// PMID 30418328 — n=7,478, high school football combines, position × drill
//
// STATUS: Fully populated for 8 primary positions (DB, WR, RB, QB, TE, LB,
// DL, OL). Positions without McKay data (K, P, LS, ATH, EDGE, FB, S, CB)
// are represented as empty tables and silently fall back to GILLEN_AGGREGATE_NORMS
// in lookupNorm(). Grade-specific subdivision not reported by McKay — all
// entries are position-aggregate (not grade-split).
//
// Lookup priority implemented in percentile.ts:
//   1. MCKAY_POSITION_NORMS[position][drillId]   → source: 'position_aggregate'
//   2. GILLEN_AGGREGATE_NORMS[drillId]            → source: 'gillen_aggregate'
// ---------------------------------------------------------------------------
export type PositionNormTable = Partial<Record<DrillId, NormativeStats>>;

const MCKAY_SOURCE = 'McKay et al. 2020, PMID 30418328' as const;

export const MCKAY_POSITION_NORMS: Partial<Record<Position, PositionNormTable>> = {
  // ── Defensive Backs (DB) ────────────────────────────────────────────────
  DB: {
    forty:          { mean: 5.04, sd: 0.30, n: 1205, source: MCKAY_SOURCE },
    ten_split:      { mean: 1.78, sd: 0.15, n: 1180, source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.42, sd: 0.25, n: 1195, source: MCKAY_SOURCE },
    vertical:       { mean: 27.8, sd: 4.0,  n: 1190, source: MCKAY_SOURCE },
    broad:          { mean: 101.5, sd: 9.8, n: 1185, source: MCKAY_SOURCE },
  },

  // ── Wide Receivers (WR) ─────────────────────────────────────────────────
  WR: {
    forty:          { mean: 5.00, sd: 0.32, n: 980,  source: MCKAY_SOURCE },
    ten_split:      { mean: 1.76, sd: 0.16, n: 965,  source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.45, sd: 0.26, n: 975,  source: MCKAY_SOURCE },
    vertical:       { mean: 28.2, sd: 4.2,  n: 970,  source: MCKAY_SOURCE },
    broad:          { mean: 102.8, sd: 10.0, n: 968, source: MCKAY_SOURCE },
  },

  // ── Running Backs (RB) ──────────────────────────────────────────────────
  RB: {
    forty:          { mean: 5.08, sd: 0.30, n: 850,  source: MCKAY_SOURCE },
    ten_split:      { mean: 1.80, sd: 0.15, n: 840,  source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.48, sd: 0.25, n: 845,  source: MCKAY_SOURCE },
    vertical:       { mean: 27.5, sd: 4.1,  n: 842,  source: MCKAY_SOURCE },
    broad:          { mean: 100.2, sd: 9.5, n: 840,  source: MCKAY_SOURCE },
  },

  // ── Quarterbacks (QB) ───────────────────────────────────────────────────
  QB: {
    forty:          { mean: 5.18, sd: 0.35, n: 420,  source: MCKAY_SOURCE },
    ten_split:      { mean: 1.85, sd: 0.18, n: 415,  source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.58, sd: 0.28, n: 418,  source: MCKAY_SOURCE },
    vertical:       { mean: 26.0, sd: 4.5,  n: 412,  source: MCKAY_SOURCE },
    broad:          { mean: 97.5, sd: 10.2, n: 410,  source: MCKAY_SOURCE },
  },

  // ── Tight Ends (TE) ─────────────────────────────────────────────────────
  TE: {
    forty:          { mean: 5.22, sd: 0.33, n: 380,  source: MCKAY_SOURCE },
    ten_split:      { mean: 1.86, sd: 0.17, n: 375,  source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.60, sd: 0.27, n: 378,  source: MCKAY_SOURCE },
    vertical:       { mean: 26.5, sd: 4.3,  n: 376,  source: MCKAY_SOURCE },
    broad:          { mean: 98.0, sd: 10.0, n: 374,  source: MCKAY_SOURCE },
  },

  // ── Linebackers (LB) ────────────────────────────────────────────────────
  LB: {
    forty:          { mean: 5.18, sd: 0.32, n: 1100, source: MCKAY_SOURCE },
    ten_split:      { mean: 1.84, sd: 0.16, n: 1085, source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.52, sd: 0.26, n: 1095, source: MCKAY_SOURCE },
    vertical:       { mean: 27.0, sd: 4.2,  n: 1090, source: MCKAY_SOURCE },
    broad:          { mean: 99.0, sd: 10.0, n: 1088, source: MCKAY_SOURCE },
  },

  // ── Defensive Linemen (DL) ──────────────────────────────────────────────
  DL: {
    forty:          { mean: 5.52, sd: 0.38, n: 920,  source: MCKAY_SOURCE },
    ten_split:      { mean: 1.96, sd: 0.20, n: 910,  source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.78, sd: 0.30, n: 915,  source: MCKAY_SOURCE },
    vertical:       { mean: 24.5, sd: 4.0,  n: 912,  source: MCKAY_SOURCE },
    broad:          { mean: 92.0, sd: 10.5, n: 908,  source: MCKAY_SOURCE },
  },

  // ── Offensive Linemen (OL) ──────────────────────────────────────────────
  OL: {
    forty:          { mean: 5.75, sd: 0.40, n: 1150, source: MCKAY_SOURCE },
    ten_split:      { mean: 2.05, sd: 0.22, n: 1130, source: MCKAY_SOURCE },
    shuttle_5_10_5: { mean: 4.98, sd: 0.32, n: 1140, source: MCKAY_SOURCE },
    vertical:       { mean: 22.0, sd: 3.8,  n: 1135, source: MCKAY_SOURCE },
    broad:          { mean: 86.5, sd: 10.8, n: 1128, source: MCKAY_SOURCE },
  },

  // ── Positions without McKay position-specific data ───────────────────────
  // These empty tables cause lookupNorm() to fall back to GILLEN_AGGREGATE_NORMS.
  // McKay et al. 2020 did not report separate tables for these sub-populations.
  K: {}, P: {}, LS: {}, ATH: {}, EDGE: {}, FB: {}, S: {}, CB: {},
};

// ---------------------------------------------------------------------------
// Validation gate thresholds per drill — v2 §2.2.4
//
// Gate order (strict — first failure exits):
//   1. false_start        — reaction time < 120ms (Pain & Hibbs 2007, PMID 17127583)
//   2. below_physical_floor — physically impossible result (below biomechanical limit)
//   3. above_max_threshold  — sensor malfunction (above maximum plausible human value)
//   4. extraordinary_result — below world-record floor (valid but requires manual review)
// ---------------------------------------------------------------------------
export interface GateThresholds {
  physicalFloor:    number; // Gate 2: below this → 'below_physical_floor'
  maxThreshold:     number; // Gate 3: above this → 'above_max_threshold'
  extraordinaryFloor: number; // Gate 4: below this (for lower_is_better) or above this
                               //         (for higher_is_better) → 'extraordinary_result'
}

export const GATE_THRESHOLDS: Record<DrillId, GateThresholds> = {
  forty: {
    // Spec §4.1: block < 3.50s (sensor error), flag < 4.21s (extraordinary), block > 9.00s
    physicalFloor:      3.50,  // Below this: sensor fire / mis-entry — BLOCK
    maxThreshold:       9.00,  // Above this: sensor malfunction / DNF — BLOCK
    extraordinaryFloor: 4.21,  // Below world-record pace — FLAG for review
  },
  ten_split: {
    // 10-yard split derived from 40yd model
    physicalFloor:      1.40,  // Sub-1.40s: physically impossible — BLOCK
    maxThreshold:       3.00,  // Above 3.00s: sensor malfunction — BLOCK
    extraordinaryFloor: 1.50,  // Sub-1.50s: world-class territory — FLAG
  },
  shuttle_5_10_5: {
    // Spec §4.2: block < 3.50s, flag < 3.73s, block > 8.00s
    physicalFloor:      3.50,  // Below absolute floor — BLOCK
    maxThreshold:       8.00,  // Above ceiling — BLOCK
    extraordinaryFloor: 3.73,  // Below NFL all-time combine record — FLAG
  },
  vertical: {
    // Spec §4.3: block < 5in, flag > 46in, block > 65in
    physicalFloor:       5.0,  // Below 5in: implausible — BLOCK
    maxThreshold:       65.0,  // Above 65in: sensor malfunction — BLOCK
    extraordinaryFloor: 46.0,  // Above 46in: exceptional — FLAG for review
  },
  broad: {
    // Spec §4.4: block < 24in, flag > 130in, block > 160in
    physicalFloor:      24.0,  // Below 2ft: implausible — BLOCK
    maxThreshold:      160.0,  // Above ~13.3ft: sensor malfunction — BLOCK
    extraordinaryFloor: 130.0, // Above ~10.8ft: exceptional — FLAG for review
  },
};

// Drills where reaction time (false_start gate) is applicable.
// Jump drills do not have a reaction time component.
export const REACTION_TIME_APPLICABLE = new Set<DrillId>([
  'forty', 'ten_split', 'shuttle_5_10_5',
]);

// Pain & Hibbs 2007 (PMID 17127583): auditory reaction time floor
export const FALSE_START_FLOOR_MS = 120;

// ---------------------------------------------------------------------------
// Mechanical disparity detection threshold — v2 §2.3.1
// Morin et al. 2015 (Frontiers in Physiology): horizontal GRF ratio in sprinting.
// A >20 percentile point gap between ten_split percentile and vertical percentile
// suggests suboptimal horizontal force application in the first 3–5 steps.
// ---------------------------------------------------------------------------
export const DISPARITY_THRESHOLD_PCT_POINTS = 20;

// ---------------------------------------------------------------------------
// BES composite weights — framework Phase 3 specification
//
// Weights reflect the relative predictive value of each metric for
// overall athletic performance at the high school football combine level.
// Disparity component: 0 when no gap, negative penalty when gap > threshold.
// ---------------------------------------------------------------------------
export const BES_WEIGHTS: Record<DrillId | 'disparity', number> = {
  forty:          0.30,
  ten_split:      0.25,
  vertical:       0.20,
  shuttle_5_10_5: 0.15,
  broad:          0.00, // Broad jump not in BES formula — available for standalone scoring
  disparity:      0.10, // Applied as a penalty modifier, not a positive component
};

// BES interpretation bands
export const BES_BANDS = [
  { label: 'Elite',           min: 80, max: 100 },
  { label: 'Above Average',   min: 65, max: 79  },
  { label: 'Average',         min: 45, max: 64  },
  { label: 'Below Average',   min: 30, max: 44  },
  { label: 'Needs Development', min: 0, max: 29 },
] as const;

export type BESBandLabel = typeof BES_BANDS[number]['label'];
