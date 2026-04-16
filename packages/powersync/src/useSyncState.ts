/**
 * useSyncState
 *
 * Minimal sync status hook for call sites that only need to know:
 *   - isOnline: boolean — is PowerSync currently connected to the server?
 *   - pendingUploadCount: number — how many records are queued for upload?
 *
 * This is the hook to import in the top-level offline banner and anywhere
 * a simple "N pending" badge is shown. For the full operator interface
 * (dead-letter management, duplicate challenges, force-retry), use useSync().
 *
 * Implementation notes:
 *   isOnline is sourced from PowerSync's connection status, NOT navigator.onLine.
 *   PowerSync's status.connected reflects actual WebSocket connectivity to the
 *   sync service, which is a more accurate signal than the browser's online API.
 *   (navigator.onLine returns true on captive portals and local-network scenarios
 *   where sync is actually failing.)
 *
 *   pendingUploadCount counts rows in outbox_meta with status IN ('pending',
 *   'retrying'). This excludes dead_letter (operator must force-retry) and
 *   pending_review (parked for duplicate resolution) — those require attention,
 *   not just connectivity.
 *
 *   Polling interval: 2s. Short enough to feel responsive on reconnect without
 *   hammering SQLite. PowerSync has no native callback for "outbox changed" on
 *   the web SDK; polling is the standard approach.
 */

import { useEffect, useState } from 'react';
import { usePowerSync, useStatus } from '@powersync/react';

export interface SyncStateResult {
  /** True when PowerSync WebSocket is connected to the sync service. */
  isOnline: boolean;
  /**
   * Count of records in the local outbox queued for upload.
   * Does NOT include dead-letter or pending-review items.
   * Use useSync() to access and manage those.
   */
  pendingUploadCount: number;
}

export function useSyncState(): SyncStateResult {
  const db     = usePowerSync();
  const status = useStatus();

  const [pendingUploadCount, setPendingUploadCount] = useState(0);

  useEffect(() => {
    if (!db) return;

    let cancelled = false;

    const refresh = async () => {
      try {
        const rows = await db.getAll<{ c: number }>(`
          SELECT COUNT(*) AS c
          FROM outbox_meta
          WHERE status IN ('pending', 'retrying')
        `);
        if (!cancelled) {
          setPendingUploadCount(rows[0]?.c ?? 0);
        }
      } catch {
        // SQLite not yet ready — silently ignore; next tick will retry
      }
    };

    refresh();
    const id = setInterval(refresh, 2000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [db]);

  return {
    isOnline:           status.connected,
    pendingUploadCount,
  };
}
