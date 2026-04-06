/**
 * scoring/bes.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * Biomechanical Efficiency Score (BES) — Composite Score
 *
 * The BES is the primary output of the Scout's Intuition Engine.
 * It synthesises validated drill results into a single 0–100 score
 * that accounts for position, grade, mechanical efficiency, and the
 * normative context that raw times cannot provide alone.
 *
 * Formula (framework Phase 3 specification):
 *   BES = weighted_average(
 *     Z_percentile('forty',          position, grade),  // weight 0.30
 *     Z_percentile('ten_split',      position, grade),  // weight 0.25
 *     Z_percentile('vertical',       position, grade),  // weight 0.20
 *     Z_percentile('shuttle_5_10_5', position, grade),  // weight 0.15
 *     disparity_penalty(ten_split_pct, vert_pct)        // weight 0.10, ≤ 0
 *   )
 *
 * Disparity component:
 *   When no mechanical disparity detected (gap ≤ 20 pct pts): contribution = 0
 *   When disparity detected (gap > 20 pct pts): contribution = −(gap − 20)
 *   This is a negative modifier on the BES, scaled by weight 0.10.
 *
 * Partial-data behaviour:
 *   BES is computed from whatever drills are available.
 *   Weights are re-normalised across available drills so the score is
 *   always on the 0–100 scale regardless of how many drills were recorded.
 *   The disparity penalty applies only when both ten_split and vertical are present.
 */

import {
  DrillId,
  Position,
  Grade,
  BES_WEIGHTS,
  BES_BANDS,
  BESBandLabel,
  DISPARITY_THRESHOLD_PCT_POINTS,
} from './constants';
import { validateResult, ValidationResult } from './validation';
import { getPercentile, PercentileResult } from './percentile';
import { detectMechanicalDisparity, DisparityResult } from './disparity';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface BESDrillInput {
  drillId:     DrillId;
  value:       number;
  reactionMs?: number; // Optional — enables Gate 1 (false_start) check
}

export interface BESComponentScore {
  drillId:              DrillId;
  value:                number;
  validation:           ValidationResult;
  percentile:           number;    // 0–100, from A&S CDF
  z:                    number;
  weight:               number;    // Raw weight from BES_WEIGHTS
  normalizedWeight:     number;    // Adjusted weight given available drills
  weightedContribution: number;    // normalizedWeight × percentile
  normSource:           string;
}

export interface BESResult {
  // Primary outputs
  score:         number;         // 0–100, rounded to 1 decimal place
  band:          BESBandLabel;
  interpretation: string;        // Human-readable interpretation

  // Component breakdown
  components:    BESComponentScore[];

  // Disparity
  disparityResult:  DisparityResult;
  disparityPenalty: number;       // ≤ 0; 0 when no disparity

