import React, { useRef, useEffect, useState, useCallback } from 'react';
import SignaturePad from 'signature_pad';
import { AlertCircle, CheckCircle2, RotateCcw, Lock, ShieldCheck } from 'lucide-react';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Legal metadata captured at the moment the signer taps "Confirm Signature".
 * Stored server-side alongside the registration record for legal enforceability.
 *
 * Legal defensibility checklist:
 *   ✓ signedAt      — ISO timestamp of intentional confirm action (not page load)
 *   ✓ signerName    — echoed from the parent/guardian name field
 *   ✓ dataUrl       — base64 PNG of the drawn signature image
 *   ✓ strokeCount   — proves deliberate multi-stroke input (not a tap accident)
 *   ✓ pathLengthPx  — proves sufficient ink coverage
 *   ✓ deviceFingerprint — ties the record to a specific device session
 *   ✓ userAgent     — raw browser/OS string for forensic use
 *   IP address: captured server-side from the RPC HTTP request — not included here.
 */
export interface SignatureMetadata {
  dataUrl: string;
  signedAt: string;           // ISO 8601 — moment of confirm click
  signerName: string;         // from the form's parentName field
  strokeCount: number;        // distinct pen-down events
  pathLengthPx: number;       // total Euclidean path length (CSS pixels)
  canvasWidthPx: number;      // logical canvas width at capture time
  canvasHeightPx: number;     // logical canvas height at capture time
  deviceFingerprint: string;  // djb2 hash of UA + screen + timezone + language
  userAgent: string;          // raw navigator.userAgent
}

// ─── Component props ──────────────────────────────────────────────────────────

interface SignatureCanvasProps {
  signerName: string;
  onSave: (metadata: SignatureMetadata) => void;
  onClear?: () => void;
}

// ─── State machine ────────────────────────────────────────────────────────────

/**
 * Six-state machine:
 *
 *   empty  ──(begin stroke)──▶  drawing
 *   drawing  ──(end stroke)──▶  insufficient | thin | ready
 *   thin | ready  ──(Confirm)──▶  loading  ──▶  confirmed
 *   confirmed  ──(Re-sign confirmed)──▶  empty
 */
type SigState =
  | 'empty'        // canvas is blank
  | 'drawing'      // pen is currently down
  | 'insufficient' // pen lifted — thresholds not yet met
  | 'thin'         // meets minimum path but sparse — soft warning shown
  | 'ready'        // all thresholds met — Confirm button enabled
  | 'loading'      // Confirm clicked — awaiting frame paint + serialization
  | 'confirmed';   // signature accepted, canvas locked, receipt shown

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Total Euclidean path length floor. Rejects taps and scribbles. */
const MIN_PATH_PX = 500;

/**
 * Minimum distinct pen-down events. Ensures the signer actually wrote
 * something letter-like (not a single drag). Rejects accidents.
 */
const MIN_STROKES = 2;

/**
 * "Thin" upper bound. Signatures in the 500–720 px range technically pass
 * but are sparse enough to warrant a soft "draw more clearly" nudge.
 * The nudge is advisory — the signer can still confirm.
 */
const THIN_THRESHOLD_PX = 720;

// ─── Utilities ────────────────────────────────────────────────────────────────

function calcPathLength(pad: SignaturePad): number {
  return pad.toData().reduce((total, stroke) => {
    const pts = stroke.points;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }, 0);
}

/**
 * djb2-based device fingerprint — fast, zero dependencies, deterministic
 * within a single browser session. Not cryptographically secure, but
 * sufficient to tie a consent record to a specific device profile for
 * forensic purposes. The server captures the real IP via the RPC call.
 */
function buildDeviceFingerprint(): string {
  const raw = [
    navigator.userAgent,
    String(screen.width),
    String(screen.height),
    String(screen.colorDepth),
    String(new Date().getTimezoneOffset()),
    navigator.language,
    String(navigator.hardwareConcurrency ?? 0),
  ].join('||');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h) ^ raw.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function formatSignedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday:    'long',
    year:       'numeric',
    month:      'long',
    day:        'numeric',
    hour:       'numeric',
    minute:     '2-digit',
    timeZoneName: 'short',
  });
}

