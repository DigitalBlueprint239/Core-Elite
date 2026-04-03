/**
 * scoring/disparity.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * Mechanical Disparity Detection — v2 §2.3.1
 *
 * Scientific basis:
 *   Morin et al. 2015 (Frontiers in Physiology):
 *     Sprint acceleration performance is determined by the ratio of horizontal
 *     to total ground reaction force (GRF), Rₑ.
 *     Elite sprinters:     Rₑ ≈ 0.40–0.50
 *     Non-elite sprinters: Rₑ ≈ 0.25–0.35
 *
 *   Without force plates at a combine, the proxy for Rₑ quality is:
 *     Compare the athlete's 10-yard split percentile (horizontal acceleration)
 *     against their vertical jump percentile (raw power output).
 *
 *   A >20 percentile point gap where vertical_pct > ten_split_pct indicates:
 *     The athlete has the raw power but is failing to express it horizontally
 *     in the first 3–5 steps — the mechanical signature of suboptimal GRF orientation.
 *
 * Phase-based 40-yard decomposition:
 *   Brown/Vescovi/VanHeest three-phase model (v2 §2.3.2):
 *     Phase 1 — Initial Acceleration  (0–10 yd):  GRF orientation, first-step mechanics
 *     Phase 2 — Middle Acceleration   (10–20 yd): Transition to upright, frequency stabilization
 *     Phase 3 — Metabolic-Stiffness   (20–40 yd): Contact time reduction, leg stiffness
 */

import { DISPARITY_THRESHOLD_PCT_POINTS } from './constants';

// ---------------------------------------------------------------------------
// Mechanical Disparity Detection
// ---------------------------------------------------------------------------

export type DisparityDirection =
  | 'power_exceeds_acceleration' // vertical_pct > ten_split_pct by >20pts — primary case
  | 'acceleration_exceeds_power' // ten_split_pct > vertical_pct by >20pts — secondary case
  | 'none';                       // gap ≤ 20pts — no significant disparity

export interface DisparityResult {
  detected:            boolean;
  tenYardPercentile:   number;
  verticalPercentile:  number;
  gap:                 number;           // Absolute percentile point difference (always ≥ 0)
  direction:           DisparityDirection;
  // Non-null when detected. Contains the exact language from the framework (v2 §2.3.1).
  message:             string | null;
  // The mechanical hypothesis — what is likely wrong and what to train
  coachingCue:         string | null;
}

/**
 * Detect mechanical disparity between sprint acceleration and vertical power.
 *
 * Arguments:
 *   tenYardPercentile  — percentile from getPercentile('ten_split', ...)
 *   verticalPercentile — percentile from getPercentile('vertical', ...)
 *
 * The framework specifies detectMechanicalDisparity() as a named function (v2 §2.3.1),
 * so we use that name exactly.
 */
export function detectMechanicalDisparity(
  tenYardPercentile:  number,
  verticalPercentile: number,
): DisparityResult {
  const gap = Math.abs(tenYardPercentile - verticalPercentile);

  if (gap <= DISPARITY_THRESHOLD_PCT_POINTS) {
    return {
      detected:           false,
      tenYardPercentile,
      verticalPercentile,
      gap,
      direction:          'none',
      message:            null,
      coachingCue:        null,
    };
  }

  // Primary case (most common and most actionable):
  //   Vertical power significantly exceeds sprint acceleration.
  //   The athlete has power but isn't converting it horizontally in the drive phase.
  if (verticalPercentile > tenYardPercentile) {
    const message =
      `Mechanical disparity detected — acceleration technique may need improvement. ` +
      `Vertical power (${verticalPercentile}th percentile) significantly exceeds ` +
      `sprint acceleration (${tenYardPercentile}th percentile), suggesting suboptimal ` +
      `horizontal force application in the first 3–5 steps.`;

    const coachingCue =
      `Athlete demonstrates sufficient power output (vertical jump) but appears ` +
      `to be applying force too vertically in the acceleration phase. ` +
      `Horizontal GRF ratio (Rₑ) is likely below 0.35 (non-elite range per Morin 2015). ` +
      `Recommended focus: forward lean, shin angle, horizontal impulse in the drive phase. ` +
      `Consider: sled pulls, A-march progressions, acceleration mechanics coaching.`;

    return {
      detected: true,
      tenYardPercentile,
      verticalPercentile,
      gap,
      direction:   'power_exceeds_acceleration',
      message,
      coachingCue,
    };
  }

  // Secondary case:
  //   Sprint acceleration significantly exceeds vertical power.
  //   Athlete is an efficient accelerator relative to their power output — less common,
  //   less concerning, but suggests potential ceiling on top-end speed development.
  const message =
    `Mechanical disparity detected — sprint acceleration (${tenYardPercentile}th percentile) ` +
    `significantly exceeds vertical power output (${verticalPercentile}th percentile). ` +
    `Athlete is an efficient accelerator but may have limited raw power reserves ` +
    `for further speed development.`;

  const coachingCue =
    `Athlete shows strong drive-phase mechanics relative to their power output. ` +
    `To develop higher absolute speed, prioritize lower-body power development: ` +
    `trap bar deadlifts, depth drops, reactive strength index training.`;

  return {
    detected: true,
    tenYardPercentile,
    verticalPercentile,
    gap,
    direction:   'acceleration_exceeds_power',
    message,
    coachingCue,
  };
}

