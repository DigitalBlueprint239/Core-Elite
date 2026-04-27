/**
 * qrIdentity.ts
 * Core Elite — Mission Y: QR Identity Matrix
 *
 * Framework-agnostic core for the athlete check-in flow. The RN view
 * components (AthleteQRCard, ScannerMode) live in ../components/ and
 * delegate every non-trivial decision to the helpers below. This file
 * has zero React / React Native imports so it compiles under
 * `npm run lint:mobile` and is directly unit-testable in vitest.
 *
 * Pipeline:
 *   athlete profile  → encodeAthleteQRPayload(uuid)  → QR pixels
 *   operator scan    → parseAthleteQR(text)          → uuid (or error)
 *                    → lookupAthleteForArm(uuid)     → athlete record
 *                    → sink.arm(athlete)             → upcoming laser trip
 *
 * UUID validation:
 *   The Supabase auth.users primary key is a Postgres UUID v4. We accept
 *   any RFC-4122 hex-and-hyphens UUID (case-insensitive). Strict v4 check
 *   (variant 8/9/a/b, version 4) is on by default; strictV4=false relaxes
 *   to RFC-4122 generic for forward compat with future Supabase schemes.
 */

// ---------------------------------------------------------------------------
// QR payload encoding
// ---------------------------------------------------------------------------

/**
 * QR_PREFIX — opaque magic bytes that prefix every Core Elite QR.
 *
 * Why a prefix and not a bare UUID:
 *   - A scanner mid-event may pick up rogue QRs (vendor name tags, parking
 *     stubs, the back of a Coca-Cola can). Requiring the prefix lets us
 *     reject non-Core-Elite codes without leaking that to the operator UI
 *     (no pop-up flash for every accidental scan).
 *   - A future schema migration (signed payload, expiry, etc.) is a
 *     prefix-version bump, not a flag day.
 */
export const QR_PREFIX  = 'CE1:' as const;
export const QR_VERSION = 1      as const;

const UUID_RFC4122_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUUID(s: string, strictV4 = true): boolean {
  if (typeof s !== 'string') return false;
  return strictV4 ? UUID_V4_RE.test(s) : UUID_RFC4122_RE.test(s);
}

/**
 * encodeAthleteQRPayload — stringify a UUID into the canonical QR payload.
 * The result is what AthleteQRCard's `value` prop receives.
 */
