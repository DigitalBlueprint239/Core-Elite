/**
 * ProgressionMatrix.tsx
 * Core Elite — Mission Q.2: Progression Matrix Optimization & Lexicon Alignment
 *
 * F1-telemetry delta-track dashboard. All tier/delta calculations are memoized.
 * Positioned elements carry translateZ(0) + will-change-transform for 60fps GPU
 * compositing on mobile. Status language follows the Core Elite brand voice.
 */

import React, { useMemo } from 'react';
import { Activity, TrendingUp, Zap } from 'lucide-react';

// ─── Benchmark Data ────────────────────────────────────────────────────────────

type DrillDirection = 'lower' | 'higher';

interface Tier {
  label: string;
  value: number;
}

interface DrillBenchmark {
  drill_type: string;
  label:      string;
  unit:       string;
  precision:  number;
  direction:  DrillDirection;
  tiers:      [Tier, Tier, Tier]; // [HS Avg, FCS, Power-5]
  trackMin:   number;
  trackMax:   number;
}

interface PositionalProfile {
  label:  string;
  drills: DrillBenchmark[];
}

const POSITIONAL_BENCHMARKS: Record<string, PositionalProfile> = {
  WR: {
    label: 'Wide Receiver',
    drills: [
      {
        drill_type: 'forty', label: '40-Yard Dash', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.65 }, { label: 'FCS', value: 4.52 }, { label: 'Power-5', value: 4.42 }],
        trackMin: 4.25, trackMax: 5.00,
      },
      {
        drill_type: 'vertical', label: 'Vertical Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 31.0 }, { label: 'FCS', value: 34.5 }, { label: 'Power-5', value: 38.5 }],
        trackMin: 24, trackMax: 46,
      },
      {
        drill_type: 'shuttle_5_10_5', label: 'Pro Agility', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.45 }, { label: 'FCS', value: 4.28 }, { label: 'Power-5', value: 4.18 }],
        trackMin: 3.90, trackMax: 4.80,
      },
      {
        drill_type: 'broad', label: 'Broad Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 103 }, { label: 'FCS', value: 114 }, { label: 'Power-5', value: 122 }],
        trackMin: 88, trackMax: 134,
      },
    ],
  },

  LB: {
    label: 'Linebacker',
    drills: [
      {
        drill_type: 'forty', label: '40-Yard Dash', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.80 }, { label: 'FCS', value: 4.65 }, { label: 'Power-5', value: 4.55 }],
        trackMin: 4.35, trackMax: 5.20,
      },
      {
        drill_type: 'vertical', label: 'Vertical Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 29.0 }, { label: 'FCS', value: 32.5 }, { label: 'Power-5', value: 36.0 }],
        trackMin: 22, trackMax: 44,
      },
      {
        drill_type: 'shuttle_5_10_5', label: 'Pro Agility', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.55 }, { label: 'FCS', value: 4.38 }, { label: 'Power-5', value: 4.28 }],
        trackMin: 4.00, trackMax: 4.90,
      },
      {
        drill_type: 'broad', label: 'Broad Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 98 }, { label: 'FCS', value: 109 }, { label: 'Power-5', value: 117 }],
        trackMin: 82, trackMax: 130,
      },
    ],
  },

  DB: {
    label: 'Defensive Back',
    drills: [
      {
        drill_type: 'forty', label: '40-Yard Dash', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.62 }, { label: 'FCS', value: 4.48 }, { label: 'Power-5', value: 4.38 }],
        trackMin: 4.20, trackMax: 4.95,
      },
      {
        drill_type: 'vertical', label: 'Vertical Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 32.0 }, { label: 'FCS', value: 36.0 }, { label: 'Power-5', value: 40.0 }],
        trackMin: 26, trackMax: 48,
      },
      {
        drill_type: 'shuttle_5_10_5', label: 'Pro Agility', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.40 }, { label: 'FCS', value: 4.22 }, { label: 'Power-5', value: 4.12 }],
        trackMin: 3.85, trackMax: 4.75,
      },
      {
        drill_type: 'broad', label: 'Broad Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 106 }, { label: 'FCS', value: 117 }, { label: 'Power-5', value: 124 }],
        trackMin: 90, trackMax: 136,
      },
    ],
  },

  RB: {
    label: 'Running Back',
    drills: [
      {
        drill_type: 'forty', label: '40-Yard Dash', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.72 }, { label: 'FCS', value: 4.55 }, { label: 'Power-5', value: 4.45 }],
        trackMin: 4.28, trackMax: 5.05,
      },
      {
        drill_type: 'vertical', label: 'Vertical Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 30.0 }, { label: 'FCS', value: 33.5 }, { label: 'Power-5', value: 37.0 }],
        trackMin: 23, trackMax: 45,
      },
      {
        drill_type: 'shuttle_5_10_5', label: 'Pro Agility', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.48 }, { label: 'FCS', value: 4.32 }, { label: 'Power-5', value: 4.22 }],
        trackMin: 3.95, trackMax: 4.85,
      },
      {
        drill_type: 'broad', label: 'Broad Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 100 }, { label: 'FCS', value: 111 }, { label: 'Power-5', value: 119 }],
        trackMin: 84, trackMax: 132,
      },
    ],
  },

  OL: {
    label: 'Offensive Lineman',
    drills: [
      {
        drill_type: 'forty', label: '40-Yard Dash', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 5.45 }, { label: 'FCS', value: 5.20 }, { label: 'Power-5', value: 5.05 }],
        trackMin: 4.80, trackMax: 5.80,
      },
      {
        drill_type: 'vertical', label: 'Vertical Jump', unit: '"', precision: 1, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 24.0 }, { label: 'FCS', value: 27.0 }, { label: 'Power-5', value: 30.0 }],
        trackMin: 18, trackMax: 38,
      },
      {
        drill_type: 'shuttle_5_10_5', label: 'Pro Agility', unit: 's', precision: 2, direction: 'lower',
        tiers: [{ label: 'HS Avg', value: 4.95 }, { label: 'FCS', value: 4.72 }, { label: 'Power-5', value: 4.60 }],
        trackMin: 4.35, trackMax: 5.30,
      },
      {
        drill_type: 'bench_reps', label: 'Bench Press', unit: ' reps', precision: 0, direction: 'higher',
        tiers: [{ label: 'HS Avg', value: 14 }, { label: 'FCS', value: 22 }, { label: 'Power-5', value: 28 }],
        trackMin: 4, trackMax: 36,
      },
    ],
  },
};

