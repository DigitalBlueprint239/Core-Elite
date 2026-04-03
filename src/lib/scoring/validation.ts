/**
 * scoring/validation.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * 4-Gate Validation Pipeline — v2 §2.2.4
 *
 * Gates run in strict priority order. The pipeline exits on the first failure.
 * A result that fails Gate 2 is never tested against Gate 4 — no double-flagging.
 *
 * Gate order:
 *   1. false_start        — reaction_ms < 120ms (Pain & Hibbs 2007, PMID 17127583)
 *   2. below_physical_floor — time/distance below absolute biomechanical impossibility
 *   3. above_max_threshold  — time/distance above maximum plausible human value (sensor malfunction)
 *   4. extraordinary_result — within valid range but below world-record floor (manual review)
 *
 * Return contract:
 *   { valid: true }                             — all gates passed, result is clean
 *   { valid: false, gate, reason, flaggedValue } — first gate that fired
 */

import {
  DrillId,
  DRILL_DIRECTION,
  GATE_THRESHOLDS,
  REACTION_TIME_APPLICABLE,
  FALSE_START_FLOOR_MS,
} from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateType =
  | 'false_start'          // Gate 1 — reaction time below physiological minimum
  | 'below_physical_floor' // Gate 2 — result below absolute biomechanical impossibility
  | 'above_max_threshold'  // Gate 3 — result above sensor-malfunction ceiling
  | 'extraordinary_result'; // Gate 4 — result valid but below world-record floor (requires human review)

export type ValidationResult =
  | { valid: true }
  | {
      valid: false;
      gate:         GateType;
      reason:       string;
      flaggedValue: number;
    };

export interface ValidationReport {
  result: ValidationResult;
  drillId: DrillId;
  value: number;
  reactionMs?: number;
}

