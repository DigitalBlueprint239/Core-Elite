import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  useOfflineSync,
  type DuplicateChallenge,
} from '../hooks/useOfflineSync';

// ---------------------------------------------------------------------------
// SyncProvider — singleton owner of the offline-sync background loop.
//
// Why this exists:
//   useOfflineSync() owns a 30s setInterval, two window event listeners
//   (online/offline), and an in-flight re-entrancy ref. When two components
//   call the hook (e.g. <SyncIndicator/> in App.tsx AND <StationMode/> in a
//   route), TWO independent intervals fire — and each interval's syncOutbox
//   uses its OWN isSyncingRef. The lock from one instance does not block the
//   other, so both can drain the IndexedDB outbox concurrently and race the
//   per-item retry_count and dead_letter status updates.
//
//   By moving the sole invocation here and exposing it via context, every
//   consumer (SyncIndicator, StationMode, future callers) reads the same
//   pendingCount, the same lastSyncTime, the same duplicateChallenges queue,
//   and — crucially — shares the same in-flight lock.
//
// What this exposes:
//   - The full surface of useOfflineSync() (so existing destructures keep
//     working: isOnline, pendingCount, requiresForceSync, lastSyncTime,
//     syncOutbox, forceSync, updatePendingCount, duplicateChallenges,
//     resolveDuplicateChallenge).
//   - Two additional pieces required by the Mission spec:
//       isSyncing — true while a sync round-trip is mid-flight. Tracked as
//                   provider-local state by wrapping syncOutbox/forceSync;
//                   the hook's internal isSyncingRef is non-reactive (a ref)
//                   and can't be observed from React.
//       error     — the last error message captured from a sync invocation,
//                   or null. Cleared when the next sync starts.
// ---------------------------------------------------------------------------

export interface SyncContextValue {
  isOnline:                  boolean;
  pendingCount:              number;
  requiresForceSync:         number;
  lastSyncTime:              Date | null;
  isSyncing:                 boolean;
  error:                     string | null;
  syncOutbox:                () => Promise<void>;
  forceSync:                 (id?: string) => Promise<void>;
  updatePendingCount:        () => Promise<void>;
  duplicateChallenges:       DuplicateChallenge[];
  resolveDuplicateChallenge: (
    itemId: string,
    resolution: 'keep_both' | 'replace' | 'discard',
  ) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const sync = useOfflineSync();
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Wrap syncOutbox so the provider can publish in-flight + last-error
  // state. The underlying hook still owns the re-entrancy lock — this
  // wrapper only mirrors its observable shape into React state.
  const syncOutbox = useCallback(async () => {
    setIsSyncing(true);
    setError(null);
    try {
      await sync.syncOutbox();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSyncing(false);
    }
  }, [sync.syncOutbox]);

  const forceSync = useCallback(async (id?: string) => {
    setIsSyncing(true);
    setError(null);
    try {
      await sync.forceSync(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSyncing(false);
    }
  }, [sync.forceSync]);

  const value = useMemo<SyncContextValue>(() => ({
    isOnline:                  sync.isOnline,
    pendingCount:              sync.pendingCount,
    requiresForceSync:         sync.requiresForceSync,
    lastSyncTime:              sync.lastSyncTime,
    isSyncing,
    error,
    syncOutbox,
    forceSync,
    updatePendingCount:        sync.updatePendingCount,
    duplicateChallenges:       sync.duplicateChallenges,
    resolveDuplicateChallenge: sync.resolveDuplicateChallenge,
  }), [
    sync.isOnline,
    sync.pendingCount,
    sync.requiresForceSync,
    sync.lastSyncTime,
    isSyncing,
    error,
    syncOutbox,
    forceSync,
    sync.updatePendingCount,
    sync.duplicateChallenges,
    sync.resolveDuplicateChallenge,
  ]);

  return (
    <SyncContext.Provider value={value}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncContext(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (ctx === null) {
    throw new Error(
      'useSyncContext must be used inside <SyncProvider>. ' +
      'Mount the provider near the top of App.tsx so a single sync ' +
      'interval owns the outbox for the whole tab.',
    );
  }
  return ctx;
}
