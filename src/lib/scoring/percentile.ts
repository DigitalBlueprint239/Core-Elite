/**
 * scoring/percentile.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * Z-Score Percentile Engine — v2 §2.1.3
 *
 * Normal CDF implementation:
 *   Abramowitz & Stegun, Handbook of Mathematical Functions (1964)
 *   Formula 26.2.17 — maximum absolute error ≤ 7.5 × 10⁻⁸
 *
 * Z-score convention (v2 §2.1.3):
 *   Time-based (lower_is_better): Z = (μ − X) / σ
 *     Inverted so that faster time → positive Z → higher percentile.
 *   Distance-based (higher_is_better): Z = (X − μ) / σ
 *     Standard: greater distance → positive Z → higher percentile.
 *
 * Normative lookup priority (v2 §2.1.1, §2.1.2):
 *   1. McKay et al. 2020 — position × grade specific (if available)
 *   2. McKay et al. 2020 — position aggregate (if available)
 *   3. Gillen et al. 2019 — all-position aggregate (always available)
 */

import {
  DrillId,
  ScoreDirection,
  Position,
  Grade,
  NormativeStats,
  DRILL_DIRECTION,
  GILLEN_AGGREGATE_NORMS,
  MCKAY_POSITION_NORMS,
} from './constants';

// ---------------------------------------------------------------------------
// Abramowitz & Stegun CDF approximation — formula 26.2.17
//
// For x ≥ 0:
//   t    = 1 / (1 + p·x),  p = 0.2316419
//   poly = t·(b₁ + t·(b₂ + t·(b₃ + t·(b₄ + t·b₅))))   [Horner form]
//   φ(x) = (1/√2π) · exp(−x²/2)
//   Φ(x) ≈ 1 − φ(x)·poly
//
// For x < 0:
//   Φ(x) = 1 − Φ(−x)
//
// Constants (A&S 26.2.17):
//   p  = 0.2316419
//   b₁ =  0.319381530
//   b₂ = −0.356563782
//   b₃ =  1.781477937
//   b₄ = −1.821255978
//   b₅ =  1.330274429
//
// Maximum absolute error: |ε(x)| ≤ 7.5 × 10⁻⁸
// ---------------------------------------------------------------------------
const AS_P  = 0.2316419;
const AS_B1 =  0.319381530;
const AS_B2 = -0.356563782;
const AS_B3 =  1.781477937;
const AS_B4 = -1.821255978;
const AS_B5 =  1.330274429;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI); // ≈ 0.39894228040143

/**
 * Abramowitz & Stegun normal CDF approximation.
 * Returns Φ(x) = P(Z ≤ x) for Z ~ N(0,1).
 * Result is clamped to [0, 1] to absorb floating-point edge cases.
 *
 * @param x  Standard normal deviate
 * @returns  Cumulative probability in [0, 1]
 */
export function normalCDF(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;

  const absX = Math.abs(x);

  // For |x| > 8, the tail probability is negligibly small.
  // Φ(8) ≈ 1 − 6.2 × 10⁻¹⁶; clamp to avoid underflow.
  if (absX > 8) return x > 0 ? 1 : 0;

  // Horner's method for the polynomial — minimises floating-point cancellation
  const t    = 1 / (1 + AS_P * absX);
  const poly = t * (AS_B1 + t * (AS_B2 + t * (AS_B3 + t * (AS_B4 + t * AS_B5))));
  const phi  = INV_SQRT_2PI * Math.exp(-0.5 * absX * absX);
  const cdf  = 1 - phi * poly;

  // Reflection for negative x
  const result = x >= 0 ? cdf : 1 - cdf;

  // Final clamp: the approximation has max error 7.5×10⁻⁸ but can theoretically
  // produce values marginally outside [0,1] for extreme inputs.
  return Math.max(0, Math.min(1, result));
}

// ---------------------------------------------------------------------------
// Z-score calculation — direction-aware (v2 §2.1.3)
// ---------------------------------------------------------------------------

/**
 * Compute the Z-score for a measured value against a normative distribution.
 *
 * The sign convention ensures that a higher Z always means a better result:
 *   lower_is_better: Z = (mean − X) / sd   (inverted — faster time is positive)
 *   higher_is_better: Z = (X − mean) / sd  (standard — more is positive)
 */
export function computeZ(
  value:      number,
  mean:       number,
  sd:         number,
  direction:  ScoreDirection,
): number {
  if (sd <= 0) throw new Error(`computeZ: sd must be positive, got ${sd}`);
  return direction === 'lower_is_better'
    ? (mean - value) / sd
    : (value - mean) / sd;
}