  // Metadata
  position?:     Position;
  grade?:        Grade;
  availableWeightSum: number;    // Sum of raw weights for drills that were provided and valid
  validDrillCount:    number;
  invalidDrills: Array<{ drillId: DrillId; reason: string }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map BES score to its named performance band */
function scoreToBand(score: number): BESBandLabel {
  for (const band of BES_BANDS) {
    if (score >= band.min && score <= band.max) return band.label;
  }
  return 'Needs Development';
}

/** Generate a one-sentence interpretation for the scout card */
function generateInterpretation(
  score:            number,
  band:             BESBandLabel,
  disparityResult:  DisparityResult,
): string {
  const base = `BES ${score.toFixed(1)} — ${band}.`;

  if (!disparityResult.detected) return base;

  if (disparityResult.direction === 'power_exceeds_acceleration') {
    return (
      base +
      ` Mechanical disparity flagged: vertical power ` +
      `(${disparityResult.verticalPercentile}th pct) exceeds sprint acceleration ` +
      `(${disparityResult.tenYardPercentile}th pct) by ${disparityResult.gap} points — ` +
      `horizontal force application needs work.`
    );
  }

  return (
    base +
    ` Note: sprint acceleration (${disparityResult.tenYardPercentile}th pct) ` +
    `exceeds vertical power (${disparityResult.verticalPercentile}th pct) by ` +
    `${disparityResult.gap} points — power development recommended.`
  );
}

// ---------------------------------------------------------------------------
// Primary export — computeBES
// ---------------------------------------------------------------------------

/**
 * Compute the Biomechanical Efficiency Score for an athlete.
 *
 * The function:
 *   1. Validates each drill result through the 4-gate pipeline
 *   2. Computes position/grade-adjusted Z-score percentiles
 *   3. Detects mechanical disparity between ten_split and vertical
 *   4. Applies the weighted BES formula with disparity penalty
 *   5. Returns a fully structured BESResult with coaching context
 *
 * Invalid results (any gate fires) are excluded from the BES.
 * The score is always normalised to 0–100 regardless of available drills.
 *
 * @param inputs    Array of drill measurements to include
 * @param position  Athlete position for position-adjusted norms (optional)
 * @param grade     Athlete grade for grade-adjusted norms (optional)
 */
export function computeBES(
  inputs:     BESDrillInput[],
  position?:  Position,
  grade?:     Grade,
): BESResult {
  const components:   BESComponentScore[]                      = [];
  const invalidDrills: Array<{ drillId: DrillId; reason: string }> = [];

  // -------------------------------------------------------------------
  // Step 1 & 2: Validate and score each drill
  // -------------------------------------------------------------------
  for (const input of inputs) {
    const rawWeight = BES_WEIGHTS[input.drillId];
    if (rawWeight === undefined || rawWeight === 0) {
      // Drill not in BES formula (e.g. broad jump — available for standalone only)
      continue;
    }

    const validation = validateResult(input.drillId, input.value, input.reactionMs);

    if (validation.valid === false) {
      invalidDrills.push({
        drillId: input.drillId,
        reason:  validation.reason,
      });
      continue;
    }

    const pResult: PercentileResult = getPercentile(
      input.drillId,
      input.value,
      position,
      grade,
    );

    components.push({
      drillId:              input.drillId,
      value:                input.value,
      validation,
      percentile:           pResult.percentile,
      z:                    pResult.z,
      weight:               rawWeight,
      normalizedWeight:     0, // filled in step 3
      weightedContribution: 0, // filled in step 3
      normSource:           `${pResult.normSource} (${pResult.norm.source})`,
    });
  }

  // -------------------------------------------------------------------
  // Step 3: Mechanical disparity detection
  // -------------------------------------------------------------------
  const tenSplitComp  = components.find(c => c.drillId === 'ten_split');
  const verticalComp  = components.find(c => c.drillId === 'vertical');

  const disparityResult: DisparityResult =
    tenSplitComp && verticalComp
      ? detectMechanicalDisparity(
          tenSplitComp.percentile,
          verticalComp.percentile,
        )
      : {
          detected:           false,
          tenYardPercentile:  tenSplitComp?.percentile ?? 0,
          verticalPercentile: verticalComp?.percentile ?? 0,
          gap:                0,
          direction:          'none',
          message:            null,
          coachingCue:        null,
        };

  // Disparity penalty value:
  //   0 when no disparity detected (gap ≤ threshold)
  //   −(gap − threshold) when disparity detected, e.g. gap=35 → penalty=−15
  //   Floored at −80 (gap of 100 points is the maximum possible)
  const disparityPenalty: number = disparityResult.detected
    ? Math.max(-80, -(disparityResult.gap - DISPARITY_THRESHOLD_PCT_POINTS))
    : 0;

  // -------------------------------------------------------------------
  // Step 4: Weighted BES calculation with normalisation
  // -------------------------------------------------------------------

  // Sum of raw weights for drills that are present and valid
  const availableWeightSum = components.reduce((acc, c) => acc + c.weight, 0);

  // Add the disparity weight only when both qualifying drills are present
  const disparityWeightContributes = tenSplitComp !== undefined && verticalComp !== undefined;
  const effectiveWeightSum = availableWeightSum + (disparityWeightContributes ? BES_WEIGHTS.disparity : 0);

  let rawBES = 0;

  // Normalise component weights and accumulate weighted contributions
  for (const comp of components) {
    const normalizedWeight  = effectiveWeightSum > 0 ? comp.weight / effectiveWeightSum : 0;
    const contribution      = normalizedWeight * comp.percentile;

    comp.normalizedWeight     = normalizedWeight;
    comp.weightedContribution = contribution;

    rawBES += contribution;
  }

  // Add disparity penalty contribution (always negative or zero)
  if (disparityWeightContributes && effectiveWeightSum > 0) {
    const normalizedDisparityWeight = BES_WEIGHTS.disparity / effectiveWeightSum;
    rawBES += normalizedDisparityWeight * disparityPenalty;
  }

  // Clamp to [0, 100] and round to 1 decimal place
  const score = Math.round(Math.max(0, Math.min(100, rawBES)) * 10) / 10;

  // -------------------------------------------------------------------
  // Step 5: Interpretation
  // -------------------------------------------------------------------
  const band           = scoreToBand(score);
  const interpretation = generateInterpretation(score, band, disparityResult);

  return {
    score,
    band,
    interpretation,
    components,
    disparityResult,
    disparityPenalty,
    position,
    grade,
    availableWeightSum,
    validDrillCount:  components.length,
    invalidDrills,
  };
}

/**
 * Quick-score a single drill without position/grade adjustment.
 * Returns only the percentile — no BES composite, no disparity.
 * Useful for real-time display as the scout enters results.
 */
export function quickPercentile(drillId: DrillId, value: number): number | null {
  const validation = validateResult(drillId, value);
  if (!validation.valid) return null;
  return getPercentile(drillId, value).percentile;
}