const FALLBACK_POSITION = 'WR';

// ─── Physics Engine: Mass-Adjusted Benchmarks ─────────────────────────────────
// Baselines encode the archetypal bodyweight for each position cluster.
// SKILL = 180, HYBRID = 215, TRENCH = 275, QB = 200.

const POSITION_BASELINE_WEIGHT: Record<string, number> = {
  WR: 180, // SKILL
  DB: 180, // SKILL
  RB: 205, // SKILL-HYBRID
  LB: 215, // HYBRID
  OL: 275, // TRENCH
  QB: 200, // QB
};

// Per-drill penalty, per 10 lbs over baseline, in the drill's own units.
// Sign convention: value that makes the target EASIER to hit. For 'lower'
// drills (time) that means a positive shift; for 'higher' drills (distance)
// that means a negative shift. Bench rep test favors mass — modifier = 0.
const DRILL_WEIGHT_MODIFIERS: Record<string, number> = {
  forty:           0.02,   // +0.02s per 10 lbs over
  shuttle_5_10_5:  0.015,  // +0.015s per 10 lbs over
  vertical:       -0.40,   // -0.4" per 10 lbs over
  broad:          -1.00,   // -1.0" per 10 lbs over
  bench_reps:      0.00,   // neutral — 225 rep test already mass-biased
};

/**
 * Shift a benchmark target based on how far the athlete's weight deviates
 * from the positional baseline. Every 10 lbs over baseline eases the target
 * by the drill's modifier; every 10 lbs under tightens it by the same amount.
 * Returns the original value if inputs are missing.
 */
function calculateWeightAdjustedBenchmark(
  originalValue: number,
  drillType:     string,
  athleteWeight: number | undefined,
  positionKey:   string,
): number {
  if (!athleteWeight || athleteWeight <= 0) return originalValue;
  const baseline = POSITION_BASELINE_WEIGHT[positionKey];
  if (baseline === undefined) return originalValue;
  const modifier = DRILL_WEIGHT_MODIFIERS[drillType];
  if (modifier === undefined || modifier === 0) return originalValue;

  const deltaWeight = athleteWeight - baseline;
  const adjustment  = (deltaWeight / 10) * modifier;
  return originalValue + adjustment;
}