export function encodeAthleteQRPayload(uuid: string): string {
  if (!isUUID(uuid, /* strictV4 */ false)) {
    throw new Error(`encodeAthleteQRPayload: not a UUID — "${uuid}"`);
  }
  return `${QR_PREFIX}${uuid.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Scanner side — payload parsing
// ---------------------------------------------------------------------------

export type ParseFailureReason =
  | 'empty'
  | 'wrong_prefix'
  | 'not_uuid';

export type ParseResult =
  | { ok: true;  uuid: string }
  | { ok: false; reason: ParseFailureReason; raw: string };

/**
 * parseAthleteQR — turn a raw QR string into a normalised UUID.
 *
 * Tolerant of:
 *   - leading/trailing whitespace
 *   - mixed case (Supabase emits lowercase but operators may print bold)
 *
 * Strict about:
 *   - the QR_PREFIX magic bytes (never silently accepts a bare UUID;
 *     that closes the door on operator confusion when an athlete shows
 *     a UUID copy-pasted from a screenshot rather than the real card)
 *   - UUID format — must be RFC-4122 (v1-v5 all accepted; v4 is what
 *     Supabase emits but we don't gate on it for forward compat)
 */
export function parseAthleteQR(raw: string): ParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty', raw: String(raw) };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty', raw };

  if (!trimmed.startsWith(QR_PREFIX)) {
    return { ok: false, reason: 'wrong_prefix', raw };
  }

  const uuid = trimmed.slice(QR_PREFIX.length).toLowerCase();
  if (!isUUID(uuid, /* strictV4 */ false)) {
    return { ok: false, reason: 'not_uuid', raw };
  }

  return { ok: true, uuid };
}

// ---------------------------------------------------------------------------
// Athlete lookup — pluggable cache adapter
// ---------------------------------------------------------------------------

/**
 * Minimal athlete shape required to "arm" a station for the upcoming
 * laser trip. The local PowerSync/SQLite cache (and the web IndexedDB
 * outbox) both store more fields than this; we only need name + position
 * for the arm UI confirmation.
 */
export interface ArmedAthlete {
  id:         string;        // Supabase auth.users UUID
  first_name: string;
  last_name:  string;
  position:   string | null;
  band_number?: number | null;
}

/**
 * AthleteCache — read-only adapter over whatever local store the host
 * happens to use. The RN app injects a PowerSync-backed implementation;
 * tests inject an in-memory implementation; the web could theoretically
 * inject an IndexedDB-backed one.
 *
 * Sync vs async: PowerSync's typed query API returns Promises, so the
 * adapter is async. The arm pipeline awaits internally — the operator
 * UI shows a spinner during the cache hit (typically <30ms on iPad).
 */
export interface AthleteCache {
  byId(uuid: string): Promise<ArmedAthlete | null>;
}

/** In-memory cache for tests + dev harnesses. */
export class MemoryAthleteCache implements AthleteCache {
  constructor(private readonly rows: ArmedAthlete[]) {}
  async byId(uuid: string): Promise<ArmedAthlete | null> {
    const lower = uuid.toLowerCase();
    return this.rows.find((r) => r.id.toLowerCase() === lower) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Arm sink — the bridge between scanner and laser-trip pipeline
// ---------------------------------------------------------------------------

/**
 * The scanner doesn't know what "arming" means in the host app — it
 * only knows it scanned an athlete. The host wires an ArmedAthleteSink
 * that decides what to do (set local state, dispatch redux, write to
 * `active_session_id` in PowerSync, fire haptic, etc.).
 */
export interface ArmedAthleteSink {
  arm(athlete: ArmedAthlete): void | Promise<void>;
}

/** In-memory sink used by tests and the dev harness. */
export class MemoryArmedAthleteSink implements ArmedAthleteSink {
  readonly history: ArmedAthlete[] = [];
  arm(athlete: ArmedAthlete): void {
    this.history.push(athlete);
  }
  get current(): ArmedAthlete | null {
    return this.history[this.history.length - 1] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Top-level arm pipeline — what the scanner's onScan handler calls
// ---------------------------------------------------------------------------

export type ArmFailureReason = ParseFailureReason | 'not_in_cache';

export type ArmResult =
  | { ok: true;  athlete: ArmedAthlete }
  | { ok: false; reason: ArmFailureReason; raw: string };

/**
 * armFromScan — full scan-to-arm pipeline.
 *
 *   raw QR text  →  parse  →  cache lookup  →  sink.arm()
 *
 * Returns success/failure synchronously after awaiting the cache. The
 * RN scanner uses this directly inside its useCodeScanner callback so
 * that one function covers every error path the operator can hit.
 */
export async function armFromScan(
  raw: string,
  cache: AthleteCache,
  sink: ArmedAthleteSink,
): Promise<ArmResult> {
  const parsed = parseAthleteQR(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, raw };
  }

  const athlete = await cache.byId(parsed.uuid);
  if (!athlete) {
    return { ok: false, reason: 'not_in_cache', raw };
  }

  await sink.arm(athlete);
  return { ok: true, athlete };
}

// ---------------------------------------------------------------------------
// Scan debouncer — the camera library fires the same code dozens of times
// per second while it's in frame. We dedupe identical reads inside the
// debounce window so a single steady scan produces exactly one arm event.
// ---------------------------------------------------------------------------

export interface ScanDebouncerOptions {
  /** ms during which a repeated identical scan is suppressed. */
  windowMs?: number;
  /** Override Date.now() — for tests only. */
  now?:     () => number;
}

export class ScanDebouncer {
  private readonly windowMs: number;
  private readonly now:      () => number;
  private last: { value: string; at: number } | null = null;

  constructor(opts: ScanDebouncerOptions = {}) {
    this.windowMs = opts.windowMs ?? 1500;
    this.now      = opts.now      ?? (() => Date.now());
  }

  /** Returns true if the scan should be processed; false if it's a dup. */
  shouldProcess(raw: string): boolean {
    const t = this.now();
    if (this.last && this.last.value === raw && t - this.last.at < this.windowMs) {
      return false;
    }
    this.last = { value: raw, at: t };
    return true;
  }

  reset(): void { this.last = null; }
}
