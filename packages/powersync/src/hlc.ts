/**
 * hlc.ts — Hybrid Logical Clock (framework-agnostic port)
 *
 * Mirrors the algorithm and string format of src/lib/hlc.ts (web) so that
 * timestamps generated on the React Native client and the web IndexedDB
 * outbox are byte-identical and can be compared by lexicographic ordering.
 *
 * The web HLC binds directly to localStorage; that API doesn't exist in
 * React Native. Here we decouple the algorithm from persistence via a
 * narrow StorageAdapter interface. Consumers inject:
 *
 *   - MemoryAdapter for tests / first-boot
 *   - AsyncStorageAdapter (thin wrapper over @react-native-async-storage)
 *     for mobile persistence once that package is wired
 *
 * String format (v3 §3.1.2) — identical to the web impl:
 *   {pt padded to 16 digits}_{l padded to 10 digits}_{nodeId}
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HLCComponents {
  pt:     number;
  l:      number;
  nodeId: string;
}

export interface HLCState {
  pt: number;
  l:  number;
}

/**
 * StorageAdapter — the minimum surface the HLC needs to persist.
 * We keep it sync for the hot-path tick() call; an async-backed adapter
 * can hydrate itself once at module init and write-behind asynchronously.
 */
export interface HLCStorageAdapter {
  get(): HLCState | null;
  set(state: HLCState): void;
}

export class MemoryStorageAdapter implements HLCStorageAdapter {
  private state: HLCState | null = null;
  get(): HLCState | null { return this.state; }
  set(state: HLCState): void { this.state = state; }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatHlc(pt: number, l: number, nodeId: string): string {
  return `${String(pt).padStart(16, '0')}_${String(l).padStart(10, '0')}_${nodeId}`;
}

export function parseHlc(hlcStr: string): HLCComponents {
  const parts = hlcStr.split('_');
  if (parts.length < 3) {
    throw new Error(`parseHlc: invalid format "${hlcStr}" — expected "pt_l_nodeId"`);
  }
  const pt = parseInt(parts[0], 10);
  const l  = parseInt(parts[1], 10);
  if (!Number.isFinite(pt) || !Number.isFinite(l)) {
    throw new Error(`parseHlc: non-numeric pt or l in "${hlcStr}"`);
  }
  return { pt, l, nodeId: parts.slice(2).join('_') };
}

/**
 * Lexicographic comparator. pt and l are zero-padded to fixed widths,
 * so direct string comparison gives correct temporal ordering.
 */
export function compareHlc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return  1;
  return 0;
}

export function maxHlc(a: string, b: string): string {
  return compareHlc(a, b) >= 0 ? a : b;
}

// ---------------------------------------------------------------------------
// HLC clock instance
// ---------------------------------------------------------------------------

export interface HLCClockOptions {
  nodeId:  string;
  storage?: HLCStorageAdapter;
  /** Override for Date.now() — injected in tests to freeze time. */
  now?:    () => number;
}

/**
 * HLCClock — one instance per device process. Keeps its own state in-memory
 * and mirrors writes through a StorageAdapter so the logical counter
 * survives cold starts.
 */
export class HLCClock {
  private nodeId:  string;
  private storage: HLCStorageAdapter;
  private now:     () => number;
  private state:   HLCState;

  constructor(opts: HLCClockOptions) {
    this.nodeId  = opts.nodeId;
    this.storage = opts.storage ?? new MemoryStorageAdapter();
    this.now     = opts.now ?? (() => Date.now());
    this.state   = this.storage.get() ?? { pt: 0, l: 0 };
  }

  /**
   * Advance HLC for a local write. Call exactly once per mutation.
   * Algorithm (Kulkarni & Demirbas 2014):
   *   new_pt = max(local.pt, now())
   *   new_l  = (new_pt === local.pt) ? local.l + 1 : 0
   */
  tick(): string {
    const now   = this.now();
    const newPt = Math.max(this.state.pt, now);
    const newL  = newPt === this.state.pt ? this.state.l + 1 : 0;
    this.state  = { pt: newPt, l: newL };
    this.storage.set(this.state);
    return formatHlc(newPt, newL, this.nodeId);
  }

  /**
   * Advance HLC after receiving a remote HLC string.
   * Malformed remote strings are ignored — we never corrupt local state.
   */
  update(remoteHlcStr: string): void {
    let remote: HLCComponents;
    try {
      remote = parseHlc(remoteHlcStr);
    } catch {
      return;
    }

    const now   = this.now();
    const newPt = Math.max(this.state.pt, remote.pt, now);

    let newL: number;
    if (newPt === this.state.pt && newPt === remote.pt) {
      newL = Math.max(this.state.l, remote.l) + 1;
    } else if (newPt === this.state.pt) {
      newL = this.state.l + 1;
    } else if (newPt === remote.pt) {
      newL = remote.l + 1;
    } else {
      newL = 0;
    }

    this.state = { pt: newPt, l: newL };
    this.storage.set(this.state);
  }

  /** Inspect current HLC without advancing. */
  current(): string {
    return formatHlc(this.state.pt, this.state.l, this.nodeId);
  }

  /** Current nodeId — useful for logging / diagnostics. */
  getNodeId(): string {
    return this.nodeId;
  }
}