/** Apply mass adjustment to a drill's hs/fcs/p5 tier targets. */
function applyWeightModifier(
  drill:          DrillBenchmark,
  athleteWeight:  number | undefined,
  positionKey:    string,
): { drill: DrillBenchmark; maxShiftPct: number } {
  if (!athleteWeight) return { drill, maxShiftPct: 0 };

  const shifted = drill.tiers.map(t => ({
    label: t.label,
    value: calculateWeightAdjustedBenchmark(t.value, drill.drill_type, athleteWeight, positionKey),
  })) as [Tier, Tier, Tier];

  const maxShiftPct = drill.tiers.reduce((max, t, i) => {
    const delta = Math.abs(shifted[i].value - t.value) / Math.abs(t.value);
    return delta > max ? delta : max;
  }, 0);

  return {
    drill:       { ...drill, tiers: shifted },
    maxShiftPct,
  };
}

// ─── Public Types ──────────────────────────────────────────────────────────────

export interface AthleteResult {
  drill_type: string;
  value_num:  number;
}

export interface ProgressionMatrixProps {
  results:    AthleteResult[];
  position:   string;
  firstName?: string;
  /** Athlete weight in lbs. Enables the mass-adjustment physics engine. */
  weight?:    number;
}

// ─── Pure Helpers (stable references — never inline) ──────────────────────────

function bestResult(results: AthleteResult[], drillType: string, direction: DrillDirection): number | null {
  const m = results.filter(r => r.drill_type === drillType && r.value_num > 0);
  if (m.length === 0) return null;
  return direction === 'lower'
    ? Math.min(...m.map(r => r.value_num))
    : Math.max(...m.map(r => r.value_num));
}

