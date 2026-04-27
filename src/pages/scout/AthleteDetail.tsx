/**
 * AthleteDetail.tsx
 * Core Elite — Scout View · L3 (full report)
 *
 * The terminal disclosure level. Reached from L2's "OPEN REPORT →" link
 * at /scout/athletes/:id. Shows the athlete's complete biomechanical
 * record:
 *
 *   - Identity strip (name, band, position, composite)
 *   - Per-drill percentile bars with raw values
 *   - Mechanical disparity callouts (Morin 2015 horizontal-GRF ratio)
 *   - Embedded film via FilmEmbed (Mission R)
 *
 * Strict dark-mode design system. No light fallbacks. No marketing
 * copy. Every metric column is tabular-nums for vertical alignment.
 *
 * Data path mirrors the leaderboard's local-first cache: a module-level
 * Map keyed by athlete id provides instant warm-paint on revisit; a
 * background Supabase fetch hydrates fresh data and writes through.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Sparkles, Trophy } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import {
  detectMechanicalDisparity,
  getPercentiles,
  type DisparityResult,
  type DrillId,
  type PercentileResult,
  type Position,
} from '../../lib/scoring';
import { PercentileBar } from '../../components/scout/PercentileBar';
import FilmEmbed from '../../components/FilmEmbed';

// ---------------------------------------------------------------------------
// Types + cache
// ---------------------------------------------------------------------------

interface AthleteDetailData {
  id:           string;
  first_name:   string;
  last_name:    string;
  position:     Position;
  band_number:  number | null;
  film_url:     string | null;
  drills:       PercentileResult[];      // ordered as fetched
  composite:    number;
  disparity:    DisparityResult | null;
  fetchedAt:    number;
}

const _athleteCache = new Map<string, AthleteDetailData>();

// ---------------------------------------------------------------------------
// Drill metadata — same shape as the Leaderboard but kept local so the
// two files don't import a shared scout-internal helper. The set is small
// enough that DRY costs more than it saves.
// ---------------------------------------------------------------------------

const DRILL_ORDER: readonly DrillId[] = [
  'forty', 'ten_split', 'shuttle_5_10_5', 'vertical', 'broad',
] as const;

const DRILL_LABELS: Record<DrillId, string> = {
  forty:           '40 YARD',
  ten_split:       '10 SPLIT',
  shuttle_5_10_5:  '5-10-5 SHUTTLE',
  vertical:        'VERTICAL',
  broad:           'BROAD JUMP',
};

const DRILL_UNIT: Record<DrillId, 's' | 'in'> = {
  forty:           's',
  ten_split:       's',
  shuttle_5_10_5:  's',
  vertical:        'in',
  broad:           'in',
};

const DRILL_LOWER_IS_BETTER: Record<DrillId, boolean> = {
  forty:           true,
  ten_split:       true,
  shuttle_5_10_5:  true,
  vertical:        false,
  broad:           false,
};

const POSITIONS: readonly Position[] = [
  'QB', 'WR', 'RB', 'TE', 'OL', 'DL', 'LB', 'DB', 'K', 'P',
];

function isPosition(p: string): p is Position {
  return (POSITIONS as readonly string[]).includes(p);
}

function isDrillId(d: string): d is DrillId {
  return (DRILL_ORDER as readonly string[]).includes(d);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

interface RawAthleteDetail {
  id:          string;
  first_name:  string;
  last_name:   string;
  position:    string;
  film_url:    string | null;
  bands:       { display_number: number | null } | null;
  results:     Array<{ drill_type: string; value_num: number }> | null;
}

async function fetchAthleteDetail(id: string): Promise<AthleteDetailData> {
  const { data, error } = await supabase
    .from('athletes')
    .select(
      'id, first_name, last_name, position, film_url, ' +
      'bands(display_number), ' +
      'results(drill_type, value_num)',
    )
    .eq('id', id)
    .single<RawAthleteDetail>();

  if (error)  throw error;
  if (!data)  throw new Error('Athlete not found');

  if (!isPosition(data.position)) {
    throw new Error(`Unknown position "${data.position}"`);
  }

  // Best raw value per drill — direction-aware.
  const best: Partial<Record<DrillId, number>> = {};
  for (const r of data.results ?? []) {
    if (!isDrillId(r.drill_type)) continue;
    const v = Number(r.value_num);
    if (!Number.isFinite(v)) continue;
    const lower = DRILL_LOWER_IS_BETTER[r.drill_type];
    const prev  = best[r.drill_type];
    if (prev === undefined) best[r.drill_type] = v;
    else best[r.drill_type] = lower ? Math.min(prev, v) : Math.max(prev, v);
  }

  const measurements = (Object.keys(best) as DrillId[]).map((drillId) => ({
    drillId,
    value: best[drillId] as number,
  }));

  const drills = getPercentiles(measurements, data.position);

  // Composite = mean of the percentiles we have evidence for.
  const composite = drills.length === 0
    ? 0
    : drills.reduce((s, d) => s + d.percentile, 0) / drills.length;

  // Mechanical disparity — Morin 2015. Requires 10-yard split + vertical.
  const ten  = drills.find((d) => d.drillId === 'ten_split');
  const vert = drills.find((d) => d.drillId === 'vertical');
  const disparity = (ten && vert)
    ? detectMechanicalDisparity(ten.percentile, vert.percentile)
    : null;

  return {
    id:           data.id,
    first_name:   data.first_name,
    last_name:    data.last_name,
    position:     data.position,
    band_number:  data.bands?.display_number ?? null,
    film_url:     data.film_url,
    drills,
    composite,
    disparity,
    fetchedAt:    Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AthleteDetail() {
  const { id } = useParams<{ id: string }>();
  const initial = useMemo(() => (id ? _athleteCache.get(id) ?? null : null), [id]);

  const [data,    setData]    = useState<AthleteDetailData | null>(initial);
  const [loading, setLoading] = useState<boolean>(initial == null);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError('Missing athlete id.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const fresh = await fetchAthleteDetail(id);
        if (cancelled) return;
        _athleteCache.set(id, fresh);
        setData(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load athlete.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      {/* Sticky glassmorphism header */}
      <div className="sticky top-0 z-30 backdrop-blur-md bg-slate-900/80 border-b border-slate-700/50">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center gap-4">
          <Link
            to="/scout/leaderboard"
            className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-slate-400 hover:text-cyan-400 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            BOARD
          </Link>
          <div className="h-4 w-px bg-slate-700" />
          <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-slate-500">
            FULL REPORT
          </span>
          <div className="ml-auto flex items-center gap-2 tabular-nums">
            {data?.fetchedAt != null && (
              <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                {new Date(data.fetchedAt).toLocaleTimeString()}
              </span>
            )}
            {loading && (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-cyan-400">
                <Sparkles className="w-3 h-3 animate-pulse" />
                hydrating
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-6 space-y-5">
        {error && (
          <div className="p-3 rounded-lg border border-red-500/30 bg-red-500/5 text-red-200 text-xs font-mono">
            {error}
          </div>
        )}

        {data && (
          <>
            <IdentityStrip data={data} />
            <DrillsCard drills={data.drills} />
            {data.disparity && <DisparityCard disparity={data.disparity} />}
            <FilmCard filmUrl={data.film_url} title={`${data.first_name} ${data.last_name}`} />
          </>
        )}

        {!data && !error && loading && <DetailSkeleton />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdentityStrip — name, position, band, composite. tabular-nums on metrics.
// ---------------------------------------------------------------------------

function IdentityStrip({ data }: { data: AthleteDetailData }) {
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-5 flex items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-2xl font-black tracking-tight text-slate-100">
            <span className="text-slate-400 font-medium">{data.first_name} </span>
            {data.last_name.toUpperCase()}
          </h2>
          <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">
            {data.position}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-slate-500 tabular-nums">
          {data.band_number != null && <span>BAND #{data.band_number}</span>}
          <span>{data.drills.length} DRILL{data.drills.length === 1 ? '' : 'S'}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 tabular-nums">
        <Trophy className="w-4 h-4 text-cyan-400" />
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-black text-cyan-400">{data.composite.toFixed(0)}</span>
          <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">COMPOSITE</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DrillsCard — full per-drill percentile bars with raw values
// ---------------------------------------------------------------------------

function DrillsCard({ drills }: { drills: PercentileResult[] }) {
  // Reorder per DRILL_ORDER for visual consistency, dropping anything
  // we don't have evidence for.
  const ordered = DRILL_ORDER
    .map((drillId) => drills.find((d) => d.drillId === drillId))
    .filter((d): d is PercentileResult => d != null);

  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 backdrop-blur-md bg-slate-900/80 flex items-center justify-between">
        <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">
          BIOMECHANICAL TRACE
        </span>
        <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500 tabular-nums">
          {ordered.length} / {DRILL_ORDER.length}
        </span>
      </div>

      <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {ordered.map((d) => (
          <PercentileBar
            key={d.drillId}
            label={DRILL_LABELS[d.drillId]}
            percentile={d.percentile}
            rawValue={`${d.value.toFixed(2)}${DRILL_UNIT[d.drillId]}`}
          />
        ))}

        {ordered.length === 0 && (
          <div className="col-span-full text-center text-[10px] font-mono uppercase tracking-widest text-slate-600 py-6">
            no drill data
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DisparityCard — Morin 2015 horizontal-GRF ratio callout
// ---------------------------------------------------------------------------

function DisparityCard({ disparity }: { disparity: DisparityResult }) {
  if (!disparity.detected) {
    return (
      <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 p-4">
        <div className="flex items-baseline justify-between gap-3 tabular-nums">
          <span className="text-[11px] font-black uppercase tracking-[0.3em] text-slate-400">
            MECHANICAL DISPARITY
          </span>
          <span className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
            BALANCED · Δ{disparity.gap.toFixed(0)}p
          </span>
        </div>
      </div>
    );
  }

  // Direction names match the v2 §2.3.1 corpus exactly — see disparity.ts.
  const directionLabel: Record<DisparityResult['direction'], string> = {
    none:                         'BALANCED',
    acceleration_exceeds_power:   'ACCELERATION DOMINANT',
    power_exceeds_acceleration:   'POWER DOMINANT',
  };

  return (
    <div className="rounded-2xl border border-cyan-400/40 bg-cyan-400/5 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="shrink-0 w-4 h-4 mt-0.5 text-cyan-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3 tabular-nums">
            <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">
              MECHANICAL DISPARITY · {directionLabel[disparity.direction]}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-300">
              Δ {disparity.gap.toFixed(0)}p
            </span>
          </div>
          <p className="mt-2 text-xs font-mono text-slate-300 tabular-nums">
            10-YD {disparity.tenYardPercentile.toFixed(0)}p · VERT {disparity.verticalPercentile.toFixed(0)}p
          </p>
          <p className="mt-1 text-[11px] text-slate-400 leading-relaxed">
            Per Morin (2015), a {'>'} 20-percentile gap between horizontal-GRF
            (10-yd split) and vertical-GRF (vertical jump) indicates a
            specific force-application asymmetry. Plan training to address
            the under-developed direction.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilmCard — wraps FilmEmbed in the same dark bento as everything else
// ---------------------------------------------------------------------------

function FilmCard({ filmUrl, title }: { filmUrl: string | null; title: string }) {
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/60 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-700/50 backdrop-blur-md bg-slate-900/80">
        <span className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-400">
          FILM
        </span>
      </div>
      <div className="p-5">
        <FilmEmbed filmUrl={filmUrl} title={title} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton — geometry-stable so the warm + cold paths are visually identical
// ---------------------------------------------------------------------------

function DetailSkeleton() {
  return (
    <>
      <div className="h-24 rounded-2xl border border-slate-700/50 bg-slate-900/40" aria-hidden />
      <div className="h-64 rounded-2xl border border-slate-700/50 bg-slate-900/40" aria-hidden />
      <div className="h-16 rounded-2xl border border-slate-700/50 bg-slate-900/40" aria-hidden />
      <div className="h-72 rounded-2xl border border-slate-700/50 bg-slate-900/40" aria-hidden />
    </>
  );
}