/**
 * Convert a Z-score to a percentile rank (0–100, integer).
 * Uses the A&S CDF approximation. Result is rounded to nearest integer.
 *
 * Examples:
 *   Z = 0    → 50th percentile (exactly average)
 *   Z = 1    → 84th percentile
 *   Z = −1   → 16th percentile
 *   Z = 2    → 98th percentile
 */
export function zToPercentile(z: number): number {
  return Math.round(normalCDF(z) * 100);
}

// ---------------------------------------------------------------------------
// Normative lookup — priority chain
// ---------------------------------------------------------------------------

export type NormSource = 'position_grade' | 'position_aggregate' | 'gillen_aggregate';

export interface NormLookupResult {
  norm:   NormativeStats;
  source: NormSource;
}

/**
 * Resolve the best available normative stats for a given drill, position, and grade.
 *
 * Priority:
 *   1. McKay et al. 2020 position × aggregate (if position has a populated table entry)
 *   2. Gillen et al. 2019 all-position aggregate (always available)
 *
 * Fallback guarantee:
 *   - If `position` is undefined, null, or 'ATHLETE' → Gillen
 *   - If `position` is in MCKAY_POSITION_NORMS but the table is empty (e.g. K, P) → Gillen
 *   - If `position` has a table but the specific drill is absent → Gillen
 *   - If the drill is not in GILLEN_AGGREGATE_NORMS → runtime error (caller's bug)
 *
 * Grade-specific subdivision: McKay et al. 2020 does not publish grade-split tables,
 * so `_grade` is retained for future API compatibility only.
 */
export function lookupNorm(
  drillId:   DrillId,
  position?: Position,
  _grade?:   Grade,     // Retained for API completeness; grade-specific tables not in McKay 2020
): NormLookupResult {
  // Priority 1: position-specific norms from McKay et al. 2020.
  // Skipped when: position is absent, is the 'ATHLETE' sentinel, the position
  // has no table in MCKAY_POSITION_NORMS, or the position's table is empty /
  // does not contain this drill (e.g. K, P, LS, and all sub-positions map to
  // empty tables and always fall through to Gillen).
  if (position && position !== 'ATHLETE') {
    const posTable = MCKAY_POSITION_NORMS[position];
    if (posTable) {
      const norm = posTable[drillId];
      if (norm) {
        return { norm, source: 'position_aggregate' };
      }
    }
  }

  // Priority 2: Gillen et al. 2019 aggregate — always present for all 5 BES drills.
  return {
    norm:   GILLEN_AGGREGATE_NORMS[drillId],
    source: 'gillen_aggregate',
  };
}

// ---------------------------------------------------------------------------
// Full percentile result type
// ---------------------------------------------------------------------------

export interface PercentileResult {
  drillId:    DrillId;
  value:      number;
  z:          number;
  percentile: number;       // 0–100 integer
  norm:       NormativeStats;
  normSource: NormSource;
  direction:  ScoreDirection;
  /** True when McKay position-specific norms were used; false when falling back to Gillen aggregate. */
  isPositionAdjusted: boolean;
}

/**
 * Compute a percentile score for a single drill result.
 *
 * This is the primary entry point for all scoring consumers.
 * The caller is responsible for running validateResult() before calling this;
 * this function does not validate inputs.
 *
 * @param drillId   Drill identifier matching DRILL_CATALOG
 * @param value     Measured result in the drill's native unit (sec or inches)
 * @param position  Athlete's position for position-adjusted norms (optional)
 * @param grade     Athlete's grade for grade-adjusted norms (optional)
 */
export function getPercentile(
  drillId:   DrillId,
  value:     number,
  position?: Position,
  grade?:    Grade,
): PercentileResult {
  const direction             = DRILL_DIRECTION[drillId];
  const { norm, source }      = lookupNorm(drillId, position, grade);
  const z                     = computeZ(value, norm.mean, norm.sd, direction);
  const percentile            = zToPercentile(z);

  return {
    drillId,
    value,
    z,
    percentile,
    norm,
    normSource: source,
    direction,
    isPositionAdjusted: source !== 'gillen_aggregate',
  };
}

/**
 * Compute percentiles for multiple drills in one call.
 * Skips any drill ID not in GILLEN_AGGREGATE_NORMS.
 */
export function getPercentiles(
  measurements: Array<{ drillId: DrillId; value: number }>,
  position?: Position,
  grade?:    Grade,
): PercentileResult[] {
  return measurements.map(({ drillId, value }) =>
    getPercentile(drillId, value, position, grade),
  );
}
