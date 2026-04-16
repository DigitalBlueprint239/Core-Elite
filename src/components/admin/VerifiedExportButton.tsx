/**
 * VerifiedExportButton.tsx
 * Core Elite — Phase 3, Target 3: College Export Trigger
 *
 * Calls the `generate-verified-export` Edge Function and automatically
 * downloads the cryptographically signed athlete profile as a JSON file.
 *
 * Auth:
 *   The Edge Function has verify_jwt = false and uses a manual secret check.
 *   This component passes the secret via the `X-Verification-Secret` header,
 *   read from `import.meta.env.VITE_VERIFICATION_SECRET`. This is an
 *   admin-only portal — the env var is never exposed to non-admin users.
 *
 * Download filename:
 *   `{athlete-name-slug}-verified-combine.json`
 *   e.g. "john-doe-verified-combine.json"
 *
 * States:
 *   idle    — default dark-slate button
 *   loading — spinner + "Exporting…" (button disabled, cursor-wait)
 *   success — green flash for 2 s, then auto-resets to idle
 *   error   — red state with inline message; resets on next click
 *
 * Props:
 *   athleteId    — UUID of the athlete (sent in request body)
 *   athleteName  — Full name used for the filename slug and aria label
 *   compact      — If true, renders as a small icon-only button suitable for
 *                  table cells. The full label is moved to the title tooltip.
 *   className    — Extra Tailwind classes applied to the root element
 */

import React, { useCallback, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Download, Loader2 } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerifiedExportButtonProps {
  /** UUID of the athlete to export */
  athleteId:   string;
  /** Full display name — used for the download filename and aria label */
  athleteName: string;
  /**
   * Compact (icon-only) variant for use inside tight table cells.
   * The full label is surfaced via the `title` tooltip attribute.
   * @default false
   */
  compact?:    boolean;
  /** Extra CSS classes applied to the root element */
  className?:  string;
}

type Phase = 'idle' | 'loading' | 'success' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts a display name into a URL/filename-safe slug. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')   // replace non-alphanumeric runs with hyphens
    .replace(/^-+|-+$/g, '');       // strip leading/trailing hyphens
}

/**
 * Creates a temporary anchor element and programmatically clicks it to
 * trigger a browser file download, then cleans up.
 * The object URL is revoked after 1 s to give the browser time to start
 * the download before the reference is freed.
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href          = url;
  a.download      = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VerifiedExportButton({
  athleteId,
  athleteName,
  compact    = false,
  className  = '',
}: VerifiedExportButtonProps) {
  const [phase,    setPhase]    = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // Holds the setTimeout handle for the 2-second success→idle auto-reset.
  // Typed as number because window.setTimeout returns a numeric ID in browsers.
  const resetTimer = useRef<number | null>(null);

  const handleClick = useCallback(async () => {
    if (phase === 'loading') return;

    // Clear any in-flight success reset so clicking during the flash doesn't
    // leave a stale success state after the new click resolves.
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }

    setPhase('loading');
    setErrorMsg('');

    // ── Read env vars ────────────────────────────────────────────────────
    const secret  = import.meta.env.VITE_VERIFICATION_SECRET as string | undefined;
    const baseUrl = import.meta.env.VITE_SUPABASE_URL        as string;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY   as string;

    if (!secret) {
      setErrorMsg('VITE_VERIFICATION_SECRET is not set in .env — see .env.example');
      setPhase('error');
      return;
    }

    try {
      // ── Call Edge Function ─────────────────────────────────────────────
      const endpoint = `${baseUrl}/functions/v1/generate-verified-export`;

      const response = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':          'application/json',
          // apikey routes the request through the Supabase gateway
          'apikey':                anonKey,
          // Custom secret satisfies the function's manual auth check
          'X-Verification-Secret': secret,
        },
        body: JSON.stringify({ athlete_id: athleteId }),
      });

      if (!response.ok) {
        // Best-effort extraction of the error detail from our standard error shape
        let detail = `HTTP ${response.status}`;
        try {
          const errBody = await response.json() as {
            error?: { code?: string; detail?: string };
            message?: string;
          };
          detail =
            errBody?.error?.detail ??
            errBody?.message        ??
            detail;
        } catch {
          // ignore JSON parse failure — keep the HTTP status message
        }
        throw new Error(detail);
      }

      // ── Parse + download ───────────────────────────────────────────────
      const payload  = await response.json();
      const filename = `${slugify(athleteName)}-verified-combine.json`;
      const blob     = new Blob(
        [JSON.stringify(payload, null, 2)],
        { type: 'application/json' },
      );
      triggerDownload(blob, filename);

      // ── Flash success for 2 s then auto-reset ──────────────────────────
      setPhase('success');
      resetTimer.current = window.setTimeout(() => {
        setPhase('idle');
        resetTimer.current = null;
      }, 2_000);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unexpected error during export';
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [phase, athleteId, athleteName]);

  // ─── Compact (icon-only) variant ─────────────────────────────────────────

  if (compact) {
    const tooltip =
      phase === 'success' ? `Downloaded! (${athleteName})`
      : phase === 'error'  ? errorMsg
      : `Download verified profile — ${athleteName}`;

    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={phase === 'loading'}
        title={tooltip}
        aria-label={`Download verified export for ${athleteName}`}
        aria-live="polite"
        className={[
          'rounded-lg p-1.5 transition-all duration-150',
          phase === 'loading'
            ? 'cursor-wait opacity-50 text-slate-400'
            : phase === 'success'
              ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
              : phase === 'error'
                ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30'
                : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
          className,
        ].filter(Boolean).join(' ')}
      >
        {phase === 'loading' ? <Loader2    className="w-3.5 h-3.5 animate-spin" /> :
         phase === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> :
         phase === 'error'   ? <AlertCircle className="w-3.5 h-3.5" /> :
                               <Download    className="w-3.5 h-3.5" />}
      </button>
    );
  }

  // ─── Full variant ─────────────────────────────────────────────────────────

  return (
    <div className={['inline-flex flex-col gap-1.5', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        onClick={handleClick}
        disabled={phase === 'loading'}
        aria-live="polite"
        className={[
          'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl',
          'text-sm font-black uppercase tracking-widest',
          'transition-all duration-150',
          phase === 'loading'
            ? 'bg-slate-700 text-slate-400 cursor-wait'
            : phase === 'success'
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/30'
              : phase === 'error'
                ? 'bg-red-950/60 border border-red-500/40 text-red-300 hover:bg-red-950/80'
                : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 hover:border-slate-600 shadow-sm',
        ].join(' ')}
      >
        {phase === 'loading' ? (
          <><Loader2     className="w-4 h-4 animate-spin" />Exporting…</>
        ) : phase === 'success' ? (
          <><CheckCircle className="w-4 h-4" />Downloaded!</>
        ) : phase === 'error' ? (
          <><AlertCircle className="w-4 h-4" />Export Failed</>
        ) : (
          <><Download    className="w-4 h-4" />Verified Export</>
        )}
      </button>

      {/* Inline error detail — only shown in full variant */}
      {phase === 'error' && errorMsg && (
        <p
          role="alert"
          className="text-[11px] leading-tight text-red-400 max-w-[240px]"
        >
          {errorMsg}
        </p>
      )}
    </div>
  );
}
