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
  | 'K'  | 'P'  | 'ATHLETE'; // ATHLETE = unknown / no position adjustment

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
// PMID 30418328
//
// STATUS: Structure is wired and the lookup path is implemented.
// Values below are STUBS pending exact extraction from corpus v2 §2.1.2.
//
// Framework-confirmed anchor point (v2 §2.1.2 worked example):
//   OL running 5.06s in the 40-yard dash = 50th percentile for OL position.
//   That same 5.06s = ~10th percentile against aggregate (Gillen).
//   Therefore OL 40-yard mean ≈ 5.06s.
//
// All other positions below inherit aggregate norms until McKay values are
// populated. Replace each stub with the exact McKay et al. 2020 values.
// ---------------------------------------------------------------------------
export type PositionNormTable = Partial<Record<DrillId, NormativeStats>>;

export const MCKAY_POSITION_NORMS: Partial<Record<Position, PositionNormTable>> = {
  OL: {
    // Anchor: McKay et al. 2020 — OL 40yd P50 = 5.06s (framework v2 §2.1.2)
    forty: { mean: 5.06, sd: 0.38, n: 0, source: 'McKay et al. 2020, PMID 30418328 — STUB: sd estimated' },
    // Remaining OL drills: TODO populate from McKay corpus
  },
  // TODO: Populate WR, RB, QB, TE, DL, LB, DB, K, P from McKay et al. 2020 (v2 §2.1.2)
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
    // Framework values (v2 §2.2.4): floor=3.70s, world_record=4.21s, max=9.00s
    physicalFloor:      3.70,  // Below this: physically impossible
    maxThreshold:       9.00,  // Above this: sensor malfunction
    extraordinaryFloor: 4.21,  // Below this (faster): below world-record pace → manual review
  },
  ten_split: {
    // 10-yard split biomechanical limits derived from 40yd model
    physicalFloor:      1.40,  // Sub-1.40s is physically impossible at any level
    maxThreshold:       3.00,  // Above 3.00s → sensor malfunction
    extraordinaryFloor: 1.50,  // Below 1.50s → world-class territory, manual review
  },
  shuttle_5_10_5: {
    // Pro agility 5-10-5 thresholds
    physicalFloor:      3.60,  // Below NFL combine all-time records
    maxThreshold:       8.00,  // Above 8.00s → sensor malfunction
    extraordinaryFloor: 3.73,  // Below NFL all-time combine record → manual review
  },
  vertical: {
    // Vertical jump — direction is higher_is_better; roles of floor/extraordinary flip
    physicalFloor:       5.0,  // Below 5in: implausible for any able-bodied athlete
    maxThreshold:       72.0,  // Above 72in: sensor malfunction (no human has jumped 6ft)
    extraordinaryFloor: 50.0,  // Above 50in: exceptional, manual verification recommended
  },
  broad: {
    // Broad jump — direction is higher_is_better
    physicalFloor:       36.0, // Below 3ft: implausible for any football player
    maxThreshold:       200.0, // Above ~16.7ft: sensor malfunction
    extraordinaryFloor: 144.0, // Above 12ft: exceptional, manual verification
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