// ─── Sub-component: button config ─────────────────────────────────────────────

interface ButtonConfig {
  label: string;
  disabled: boolean;
  cls: string;
  spinner?: boolean;
}

function getButtonConfig(state: SigState): ButtonConfig {
  switch (state) {
    case 'empty':
      return {
        label:    'Sign Above to Continue',
        disabled: true,
        cls:      'bg-zinc-100 text-zinc-400 cursor-not-allowed',
      };
    case 'drawing':
      return {
        label:    'Keep Signing…',
        disabled: true,
        cls:      'bg-zinc-200 text-zinc-500 cursor-not-allowed',
      };
    case 'insufficient':
      return {
        label:    'Signature Too Short — Keep Drawing',
        disabled: true,
        cls:      'bg-zinc-100 text-zinc-400 cursor-not-allowed',
      };
    case 'thin':
    case 'ready':
      return {
        label:    'Confirm Signature',
        disabled: false,
        cls:      'bg-zinc-900 text-white hover:bg-zinc-800 active:scale-[0.98]',
      };
    case 'loading':
      return {
        label:    'Confirming…',
        disabled: true,
        cls:      'bg-zinc-700 text-white cursor-wait',
        spinner:  true,
      };
    case 'confirmed':
      return {
        label:    '✓ Signature Confirmed',
        disabled: true,
        cls:      'bg-emerald-600 text-white cursor-default',
      };
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export const SignatureCanvas: React.FC<SignatureCanvasProps> = ({
  signerName,
  onSave,
  onClear,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef    = useRef<SignaturePad | null>(null);

  const [sigState,          setSigState]          = useState<SigState>('empty');
  const [pathLength,        setPathLength]         = useState(0);
  const [strokeCount,       setStrokeCount]        = useState(0);
  const [confirmedMeta,     setConfirmedMeta]      = useState<SignatureMetadata | null>(null);
  const [showReSignConfirm, setShowReSignConfirm]  = useState(false);
  const [inlineError,       setInlineError]        = useState<string | null>(null);

  const meetsThreshold = pathLength >= MIN_PATH_PX && strokeCount >= MIN_STROKES;
  const isThin         = meetsThreshold && pathLength < THIN_THRESHOLD_PX;
  const progress       = Math.min((pathLength / MIN_PATH_PX) * 100, 100);

  // ── Canvas initialisation ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Size BEFORE SignaturePad init — prevents stale 2D context reference
    const applySize = () => {
      const dpr = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      canvas.getContext('2d')?.scale(dpr, dpr);
    };

    applySize();

    padRef.current = new SignaturePad(canvas, {
      penColor:             '#1a1a1a',
      minWidth:             1.5,
      maxWidth:             3.0,   // velocity-based width variation — natural feel
      velocityFilterWeight: 0.7,
      throttle:             0,     // every pointer event, no dropped frames
    });

    padRef.current.addEventListener('beginStroke', () => {
      setSigState('drawing');
      setInlineError(null);
    });

    padRef.current.addEventListener('endStroke', () => {
      if (!padRef.current) return;
      const len   = calcPathLength(padRef.current);
      const count = padRef.current.toData().length;
      setPathLength(len);
      setStrokeCount(count);

      const passes = len >= MIN_PATH_PX && count >= MIN_STROKES;
      if (passes) {
        setSigState(len < THIN_THRESHOLD_PX ? 'thin' : 'ready');
      } else {
        setSigState('insufficient');
      }
    });

    const handleResize = () => {
      applySize();
      padRef.current?.clear();
      resetCanvas();
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset helper ────────────────────────────────────────────────────────
  const resetCanvas = useCallback(() => {
    setPathLength(0);
    setStrokeCount(0);
    setSigState('empty');
    setInlineError(null);
    setConfirmedMeta(null);
    setShowReSignConfirm(false);
  }, []);

  // ── Clear ───────────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    padRef.current?.clear();
    resetCanvas();
    onClear?.();
  }, [onClear, resetCanvas]);

  // ── Confirm ─────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(() => {
    if (!padRef.current || padRef.current.isEmpty()) {
      setInlineError('Please draw your signature above.');
      return;
    }
    if (!meetsThreshold) {
      setInlineError(
        strokeCount < MIN_STROKES
          ? `Your signature needs at least ${MIN_STROKES} separate strokes — lift your finger between letters.`
          : 'Your signature is too short — please continue drawing.'
      );
      return;
    }

    setSigState('loading');

    // Defer one frame so the 'loading' state renders visibly before the
    // canvas is serialized (toDataURL is synchronous and can block paint).
    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas || !padRef.current) return;

      const signedAt  = new Date().toISOString();
      const meta: SignatureMetadata = {
        dataUrl:           padRef.current.toDataURL('image/png'),
        signedAt,
        signerName:        signerName.trim() || 'Unknown',
        strokeCount,
        pathLengthPx:      Math.round(pathLength),
        canvasWidthPx:     canvas.offsetWidth,
        canvasHeightPx:    canvas.offsetHeight,
        deviceFingerprint: buildDeviceFingerprint(),
        userAgent:         navigator.userAgent,
      };

      // Lock the pad — canvas becomes a static image
      padRef.current.off();

      setConfirmedMeta(meta);
      setSigState('confirmed');
      onSave(meta);
    });
  }, [meetsThreshold, strokeCount, pathLength, signerName, onSave]);

  // ── Re-sign ─────────────────────────────────────────────────────────────
  const handleReSign = useCallback(() => {
    padRef.current?.on();
    padRef.current?.clear();
    resetCanvas();
    onClear?.();
  }, [onClear, resetCanvas]);

  // ── Canvas border style ─────────────────────────────────────────────────
  const canvasBorderCls = (() => {
    switch (sigState) {
      case 'drawing':     return 'border-zinc-500 bg-white';
      case 'ready':
      case 'thin':        return 'border-emerald-400 bg-emerald-50/20';
      case 'insufficient':return 'border-amber-300 bg-amber-50/20';
      case 'confirmed':   return 'border-emerald-500 bg-emerald-50/30';
      default:            return 'border-zinc-200 bg-white';
    }
  })();

  const btn = getButtonConfig(sigState);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">

      {/* ── Pre-signature legal notice ──────────────────────────────────── */}
      {sigState !== 'confirmed' && (
        <div className="flex items-start gap-2.5 p-3.5 bg-zinc-50 border border-zinc-200 rounded-xl">
          <ShieldCheck className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-zinc-500 leading-snug">
            <strong className="text-zinc-700 font-bold">Legal Notice:</strong> By signing below,
            you confirm that you have read and agree to all terms in the Release of Liability,
            Medical Authorization, Media Release, and Data Consent sections above. This
            constitutes a legally binding agreement. If signing on behalf of a minor, you
            represent that you hold legal guardian authority over this athlete.
          </p>
        </div>
      )}

      {/* ── Signature canvas ────────────────────────────────────────────── */}
      <div
        className={`relative border-2 rounded-xl overflow-hidden transition-all duration-200 ${canvasBorderCls}`}
        style={{ minHeight: '180px' }}
      >
        {/* Placeholder */}
        {sigState === 'empty' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none gap-1.5">
            <span className="text-zinc-300 text-sm font-medium">Sign here</span>
            <span className="text-[10px] text-zinc-200">Use finger, stylus, or mouse</span>
          </div>
        )}

        {/* Confirmed lock badge */}
        {sigState === 'confirmed' && (
          <div className="absolute top-2 right-2 pointer-events-none z-10">
            <div className="flex items-center gap-1 bg-emerald-600 text-white text-[9px] font-black px-2 py-1 rounded-full uppercase tracking-wider">
              <Lock className="w-2.5 h-2.5" />
              Locked
            </div>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className="w-full touch-none block"
          style={{ minHeight: '180px' }}
          aria-label="Signature pad"
        />
      </div>

      {/* ── Stroke progress bar ─────────────────────────────────────────── */}
      {sigState !== 'empty' && sigState !== 'confirmed' && (
        <div className="space-y-1">
          <div className="h-1 bg-zinc-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-150 ${
                meetsThreshold ? 'bg-emerald-500' : 'bg-zinc-400'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Insufficient guidance — specific to which threshold is failing */}
          {sigState === 'insufficient' && (
            <p className="text-[11px] text-zinc-400 font-medium">
              {strokeCount < MIN_STROKES
                ? `Lift your finger and add ${MIN_STROKES - strokeCount} more stroke${MIN_STROKES - strokeCount !== 1 ? 's' : ''} — separate each part of your signature`
                : 'Keep signing — a few more strokes required'}
            </p>
          )}

          {/* Thin-signature advisory */}
          {isThin && (
            <p className="text-[11px] text-amber-600 font-medium">
              Your signature looks sparse. For legal clarity, consider drawing a fuller,
              more complete signature before confirming.
            </p>
          )}
        </div>
      )}

      {/* ── Inline error ────────────────────────────────────────────────── */}
      {inlineError && (
        <div className="flex items-start gap-2 text-red-600 text-xs font-bold p-2.5 bg-red-50 border border-red-200 rounded-lg">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {inlineError}
        </div>
      )}

      {/* ── Post-confirmation legal receipt ─────────────────────────────── */}
      {sigState === 'confirmed' && confirmedMeta && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-3">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="text-xs font-black uppercase tracking-wider">
              Signature Accepted
            </span>
          </div>

          <dl className="space-y-1 text-xs">
            <div className="flex gap-1.5">
              <dt className="font-bold text-emerald-800 shrink-0">Signed by:</dt>
              <dd className="text-emerald-700">{confirmedMeta.signerName}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-bold text-emerald-800 shrink-0">Timestamp:</dt>
              <dd className="text-emerald-700">{formatSignedAt(confirmedMeta.signedAt)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-bold text-emerald-800 shrink-0">Device ID:</dt>
              <dd className="text-emerald-700 font-mono tracking-tight">
                {confirmedMeta.deviceFingerprint}
              </dd>
            </div>
          </dl>

          <p className="text-[10px] text-emerald-600 leading-snug pt-2 border-t border-emerald-200">
            This record is time-stamped, device-bound, and will be stored securely alongside
            this registration. It is accessible to your league administrator and may be used
            as evidence of consent in a legal dispute.
          </p>
        </div>
      )}

      {/* ── Primary action row ──────────────────────────────────────────── */}
      {sigState !== 'confirmed' ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleClear}
            disabled={sigState === 'empty' || sigState === 'loading'}
            className="flex items-center gap-1.5 px-4 py-2.5 border border-zinc-200 text-zinc-500 rounded-xl font-medium text-sm hover:border-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Clear
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={btn.disabled}
            className={`flex-1 py-2.5 px-4 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2 ${btn.cls}`}
          >
            {btn.spinner && (
              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0" />
            )}
            {btn.label}
          </button>
        </div>
      ) : (
        // Re-sign flow — shown below the confirmed receipt
        <div className="flex justify-end">
          {!showReSignConfirm ? (
            <button
              type="button"
              onClick={() => setShowReSignConfirm(true)}
              className="text-[11px] text-zinc-400 hover:text-zinc-600 underline underline-offset-2 transition-colors"
            >
              Need to re-sign?
            </button>
          ) : (
            <div className="w-full p-3.5 bg-amber-50 border border-amber-200 rounded-xl space-y-2.5">
              <p className="text-xs font-bold text-amber-900">
                Clear your signature and re-sign?
              </p>
              <p className="text-[11px] text-amber-700">
                Your previous signature will be permanently discarded and a new one required
                before you can complete registration.
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowReSignConfirm(false)}
                  className="flex-1 py-2 border border-zinc-200 rounded-lg text-xs font-bold text-zinc-600 hover:bg-zinc-50 transition-colors"
                >
                  Keep My Signature
                </button>
                <button
                  type="button"
                  onClick={handleReSign}
                  className="flex-1 py-2 bg-amber-500 text-white rounded-lg text-xs font-bold hover:bg-amber-600 active:scale-95 transition-all"
                >
                  Clear &amp; Re-sign
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
