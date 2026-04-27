/**
 * AthleteScoutView.tsx
 * Core Elite — Mission R: Film Fusion
 *
 * The D1 Scout's single-glance evaluation surface. Two panes in a dark-mode
 * bento grid:
 *   LEFT  — ProgressionMatrix (telemetry vs. positional D1 thresholds)
 *   RIGHT — FilmEmbed         (highlight reel or "NO FILM LINKED" state)
 *
 * Film is optional (founder directive), so the right pane is designed to feel
 * intentional when empty — not broken.
 */

import React from 'react';
import { Radar, Film } from 'lucide-react';
import ProgressionMatrix, { type AthleteResult } from './ProgressionMatrix';
import FilmEmbed from './FilmEmbed';

export interface AthleteScoutViewProps {
  athlete: {
    first_name:  string;
    last_name:   string;
    position:    string;
    grade?:      string | null;
    high_school?: string | null;
    weight_lb?:  number | null;
    film_url?:   string | null;
  };
  results: AthleteResult[];
}

export default function AthleteScoutView({ athlete, results }: AthleteScoutViewProps) {
  const fullName     = `${athlete.first_name} ${athlete.last_name}`.trim();
  const subtitleBits = [
    athlete.position,
    athlete.grade  ? `GR ${athlete.grade}`               : null,
    athlete.weight_lb ? `${athlete.weight_lb} LB`        : null,
    athlete.high_school ?? null,
  ].filter(Boolean);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Ambient backdrop — fixed, cheap, GPU-composited */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage: 'radial-gradient(circle at 25% 20%, rgba(200,162,0,0.5) 0%, transparent 45%), radial-gradient(circle at 80% 80%, rgba(255,255,255,0.25) 0%, transparent 45%)',
        }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* ─── Header ────────────────────────────────────────────────────── */}
        <header className="flex items-end justify-between gap-6 flex-wrap pb-6 border-b border-zinc-900">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#c8a200] animate-pulse" />
              <span className="text-[9px] font-black font-mono uppercase tracking-[0.3em] text-[#c8a200]">
                SCOUT VIEW · LIVE
              </span>
            </div>
            <h1 className="text-4xl sm:text-5xl font-black uppercase italic tracking-tighter truncate">
              {fullName}
            </h1>
            {subtitleBits.length > 0 && (
              <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-zinc-500">
                {subtitleBits.join('  ·  ')}
              </p>
            )}
          </div>

          {/* Pane legend — telegraphs the split-pane grammar */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl">
              <Radar className="w-3.5 h-3.5 text-[#c8a200]" />
              <span className="text-[10px] font-black font-mono text-zinc-400 uppercase tracking-widest">Telemetry</span>
            </span>
            <span className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl">
              <Film className="w-3.5 h-3.5 text-[#c8a200]" />
              <span className="text-[10px] font-black font-mono text-zinc-400 uppercase tracking-widest">Film</span>
            </span>
          </div>
        </header>

        {/* ─── Bento split-pane ─────────────────────────────────────────── */}
        {/* lg:items-start so a tall right-pane iframe doesn't inflate the left column */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">

          {/* LEFT: Progression Matrix — 3/5 of the grid on large screens */}
          <section className="lg:col-span-3 relative bg-zinc-950/70 border border-zinc-900 rounded-3xl p-5 sm:p-6">
            <ProgressionMatrix
              results={results}
              position={athlete.position}
              firstName={athlete.first_name}
              weight={athlete.weight_lb ?? undefined}
            />
          </section>

          {/* RIGHT: Film — 2/5 on large, sticks to viewport while scrolling the matrix */}
          <section className="lg:col-span-2 lg:sticky lg:top-6">
            <FilmEmbed filmUrl={athlete.film_url} title={fullName} />
          </section>
        </div>

        {/* ─── Footer strip — scout lexicon ─────────────────────────────── */}
        <footer className="pt-4 border-t border-zinc-900">
          <p className="text-[9px] font-mono uppercase tracking-[0.25em] text-zinc-700">
            {`> CORE ELITE SCOUT VIEW · ${athlete.film_url ? 'FILM LINKED' : 'FILM OPTIONAL — EVALUATION PENDING REEL'}`}
          </p>
        </footer>
      </div>
    </div>
  );
}
