import React from 'react';

export function SkeletonCard() {
  return (
    <div className="p-6 bg-white rounded-3xl border border-zinc-200 shadow-sm animate-pulse">
      <div className="h-4 bg-zinc-200 rounded w-1/3 mb-4" />
      <div className="h-8 bg-zinc-200 rounded w-1/2 mb-2" />
      <div className="h-3 bg-zinc-100 rounded w-2/3" />
    </div>
  );
}

export function SkeletonTable() {
  return (
    <div className="bg-white rounded-3xl border border-zinc-200 overflow-hidden animate-pulse">
      <div className="px-6 py-4 border-b border-zinc-100">
        <div className="h-4 bg-zinc-200 rounded w-1/4" />
      </div>
      {[...Array(5)].map((_, i) => (
        <div key={i} className="px-6 py-4 border-b border-zinc-50 flex items-center gap-4">
          <div className="w-8 h-8 bg-zinc-200 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-zinc-200 rounded w-2/5" />
            <div className="h-2 bg-zinc-100 rounded w-1/4" />
          </div>
          <div className="h-3 bg-zinc-200 rounded w-16" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonHeader() {
  return (
    <div className="animate-pulse space-y-3 mb-6">
      <div className="h-6 bg-zinc-200 rounded w-1/3" />
      <div className="h-4 bg-zinc-100 rounded w-1/2" />
    </div>
  );
}

export function SkeletonResultCard() {
  return (
    <div className="bg-white p-4 rounded-2xl border border-zinc-200 shadow-sm animate-pulse flex items-center justify-between">
      <div className="space-y-2">
        <div className="h-2 bg-zinc-200 rounded w-16" />
        <div className="h-5 bg-zinc-200 rounded w-20" />
      </div>
      <div className="h-3 bg-zinc-100 rounded w-12" />
    </div>
  );
}
