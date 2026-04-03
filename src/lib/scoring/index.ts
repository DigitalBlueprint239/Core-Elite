/**
 * scoring/index.ts
 * Core Elite — Phase 3: Scout's Intuition Engine
 *
 * Public API surface for the BES scoring module.
 *
 * Import pattern for consumers:
 *   import { computeBES, validateResult, detectMechanicalDisparity } from '../lib/scoring';
 *
 * This module is intentionally pure (no side effects, no I/O, no DOM access).
 * All functions are deterministic given the same inputs.
 * Safe to call in tests, SSR, or Web Workers.
 */

// ---------------------------------------------------------------------------
// Constants & types — normative data, drill IDs, thresholds, weights
// ---------------------------------------------------------------------------
export type {
  DrillId,
  ScoreDirection,
  Position,
  Grade,
  NormativeStats,
  GateThresholds,
  BESBandLabel,
} from './constants';

export {
  GILLEN_AGGREGATE_NORMS,
  GATE_THRESHOLDS,
  BES_WEIGHTS,
  BES_BANDS,
  BES_ELIGIBLE_DRILLS,
  DRILL_DIRECTION,
  DISPARITY_THRESHOLD_PCT_POINTS,
  FALSE_START_FLOOR_MS,
  REACTION_TIME_APPLICABLE,
} from './constants';

// ---------------------------------------------------------------------------
// 4-Gate validation pipeline — v2 §2.2.4
// ---------------------------------------------------------------------------
export type {
  GateType,
  ValidationResult,
  ValidationReport,
} from './validation';

export {
  validateResult,
  validateResultWithReport,
  isValidResult,
} from './validation';

// ---------------------------------------------------------------------------
// Z-Score Percentile Engine — Abramowitz & Stegun CDF, A&S 26.2.17
// ---------------------------------------------------------------------------
export type {
  NormSource,
  NormLookupResult,
  PercentileResult,
} from './percentile';

export {
  normalCDF,       // A&S CDF — exposed for testing and custom use
  computeZ,
  zToPercentile,
  lookupNorm,
  getPercentile,
  getPercentiles,
} from './percentile';

// ---------------------------------------------------------------------------
// Mechanical disparity detection — v2 §2.3.1
// Phase-based 40-yard decomposition — v2 §2.3.2
// ---------------------------------------------------------------------------
export type {
  DisparityDirection,
  DisparityResult,
  PhaseTime,
  PhaseFlag,
  PhaseDecompositionResult,
} from './disparity';

export {
  detectMechanicalDisparity,
  decompose40Yard,
} from './disparity';

// ---------------------------------------------------------------------------
// Composite BES score — primary consumer entry point
// ---------------------------------------------------------------------------
export type {
  BESDrillInput,
  BESComponentScore,
  BESResult,
} from './bes';

export {
  computeBES,
  quickPercentile,
} from './bes';
