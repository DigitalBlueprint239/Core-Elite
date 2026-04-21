import React from 'react';
import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';

interface PlanGateProps {
  active: boolean;
  children: React.ReactNode;
  label?: string;
  upgradeHref?: string;
}

export function PlanGate({ active, children, label = 'Athlete Pro', upgradeHref = '/pricing' }: PlanGateProps) {
  if (active) return <>{children}</>;

  return (
    <span className="relative inline-flex items-center">
      <span className="blur-sm pointer-events-none select-none" aria-hidden="true">
        {children}
      </span>
      <Link
        to={upgradeHref}
        className="absolute inset-0 flex items-center justify-center"
        aria-label={`Upgrade to ${label} to unlock`}
      >
        <span className="flex items-center gap-1 px-2 py-0.5 bg-zinc-900 text-white rounded-full text-[9px] font-black uppercase tracking-widest hover:bg-zinc-700 transition-colors whitespace-nowrap shadow-lg">
          <Lock className="w-2.5 h-2.5" />
          {label}
        </span>
      </Link>
    </span>
  );
}