// ---------------------------------------------------------------------------
// Phase-Based 40-Yard Decomposition — v2 §2.3.2
//
// Brown/Vescovi/VanHeest three-phase model
// ---------------------------------------------------------------------------

export interface PhaseTime {
  phase:       'initial_acceleration' | 'middle_acceleration' | 'metabolic_stiffness';
  label:       string;
  distanceYds: string;       // e.g. "0–10"
  time:        number | null; // phase duration in seconds (null if not derivable)
  description: string;        // what this phase tests
}

export interface PhaseDecompositionResult {
  phases:  PhaseTime[];
  flags:   PhaseFlag[];
  available: boolean; // false if insufficient splits to compute any phases
}

export interface PhaseFlag {
  phase:   PhaseTime['phase'];
  message: string;
}

/**
 * Decompose a 40-yard dash time into its three biomechanical phases.
 *
 * Arguments:
 *   split10yd — 10-yard split time (seconds) — enables Phase 1
 *   split20yd — 20-yard split time (seconds) — enables Phase 2 boundary
 *   total40yd — 40-yard total time (seconds) — enables Phase 3 when split20yd is available
 *
 * Returns null for any phase where the necessary splits are not available.
 */
export function decompose40Yard(
  split10yd?: number,
  split20yd?: number,
  total40yd?: number,
): PhaseDecompositionResult {
  const phase1Time: number | null = split10yd ?? null;

  const phase2Time: number | null =
    split20yd !== undefined && split10yd !== undefined
      ? split20yd - split10yd
      : null;

  const phase3Time: number | null =
    total40yd !== undefined && split20yd !== undefined
      ? total40yd - split20yd
      : null;

  const available = phase1Time !== null || phase2Time !== null || phase3Time !== null;

  const phases: PhaseTime[] = [
    {
      phase:       'initial_acceleration',
      label:       'Initial Acceleration',
      distanceYds: '0–10',
      time:        phase1Time,
      description: 'GRF orientation, first-step mechanics, drive-phase posture',
    },
    {
      phase:       'middle_acceleration',
      label:       'Middle Acceleration',
      distanceYds: '10–20',
      time:        phase2Time,
      description: 'Transition to upright, stride frequency stabilization',
    },
    {
      phase:       'metabolic_stiffness',
      label:       'Metabolic-Stiffness',
      distanceYds: '20–40',
      time:        phase3Time,
      description: 'Contact time reduction, leg stiffness, neuromuscular RFD limits',
    },
  ];

  const flags: PhaseFlag[] = [];

  // Flag: metabolic-stiffness weakness
  // If phase 3 is available and disproportionately slow relative to the total time,
  // the athlete's top-end speed is likely contact-time limited.
  if (phase3Time !== null && total40yd !== null && total40yd > 0) {
    const phase3Fraction = phase3Time / total40yd;
    // Phase 3 covers 50% of the distance (20/40 yd). Elite athletes run it in ~50–55%
    // of total time. Above ~60% suggests metabolic-stiffness limitation.
    if (phase3Fraction > 0.60) {
      flags.push({
        phase:   'metabolic_stiffness',
        message:
          `Metabolic-stiffness phase weakness: athlete's top-end speed is constrained ` +
          `by ground contact time. At max velocity, neuromuscular RFD limits force ` +
          `production within the ~100ms contact window (v2 §2.3.2). ` +
          `Phase 3 represents ${(phase3Fraction * 100).toFixed(1)}% of total 40-yard time ` +
          `(elite threshold: ~55%). Recommend reactive strength training, depth drops, ` +
          `and contact-time drills.`,
      });
    }
  }

  // Flag: initial acceleration relative weakness
  // If we have both phases and phase 1 is relatively slow vs phase 2
  if (phase1Time !== null && phase2Time !== null) {
    // Phase 1 covers 10yd, phase 2 covers 10yd. Phase 1 should be slower
    // (athlete is starting from rest), but the ratio matters.
    const accelerationRatio = phase2Time / phase1Time;
    // Below ~0.70: athlete accelerates well then decelerates — transition issue
    // Above ~0.95: athlete barely accelerated — first-step mechanics issue
    if (phase1Time > 0 && accelerationRatio > 0.92) {
      flags.push({
        phase:   'initial_acceleration',
        message:
          `First-step acceleration appears limited: transition from initial to middle ` +
          `acceleration shows minimal speed gain (phase ratio ${accelerationRatio.toFixed(2)}). ` +
          `Review first-step mechanics, starting stance, and drive-phase shin angle.`,
      });
    }
  }

  return { phases, flags, available };
}
