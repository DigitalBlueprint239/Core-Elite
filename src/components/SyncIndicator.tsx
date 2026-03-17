import React from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useOfflineSync } from '../hooks/useOfflineSync';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const SyncIndicator: React.FC = () => {
  const { isOnline, pendingCount, lastSyncTime, syncOutbox } = useOfflineSync();

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {pendingCount > 0 && (
        <div className="bg-amber-100 text-amber-800 px-3 py-1 rounded-full text-xs font-bold shadow-lg border border-amber-200 flex items-center gap-2">
          <RefreshCw className={cn("w-3 h-3", isOnline && "animate-spin")} />
          {pendingCount} Pending Sync
        </div>
      )}
      
      <button
        onClick={() => syncOutbox()}
        disabled={!isOnline}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg border transition-all",
          isOnline 
            ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" 
            : "bg-zinc-100 text-zinc-500 border-zinc-200 cursor-not-allowed"
        )}
      >
        {isOnline ? (
          <>
            <Wifi className="w-3 h-3" />
            Online
          </>
        ) : (
          <>
            <WifiOff className="w-3 h-3" />
            Offline
          </>
        )}
        {lastSyncTime && (
          <span className="opacity-60 ml-1">
            • Last sync: {lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </button>
    </div>
  );
};
