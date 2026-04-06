/**
 * Z-Score Percentile Analytics Engine
 * Normative data from Gillen et al. 2019, n=7,214 youth football combine athletes.
 *
 * normCDF uses Abramowitz & Stegun 26.2.17 polynomial approximation (max error ±7.5×10^-8).
 */

import { DRILL_CATALOG } from '../constants';

// ---------------------------------------------------------------------------
// Normative population data (Gillen et al. 2019)
// ---------------------------------------------------------------------------
const AGGREGATE_NORMS: Record<string, { mean: number; sd: number; n: number }> = {
  forty:          { mean: 5.3,  sd: 0.4,  n: 7077 },
  ten_split:      { mean: 1.9,  sd: 0.2,  n: 6975 },
  shuttle_5_10_5: { mean: 4.6,  sd: 0.3,  n: 7055 },
  three_cone:     { mean: 7.9,  sd: 0.6,  n: 6344 },
  vertical:       { mean: 25.2, sd: 4.3,  n: 7031 },
  broad:          { mean: 96.9, sd: 10.6, n: 7066 },
};

// ---------------------------------------------------------------------------
// Drills where a lower value is better (time-based)
// ---------------------------------------------------------------------------
const LOWER_IS_BETTER = new Set(['forty', 'ten_split', 'shuttle_5_10_5', 'three_cone']);

// ---------------------------------------------------------------------------
// normCDF — standard normal cumulative distribution function
// Abramowitz & Stegun 26.2.17 polynomial approximation, max error ±7.5×10^-8
// ---------------------------------------------------------------------------
function normCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const p = 1 - phi * poly;
  return z >= 0 ? p : 1 - p;
}

// ---------------------------------------------------------------------------
// calculatePercentile
// Returns a clamped percentile 1–99, or null if drillId is not in norms.
// ---------------------------------------------------------------------------
export function calculatePercentile(value: number, drillId: string): number | null {
  const norm = AGGREGATE_NORMS[drillId];
  if (!norm) return null;

  const z = (value - norm.mean) / norm.sd;

  // For time drills, a faster (lower) value is better — invert the z-score.
  const drill = DRILL_CATALOG.find(d => d.id === drillId);
  const lowerIsBetter = drill ? LOWER_IS_BETTER.has(drill.id) : false;
  const adjustedZ = lowerIsBetter ? -z : z;

  const pct = normCDF(adjustedZ) * 100;
  return Math.min(99, Math.max(1, Math.round(pct)));
}

// ---------------------------------------------------------------------------
// gradeFromPercentile
// ---------------------------------------------------------------------------
export function gradeFromPercentile(p: number): string {
  if (p >= 95) return 'Elite';
  if (p >= 75) return 'Above Average';
  if (p >= 50) return 'Average';
  if (p >= 25) return 'Below Average';
  return 'Developmental';
}

// ---------------------------------------------------------------------------
// Grade → Tailwind color classes (badge styling)
// ---------------------------------------------------------------------------
export function gradeColor(grade: string): string {
  switch (grade) {
    case 'Elite':         return 'bg-amber-100 text-amber-800 border border-amber-200';
    case 'Above Average': return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
    case 'Average':       return 'bg-blue-100 text-blue-800 border border-blue-200';
    case 'Below Average': return 'bg-amber-50 text-amber-700 border border-amber-100';
    default:              return 'bg-zinc-100 text-zinc-600 border border-zinc-200';
  }
}
