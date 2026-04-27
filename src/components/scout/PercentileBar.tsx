/**
 * PercentileBar.tsx
 * Core Elite — Scout View
 *
 * Single-row percentile visualization. Strict dark-mode design system —
 * no light-mode fallbacks, no marketing chrome. The component renders
 * exactly three primitives: a track, a filled bar, and a tabular-nums
 * label. Layout is deterministic; the parent decides width and the bar
 * fills 100% of it. No layout-shifting animations.
 *
 * Color rule:
 *   80–100 percentile  → cyan-400  (electric — system accent)
 *   50–79              → cyan-600  (muted, still cyan family)
 *   <50                → slate-500 (de-emphasised, never red — recruiters
 *                                   see "below median," not "failed")
 */

import React, { useMemo } from 'react';

export interface PercentileBarProps {
  /** Percentile in [0, 100]. Out-of-range values are clamped. */
  percentile: number;

  /** Optional left-aligned label (drill name, metric name). */
  label?: string;

  /** Optional right-aligned raw value (e.g. "4.42s"). Shown in tabular-nums. */
  rawValue?: string;

  /** Compact mode for L2 inline expansion — drops the label row. Default false. */
  compact?: boolean;
}

const TICKS = [25, 50, 75] as const;

function fillClass(p: number): string {
  if (p >= 80) return 'bg-cyan-400';
  if (p >= 50) return 'bg-cyan-600';
  return 'bg-slate-500';
}

export function PercentileBar({ percentile, label, rawValue, compact }: PercentileBarProps) {
  // Clamp to the [0, 100] domain. NaN → 0 so the bar still paints predictably.
  const pct = useMemo(() => {
    if (!Number.isFinite(percentile)) return 0;
    if (percentile < 0)   return 0;
    if (percentile > 100) return 100;
    return percentile;
  }, [percentile]);

  return (
    <div className={compact ? 'space-y-1' : 'space-y-1.5'}>
      {/* Top row — label + raw value + percentile readout */}
      {!compact && (label || rawValue) && (
        <div className="flex items-baseline justify-between gap-3 tabular-nums">
          {label && (
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
              {label}
            </span>
          )}
          <div className="flex items-baseline gap-2 ml-auto">
            {rawValue && (
              <span className="text-xs font-mono text-slate-300 tabular-nums">
                {rawValue}
              </span>
            )}
            <span className="text-xs font-black text-cyan-400 tabular-nums w-9 text-right">
              {pct.toFixed(0)}p
            </span>
          </div>
        </div>
      )}

      {/* Track + fill */}
      <div
        className="relative h-1.5 w-full bg-slate-800/60 rounded-full overflow-hidden"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ? `${label} percentile` : 'percentile'}
      >
        {/* Quartile ticks — subtle, drawn UNDER the fill so a high bar covers them */}
        {TICKS.map((t) => (
          <span
            key={t}
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-slate-700"
            style={{ left: `${t}%` }}
          />
        ))}

        <div
          className={`absolute inset-y-0 left-0 ${fillClass(pct)} rounded-full`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Compact-mode footer line — same percentile readout but tighter */}
      {compact && (
        <div className="flex items-center justify-between text-[10px] tabular-nums">
          <span className="font-bold uppercase tracking-widest text-slate-500">
            {label}
          </span>
          <div className="flex items-baseline gap-2">
            {rawValue && <span className="font-mono text-slate-400">{rawValue}</span>}
            <span className="font-black text-cyan-400 w-9 text-right">{pct.toFixed(0)}p</span>
          </div>
        </div>
      )}
    </div>
  );
}
