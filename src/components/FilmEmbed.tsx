/**
 * FilmEmbed.tsx
 * Core Elite — Mission R: Film Fusion
 *
 * Renders a scouted athlete's highlight reel inside the Scout View. Covers
 * three states:
 *   1. No URL on record             → premium "awaiting scan" empty state
 *   2. URL present but unrecognized → soft empty state + open-in-new-tab link
 *   3. Recognized URL               → responsive 16:9 iframe
 *
 * The empty state is deliberately not styled as an error — the founder spec
 * treats "no film" as the median case, not a failure.
 */

import React, { useMemo } from 'react';
import { Video, ExternalLink, PlayCircle } from 'lucide-react';
import { parseFilmUrl, type FilmEmbed as FilmEmbedDescriptor } from '../lib/hudl';

export interface FilmEmbedProps {
  /** Raw film URL as stored in profiles.film_url. Null / undefined / empty → empty state. */
  filmUrl?: string | null;
  /** Optional label shown over the video (e.g. athlete name). */
  title?:  string;
}

const providerLabel: Record<FilmEmbedDescriptor['provider'], string> = {
  hudl:    'HUDL',
  youtube: 'YOUTUBE',
  vimeo:   'VIMEO',
};

export default function FilmEmbed({ filmUrl, title }: FilmEmbedProps) {
  const parsed = useMemo(() => parseFilmUrl(filmUrl), [filmUrl]);

  // ─── State 1: no URL on record ─────────────────────────────────────────────
  if (!filmUrl || !filmUrl.trim()) {
    return (
      <div className="relative h-full min-h-[360px] bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden flex items-center justify-center p-8">
        {/* Subtle scan-grid backdrop so the empty state reads as instrumentation, not error */}
        <div
          className="absolute inset-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div className="relative flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="p-5 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl">
            <Video className="w-10 h-10 text-zinc-700" strokeWidth={1.25} />
          </div>
          <p className="text-[11px] font-mono uppercase tracking-[0.25em] text-zinc-500 leading-relaxed">
            {`> NO FILM LINKED. EVALUATION INCOMPLETE.`}
          </p>
          <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-700">
            HIGHLIGHT REEL PENDING ATHLETE UPLOAD
          </p>
        </div>
      </div>
    );
  }

  // ─── State 2: URL exists but can't be parsed into an embed ─────────────────
  if (!parsed) {
    return (
      <div className="relative h-full min-h-[360px] bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden flex items-center justify-center p-8">
        <div className="relative flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="p-5 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl">
            <PlayCircle className="w-10 h-10 text-zinc-600" strokeWidth={1.25} />
          </div>
          <p className="text-[11px] font-mono uppercase tracking-[0.25em] text-zinc-500 leading-relaxed">
            {`> UNSUPPORTED PROVIDER. DIRECT LINK ONLY.`}
          </p>
          <a
            href={filmUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#c8a200]/10 border border-[#c8a200]/30 text-[#c8a200] rounded-lg text-[10px] font-black font-mono uppercase tracking-widest hover:bg-[#c8a200]/20 transition-colors"
          >
            Open External
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    );
  }

  // ─── State 3: playable embed ───────────────────────────────────────────────
  return (
    <div className="relative h-full min-h-[360px] bg-zinc-950 border border-zinc-900 rounded-2xl overflow-hidden flex flex-col">
      {/* Header strip — identifies provider + offers break-out link */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-900 backdrop-blur-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#c8a200] animate-pulse" />
          <span className="text-[9px] font-black font-mono uppercase tracking-widest text-zinc-400 shrink-0">
            FILM · {providerLabel[parsed.provider]}
          </span>
          {title && (
            <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-600 truncate">
              · {title}
            </span>
          )}
        </div>
        <a
          href={parsed.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 flex items-center gap-1 text-[9px] font-black font-mono uppercase tracking-widest text-zinc-500 hover:text-[#c8a200] transition-colors"
          aria-label="Open film in new tab"
        >
          Source
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* Responsive 16:9 iframe. aspect-video keeps it cinematic on every width. */}
      <div className="relative flex-1 aspect-video bg-black">
        <iframe
          src={parsed.embedUrl}
          title={title ? `Highlight film — ${title}` : 'Highlight film'}
          className="absolute inset-0 w-full h-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
    </div>
  );
}