function toPercent(value: number, min: number, max: number): number {
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** Positive = athlete beats the target. */
function computeDelta(current: number, target: number, direction: DrillDirection): number {
  return direction === 'lower' ? target - current : current - target;
}

function resolvePosition(raw: string): string {
  const upper = raw.toUpperCase().trim();
  const aliases: Record<string, string> = {
    'LINEBACKER': 'LB', 'WIDE RECEIVER': 'WR', 'CORNERBACK': 'DB',
    'SAFETY': 'DB', 'FS': 'DB', 'SS': 'DB', 'CB': 'DB',
    'RUNNING BACK': 'RB', 'HALFBACK': 'RB', 'HB': 'RB', 'FB': 'RB',
    'OFFENSIVE LINEMAN': 'OL', 'OFFENSIVE LINE': 'OL', 'OT': 'OL', 'OG': 'OL', 'C': 'OL',
    'ATH': 'WR',
  };
  return aliases[upper] ?? (POSITIONAL_BENCHMARKS[upper] ? upper : FALLBACK_POSITION);
}

// ─── TierHash ─────────────────────────────────────────────────────────────────

const TIER_COLORS = {
  hs:  { line: 'bg-zinc-700',   text: 'text-zinc-600'  },
  fcs: { line: 'bg-zinc-500',   text: 'text-zinc-400'  },
  p5:  { line: 'bg-white/60',   text: 'text-white/60'  },
} as const;

interface TierHashProps {
  pct:   number;
  label: string;
  tier:  keyof typeof TIER_COLORS;
}

function TierHash({ pct, label, tier }: TierHashProps) {
  const c = TIER_COLORS[tier];
  return (
    // translateZ(0) promotes this absolutely-positioned label to its own
    // compositor layer so it doesn't trigger main-thread repaints on scroll.
    <div
      className="absolute top-0 flex flex-col items-center will-change-transform"
      style={{ left: `${pct}%`, transform: 'translateX(-50%) translateZ(0)' }}
    >
      <div className={`w-px h-5 ${c.line}`} />
      <span className={`text-[8px] font-black uppercase tracking-widest mt-0.5 whitespace-nowrap ${c.text}`}>
        {label}
      </span>
    </div>
  );
}

// ─── DeltaTrack ───────────────────────────────────────────────────────────────

interface DeltaTrackProps {
  drill:   DrillBenchmark;
  current: number;
}

function DeltaTrack({ drill, current }: DeltaTrackProps) {
  // All calculations memoized — recomputes only when drill ref or current value changes.
  const c = useMemo(() => {
    const [hs, fcs, p5]  = drill.tiers;
    const { trackMin, trackMax, direction, unit, precision } = drill;

    const currentPct = toPercent(current,    trackMin, trackMax);
    const hsPct      = toPercent(hs.value,   trackMin, trackMax);
    const fcsPct     = toPercent(fcs.value,  trackMin, trackMax);
    const p5Pct      = toPercent(p5.value,   trackMin, trackMax);

    const deltaHS    = computeDelta(current, hs.value,  direction);
    const deltaFCS   = computeDelta(current, fcs.value, direction);
    const deltaP5    = computeDelta(current, p5.value,  direction);

    const beatHS     = deltaHS  >= 0;
    const beatFCS    = deltaFCS >= 0;
    const beatP5     = deltaP5  >= 0;

    const fmtAbs    = (d: number) => `${Math.abs(d).toFixed(precision)}${unit}`;
    const fmtSigned = (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(precision)}${unit}`;

    // ── Core Elite lexicon ────────────────────────────────────────────────
    const insightText = beatP5
      ? '> BENCHMARK CLEARED. CORE ELITE STATUS ACTIVE.'
      : beatFCS
        ? `> FCS CLEARED. MARGIN TO P5: ${fmtAbs(deltaP5)}.`
        : beatHS
          ? `> DELTA NEGATIVE. REQUIRE ${fmtAbs(deltaFCS)} TO BREACH FCS RANGE.`
          : '> SUB-BASELINE. CRITICAL OVERLOAD REQUIRED.';

    // ── Marker visual — white core + massive gold halo at CORE ELITE tier
    const markerBg   = beatP5 ? 'bg-white' : 'bg-[#c8a200]';
    const markerGlow = beatP5
      ? 'shadow-[0_0_18px_5px_rgba(200,162,0,0.75)]'   // white core, gold corona
      : beatFCS
        ? 'shadow-[0_0_10px_3px_rgba(200,162,0,0.50)]'
        : 'shadow-[0_0_6px_2px_rgba(200,162,0,0.20)]';

    return {
      currentPct, hsPct, fcsPct, p5Pct,
      deltaHS, deltaFCS, deltaP5,
      beatHS, beatFCS, beatP5,
      insightText, markerBg, markerGlow,
      hs, fcs, p5, fmtSigned,
    };
  }, [drill, current]);

  return (
    <div className="space-y-2">
      {/* Tier hash labels — sit above the rail */}
      <div className="relative h-5 mt-6">
        <TierHash pct={c.hsPct}  label="HS AVG" tier="hs"  />
        <TierHash pct={c.fcsPct} label="FCS"    tier="fcs" />
        <TierHash pct={c.p5Pct}  label="P5"     tier="p5"  />
      </div>

      {/* Rail */}
      <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-visible">
        {/* Gradient fill — GPU-promoted, width is the only changing property */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-zinc-700 to-[#c8a200]/60 will-change-transform"
          style={{ width: `${c.currentPct}%`, transform: 'translateZ(0)' }}
        />

        {/* Tier tick marks on rail */}
        {([c.hsPct, c.fcsPct, c.p5Pct] as const).map((pct, i) => (
          <div
            key={i}
            className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-zinc-600"
            style={{ left: `${pct}%` }}
          />
        ))}

        {/* Athlete marker — GPU-composited, translateZ forces its own layer */}
        <div
          className={`absolute top-1/2 w-3 h-3 rounded-full border-2 border-zinc-950 z-10 will-change-transform ${c.markerBg} ${c.markerGlow}`}
          style={{ left: `${c.currentPct}%`, transform: 'translateX(-50%) translateY(-50%) translateZ(0)' }}
        />
      </div>

      {/* Delta chips — one per tier */}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {([
          { tier: c.hs,  delta: c.deltaHS,  key: 'hs'  },
          { tier: c.fcs, delta: c.deltaFCS, key: 'fcs' },
          { tier: c.p5,  delta: c.deltaP5,  key: 'p5'  },
        ] as const).map(({ tier, delta, key }) => {
          const beat = delta >= 0;
          return (
            <div
              key={key}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-mono ${
                beat
                  ? 'border-emerald-800/50 bg-emerald-950/40'
                  : 'border-zinc-800 bg-zinc-950'
              }`}
            >
              <span className="text-[9px] uppercase tracking-widest text-zinc-600">{tier.label}</span>
              <span className={`font-black ${beat ? 'text-emerald-400' : 'text-zinc-400'}`}>
                Δ {c.fmtSigned(delta)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Insight line */}
      <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest leading-relaxed pt-0.5">
        {c.insightText}
      </p>
    </div>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

interface MetricCardProps {
  drill:   DrillBenchmark;
  current: number;
  index:   number;
}

function MetricCard({ drill, current, index }: MetricCardProps) {
  // Status tier + all visual classes memoized — stable until current changes.
  const status = useMemo(() => {
    const [hs, fcs, p5] = drill.tiers;
    const { direction }  = drill;

    const beatHS  = computeDelta(current, hs.value,  direction) >= 0;
    const beatFCS = computeDelta(current, fcs.value, direction) >= 0;
    const beatP5  = computeDelta(current, p5.value,  direction) >= 0;

    if (beatP5) return {
      label:        '[ CORE ELITE ]',
      badgeCls:     'text-white border-white/40 bg-white/5',
      cardBorder:   'border-[#c8a200]/30',   // gold border upgrade
      accentCls:    'bg-[#c8a200]/8',
      isCoreElite:  true,
    };
    if (beatFCS) return {
      label:        '[ P5 PROSPECT ]',
      badgeCls:     'text-[#c8a200] border-[#c8a200]/30 bg-[#c8a200]/5',
      cardBorder:   'border-white/5',
      accentCls:    'bg-[#c8a200]/4',
      isCoreElite:  false,
    };
    if (beatHS) return {
      label:        '[ FCS TRACK ]',
      badgeCls:     'text-zinc-400 border-zinc-700 bg-zinc-900/80',
      cardBorder:   'border-white/5',
      accentCls:    'bg-[#c8a200]/2',
      isCoreElite:  false,
    };
    return {
      label:        '[ DEVELOPMENTAL ]',
      badgeCls:     'text-zinc-600 border-zinc-800 bg-zinc-950/60',
      cardBorder:   'border-white/5',
      accentCls:    'bg-transparent',
      isCoreElite:  false,
    };
  }, [drill, current]);

  return (
    // transform-gpu creates a compositing layer for backdrop-blur-md, preventing
    // the blur from being recalculated on every scroll frame.
    <div
      className={`relative bg-zinc-900/50 backdrop-blur-md border ${status.cardBorder} rounded-2xl p-5 overflow-hidden transform-gpu`}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Ambient corner glow — intensifies at CORE ELITE */}
      <div className={`absolute top-0 right-0 w-28 h-28 rounded-full blur-2xl pointer-events-none ${status.accentCls}`} />

      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-600 mb-1">
            {drill.label}
          </p>
          <p className="text-3xl font-mono font-black text-white tabular-nums leading-none">
            {current.toFixed(drill.precision)}
            <span className="text-lg text-zinc-500 ml-1">{drill.unit}</span>
          </p>
        </div>
        <span className={`text-[9px] font-black font-mono uppercase tracking-widest px-2 py-1 rounded border whitespace-nowrap mt-1 ${status.badgeCls}`}>
          {status.label}
        </span>
      </div>

      <DeltaTrack drill={drill} current={current} />
    </div>
  );
}

// ─── NullMetricCard ───────────────────────────────────────────────────────────
// Rendered when a positional drill has no telemetry. Deliberately flat —
// no backdrop-blur, no gradient, no glow — so missing data reads as an
// "awaiting scan" state rather than broken UI.

interface NullMetricCardProps {
  drill: DrillBenchmark;
  index: number;
}

function NullMetricCard({ drill, index }: NullMetricCardProps) {
  return (
    <div
      className="relative bg-zinc-900/20 border border-zinc-800/50 rounded-2xl p-5 overflow-hidden"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.25em] text-zinc-700 mb-1">
            {drill.label}
          </p>
          <p className="text-4xl font-mono font-black text-zinc-700 tabular-nums leading-none">
            [ -- ]
          </p>
        </div>
        <span className="text-[9px] font-black font-mono uppercase tracking-widest px-2 py-1 rounded border whitespace-nowrap mt-1 text-zinc-600 border-zinc-800 bg-zinc-950/40">
          [ SENSOR NULL ]
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-zinc-900/60" />

      <p className="text-[10px] text-zinc-700 font-mono uppercase tracking-widest leading-relaxed pt-6">
        {`> TELEMETRY MISSING. SCAN REQUIRED AT NEXT COMBINE.`}
      </p>
    </div>
  );
}

// ─── ProgressionMatrix (root) ─────────────────────────────────────────────────

const MASS_ADJUSTMENT_THRESHOLD = 0.02;

export default function ProgressionMatrix({ results, position, firstName, weight }: ProgressionMatrixProps) {
  const posKey  = useMemo(() => resolvePosition(position), [position]);
  const profile = POSITIONAL_BENCHMARKS[posKey] ?? POSITIONAL_BENCHMARKS[FALLBACK_POSITION];

  // Mass-adjust each drill's tier targets before they ever reach the UI.
  const { cards, massAdjusted } = useMemo(() => {
    let anyOverThreshold = false;
    const cards = profile.drills.map(originalDrill => {
      const { drill: adjustedDrill, maxShiftPct } = applyWeightModifier(originalDrill, weight, posKey);
      if (maxShiftPct > MASS_ADJUSTMENT_THRESHOLD) anyOverThreshold = true;
      const current = bestResult(results, adjustedDrill.drill_type, adjustedDrill.direction);
      return { drill: adjustedDrill, current };
    });
    return { cards, massAdjusted: anyOverThreshold };
  }, [profile, results, weight, posKey]);

  const activeCards = useMemo(
    () => cards.filter((c): c is { drill: DrillBenchmark; current: number } => c.current !== null),
    [cards],
  );

  const p5Count  = useMemo(() =>
    activeCards.filter(c => computeDelta(c.current, c.drill.tiers[2].value, c.drill.direction) >= 0).length,
  [activeCards]);

  const fcsCount = useMemo(() =>
    activeCards.filter(c => computeDelta(c.current, c.drill.tiers[1].value, c.drill.direction) >= 0).length,
  [activeCards]);

  if (activeCards.length === 0) {
    return (
      <div className="bg-zinc-900/50 backdrop-blur-md border border-white/5 rounded-2xl p-10 text-center transform-gpu">
        <Activity className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
        <p className="text-zinc-600 text-xs font-mono uppercase tracking-widest">
          No benchmark metrics on record.
        </p>
        <p className="text-zinc-700 text-[10px] font-mono mt-1">
          Complete a verified combine to initialize progression matrix.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 mb-1 flex-wrap">
            <div className="p-1.5 bg-[#c8a200]/10 border border-[#c8a200]/20 rounded-lg">
              <Zap className="w-4 h-4 text-[#c8a200]" />
            </div>
            <h2 className="text-sm font-black uppercase tracking-[0.15em] text-white">
              Progression Matrix
            </h2>
            {massAdjusted && (
              <span className="text-[9px] font-black font-mono uppercase tracking-widest px-2 py-0.5 rounded border text-[#c8a200] border-[#c8a200]/30 bg-[#c8a200]/5">
                [ MASS ADJUSTED ]
              </span>
            )}
          </div>
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-zinc-600">
            {profile.label} · {activeCards.length}/{cards.length} metric{cards.length !== 1 ? 's' : ''} on record
          </p>
        </div>

        {/* Summary pills */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 border border-white/10 rounded-xl">
            <TrendingUp className="w-3.5 h-3.5 text-white/40" />
            <span className="text-[10px] font-black font-mono text-white/60 uppercase tracking-widest">
              {p5Count}/{activeCards.length} P5
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#c8a200]/5 border border-[#c8a200]/20 rounded-xl">
            <span className="w-1.5 h-1.5 rounded-full bg-[#c8a200]" />
            <span className="text-[10px] font-black font-mono text-[#c8a200] uppercase tracking-widest">
              {fcsCount}/{activeCards.length} FCS
            </span>
          </div>
        </div>
      </div>

      {/* Telemetry headline */}
      {firstName && (
        <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-600 border-l-2 border-[#c8a200]/40 pl-3">
          {`> ${firstName.toUpperCase()} — LIVE TELEMETRY VS. POSITIONAL D1 THRESHOLDS`}
        </p>
      )}

      {/* Bento grid — renders null cards for missing drills so the layout stays whole */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cards.map(({ drill, current }, i) =>
          current === null
            ? <NullMetricCard key={drill.drill_type} drill={drill} index={i} />
            : <MetricCard     key={drill.drill_type} drill={drill} current={current} index={i} />
        )}
      </div>

      {/* Track legend */}
      <div className="flex items-center gap-4 flex-wrap px-1 pt-1">
        <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-700">Legend:</p>
        {([
          { color: 'bg-[#c8a200]', label: 'Current score',  glow: 'shadow-[0_0_6px_1px_rgba(200,162,0,0.4)]' },
          { color: 'bg-zinc-700',  label: 'HS Avg',          glow: '' },
          { color: 'bg-zinc-500',  label: 'FCS target',      glow: '' },
          { color: 'bg-white/60',  label: 'Power-5 target',  glow: '' },
        ] as const).map(({ color, label, glow }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${color} ${glow}`} />
            <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