// ---------------------------------------------------------------------------
// Gate 1 — False Start
//
// Applies only to timed sprint/agility drills (forty, ten_split, shuttle_5_10_5).
// If reaction time is provided AND is below 120ms, the result is flagged.
// Jump drills (vertical, broad) have no reaction time component.
//
// Pain & Hibbs 2007 (PMID 17127583):
//   The minimum auditory reaction time for a simple go-signal in trained athletes
//   is ~120ms. Any measured reaction below this floor is physically impossible
//   and indicates a false start or timing equipment anomaly.
// ---------------------------------------------------------------------------
function checkFalseStart(
  drillId: DrillId,
  reactionMs: number | undefined,
): ValidationResult {
  if (!REACTION_TIME_APPLICABLE.has(drillId)) {
    return { valid: true };
  }
  if (reactionMs === undefined || reactionMs === null) {
    // No reaction time data available — gate cannot fire; pass through
    return { valid: true };
  }
  if (reactionMs < FALSE_START_FLOOR_MS) {
    return {
      valid:        false,
      gate:         'false_start',
      flaggedValue: reactionMs,
      reason:
        `Reaction time ${reactionMs}ms is below the 120ms auditory reaction floor ` +
        `(Pain & Hibbs 2007, PMID 17127583). Result is likely a false start or ` +
        `timing equipment anomaly.`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Gate 2 — Below Physical Floor
//
// A result below the absolute biomechanical floor is physically impossible.
// For lower_is_better drills: value < physicalFloor → impossible
// For higher_is_better drills: value < physicalFloor → implausible (any athlete can exceed this)
//
// Framework example (v2 §2.2.4): "40-yard dash < 3.70s is impossible."
// ---------------------------------------------------------------------------
function checkPhysicalFloor(drillId: DrillId, value: number): ValidationResult {
  const { physicalFloor } = GATE_THRESHOLDS[drillId];

  if (value < physicalFloor) {
    return {
      valid:        false,
      gate:         'below_physical_floor',
      flaggedValue: value,
      reason:
        `${drillId} value of ${value} is below the absolute biomechanical floor ` +
        `of ${physicalFloor}. This result is physically impossible and indicates ` +
        `a sensor fire, mis-entry, or equipment malfunction.`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Gate 3 — Above Maximum Threshold (Sensor Malfunction)
//
// For lower_is_better drills: value > maxThreshold → sensor malfunction
// For higher_is_better drills: value > maxThreshold → sensor malfunction
//
// Framework example (v2 §2.2.4): "40-yard dash > 9.00s → sensor malfunction."
// ---------------------------------------------------------------------------
function checkMaxThreshold(drillId: DrillId, value: number): ValidationResult {
  const { maxThreshold } = GATE_THRESHOLDS[drillId];

  if (value > maxThreshold) {
    return {
      valid:        false,
      gate:         'above_max_threshold',
      flaggedValue: value,
      reason:
        `${drillId} value of ${value} exceeds the maximum plausible threshold ` +
        `of ${maxThreshold}. This result likely indicates a sensor malfunction, ` +
        `missed gate crossing, or data entry error.`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Gate 4 — Extraordinary Result (Manual Review Required)
//
// The result is within the technically valid range but is so exceptional that
// it should not be auto-accepted without human verification.
//
// For lower_is_better drills: value < extraordinaryFloor → below world-record pace
// For higher_is_better drills: value > extraordinaryFloor → above world-record territory
//
// Framework example (v2 §2.2.4): "40-yard dash < 4.21s = manual review."
// This does NOT discard the result — it flags it for a scout/admin to confirm.
// ---------------------------------------------------------------------------
function checkExtraordinaryResult(drillId: DrillId, value: number): ValidationResult {
  const { extraordinaryFloor } = GATE_THRESHOLDS[drillId];
  const direction = DRILL_DIRECTION[drillId];

  const isExtraordinary =
    direction === 'lower_is_better'
      ? value < extraordinaryFloor  // Faster than world-record pace
      : value > extraordinaryFloor; // Higher than world-record territory

  if (isExtraordinary) {
    return {
      valid:        false,
      gate:         'extraordinary_result',
      flaggedValue: value,
      reason:
        direction === 'lower_is_better'
          ? `${drillId} value of ${value} is faster than the world-record reference ` +
            `floor of ${extraordinaryFloor}. Result is technically possible but requires ` +
            `manual scout verification before being scored.`
          : `${drillId} value of ${value} exceeds the extraordinary result ceiling ` +
            `of ${extraordinaryFloor}. Result requires manual scout verification.`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Primary export — full 4-gate pipeline
//
// Arguments:
//   drillId    — must match a DRILL_CATALOG id ('forty', 'ten_split', etc.)
//   value      — the measured result in the drill's native unit (sec or inches)
//   reactionMs — optional reaction time in milliseconds (applies Gate 1 if provided)
//
// Returns: the first failing ValidationResult, or { valid: true } if all pass.
// ---------------------------------------------------------------------------
export function validateResult(
  drillId: DrillId,
  value:   number,
  reactionMs?: number,
): ValidationResult {
  // Gate 1 — False Start
  const g1 = checkFalseStart(drillId, reactionMs);
  if (!g1.valid) return g1;

  // Gate 2 — Below Physical Floor
  const g2 = checkPhysicalFloor(drillId, value);
  if (!g2.valid) return g2;

  // Gate 3 — Above Maximum Threshold
  const g3 = checkMaxThreshold(drillId, value);
  if (!g3.valid) return g3;

  // Gate 4 — Extraordinary Result
  const g4 = checkExtraordinaryResult(drillId, value);
  if (!g4.valid) return g4;

  return { valid: true };
}

/**
 * Run the pipeline and return a full report object with the input context attached.
 * Useful for logging, audit trails, and UI display.
 */
export function validateResultWithReport(
  drillId:    DrillId,
  value:      number,
  reactionMs?: number,
): ValidationReport {
  return {
    result:     validateResult(drillId, value, reactionMs),
    drillId,
    value,
    reactionMs,
  };
}

/**
 * Convenience: returns true only if the result is completely clean (all 4 gates pass).
 * Use validateResult() when you need to know WHICH gate fired.
 */
export function isValidResult(
  drillId:    DrillId,
  value:      number,
  reactionMs?: number,
): boolean {
  return validateResult(drillId, value, reactionMs).valid;
}
