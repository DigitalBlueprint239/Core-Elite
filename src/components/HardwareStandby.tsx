import React, { useState, useEffect, useRef } from 'react';
import { Radio, Wifi } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  key: string;
  label: string;
  value: string;
  color: 'green' | 'amber' | 'null' | 'red' | 'scan';
}

type SweepPhase = 'standby' | 'sweep';

// ─── Constants ────────────────────────────────────────────────────────────────

const STANDBY_LOG: LogEntry[] = [
  { key: 'gateway', label: 'SYS.GATEWAY',  value: 'ONLINE',         color: 'green' },
  { key: 'ble',     label: 'BLE.RECEIVER', value: 'LISTENING',      color: 'green' },
  { key: 'dashr',   label: 'DASHR.NODES',  value: '0/12 CONNECTED', color: 'amber' },
  { key: 'event',   label: 'EVENT.ID',     value: 'NULL',           color: 'null'  },
];

const SWEEP_LOG: LogEntry[] = [
  { key: 'gateway', label: 'SYS.GATEWAY',  value: 'ONLINE',         color: 'green' },
  { key: 'ble',     label: 'BLE.RECEIVER', value: 'BROADCASTING',   color: 'scan'  },
  { key: 'dashr',   label: 'DASHR.NODES',  value: 'PINGING...',     color: 'scan'  },
  { key: 'event',   label: 'EVENT.ID',     value: 'SCANNING',       color: 'scan'  },
];

const SWEEP_SEQUENCE = [
  '> INITIATING SWEEP PROTOCOL...',
  '> PINGING MAC ADDRESSES...',
  '> BROADCAST INTERVAL: 37ms',
  '> NODES FOUND: 0',
  '> RETURNING TO STANDBY...',
] as const;

const VALUE_COLOR: Record<LogEntry['color'], string> = {
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  null:  'text-zinc-700',
  red:   'text-red-400',
  scan:  'text-[#c8a200] animate-pulse',
};

// Ghost BLE node positions (percentage of radar container)
const GHOST_NODES = [
  { top: '27%', left: '67%', opacity: 0.35, delay: '0s'    },
  { top: '64%', left: '30%', opacity: 0.20, delay: '1.2s'  },
  { top: '41%', left: '76%', opacity: 0.15, delay: '0.6s'  },
] as const;

// ─── Sub-components ───────────────────────────────────────────────────────────

function RadarDisc({ sweeping }: { sweeping: boolean }) {
  return (
    <div className="relative w-64 h-64 md:w-72 md:h-72 mx-auto select-none">

      {/* Dot grid background */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(63,63,70,0.55) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      />

      {/* Radial glow */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: 'radial-gradient(circle at center, rgba(200,162,0,0.06) 0%, transparent 65%)' }}
      />

      {/* SVG — concentric rings + crosshairs */}
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 288 288" aria-hidden="true">
        {/* Rings */}
        {[132, 96, 60, 28].map((r, i) => (
          <circle
            key={r}
            cx="144" cy="144" r={r}
            fill="none"
            stroke={i === 0 ? '#3f3f46' : '#27272a'}
            strokeWidth={i === 0 ? 1 : 0.5}
          />
        ))}
        {/* Crosshairs */}
        <line x1="144" y1="12"  x2="144" y2="276" stroke="#27272a" strokeWidth="0.5" />
        <line x1="12"  y1="144" x2="276" y2="144" stroke="#27272a" strokeWidth="0.5" />
        {/* Diagonals */}
        <line x1="54"  y1="54"  x2="234" y2="234" stroke="#1c1c1f" strokeWidth="0.5" strokeDasharray="2 5" />
        <line x1="234" y1="54"  x2="54"  y2="234" stroke="#1c1c1f" strokeWidth="0.5" strokeDasharray="2 5" />
        {/* Range labels */}
        <text x="148" y="22"  fill="#3f3f46" fontSize="7" fontFamily="monospace">30m</text>
        <text x="148" y="58"  fill="#3f3f46" fontSize="7" fontFamily="monospace">20m</text>
        <text x="148" y="90"  fill="#3f3f46" fontSize="7" fontFamily="monospace">10m</text>
        {/* Center origin */}
        <circle cx="144" cy="144" r="5"  fill="none" stroke="#c8a200" strokeWidth="1" opacity="0.6" />
        <circle cx="144" cy="144" r="2"  fill="#c8a200" />
      </svg>

      {/* Rotating sweep beam (conic gradient) */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'conic-gradient(from 0deg, transparent 0deg, transparent 210deg, rgba(200,162,0,0.02) 250deg, rgba(200,162,0,0.12) 300deg, rgba(200,162,0,0.45) 355deg, transparent 360deg)',
          animation: 'spin linear infinite',
          animationDuration: sweeping ? '1.8s' : '4s',
        }}
      />

      {/* Ghost BLE node contacts */}
      {GHOST_NODES.map((node, i) => (
        <div
          key={i}
          className="absolute"
          style={{ top: node.top, left: node.left, opacity: node.opacity }}
        >
          <div className="relative w-2 h-2">
            <div
              className="absolute inset-0 rounded-full bg-[#c8a200] animate-ping"
              style={{ animationDelay: node.delay, animationDuration: '2.5s' }}
            />
            <div className="absolute inset-0.5 rounded-full bg-[#c8a200]" />
          </div>
        </div>
      ))}

      {/* Outer ring fade */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle at center, transparent 45%, #09090b 100%)' }}
      />
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const LABEL_WIDTH = 13; // chars
  const dots = '.'.repeat(Math.max(2, LABEL_WIDTH - entry.label.length + 4));
  return (
    <div className="flex items-baseline gap-0 font-mono text-[11px] leading-relaxed">
      <span className="text-zinc-500 shrink-0">{entry.label}</span>
      <span className="text-zinc-800 px-1 shrink-0">{dots}</span>
      <span className={`shrink-0 ${VALUE_COLOR[entry.color]}`}>
        [{' '}{entry.value}{' '}]
      </span>
    </div>
  );
}

// ─── HardwareStandby (main export) ────────────────────────────────────────────

interface HardwareStandbyProps {
  onRetry?: () => void;
}

export default function HardwareStandby({ onRetry }: HardwareStandbyProps) {
  const [phase, setPhase] = useState<SweepPhase>('standby');
  const [sweepLines, setSweepLines] = useState<string[]>([]);
  const [clock, setClock] = useState(new Date());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  function initiateSweep() {
    if (phase !== 'standby') return;
    setPhase('sweep');
    setSweepLines([]);
    timers.current.forEach(clearTimeout);
    timers.current = [];

    SWEEP_SEQUENCE.forEach((line, i) => {
      const t = setTimeout(() => {
        setSweepLines(prev => [...prev, line]);
      }, i * 450);
      timers.current.push(t);
    });

    const endTimer = setTimeout(() => {
      setPhase('standby');
      setSweepLines([]);
      onRetry?.();
    }, SWEEP_SEQUENCE.length * 450 + 700);
    timers.current.push(endTimer);
  }

  const timeStr = clock.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  const sweeping = phase === 'sweep';
  const activeLog = sweeping ? SWEEP_LOG : STANDBY_LOG;

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col overflow-hidden">

      {/* ── Terminal header bar ─────────────────────────────────────────── */}
      <div className="border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm px-6 py-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 bg-[#c8a200] rounded-sm flex items-center justify-center shrink-0">
            <span className="text-zinc-900 text-[8px] font-black">CE</span>
          </div>
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            CORE ELITE NETWORK
          </span>
          <span className="font-mono text-[10px] text-zinc-800">·</span>
          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[#c8a200]">
            HARDWARE STANDBY
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.8)]" />
            <span className="font-mono text-[9px] text-emerald-500 uppercase tracking-widest">SYS ONLINE</span>
          </div>
          <span className="font-mono text-[10px] text-zinc-400 tabular-nums">{timeStr}</span>
        </div>
      </div>

      {/* ── Main split pane ─────────────────────────────────────────────── */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_420px] min-h-0">

        {/* ── LEFT: Radar pane ──────────────────────────────────────────── */}
        <div className="flex flex-col items-center justify-center gap-6 p-8 lg:border-r border-zinc-800/50 relative">

          {/* Ambient glow behind radar */}
          <div
            className="absolute w-80 h-80 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(200,162,0,0.04) 0%, transparent 65%)' }}
          />

          <RadarDisc sweeping={sweeping} />

          {/* Scanning label */}
          <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-400 uppercase tracking-widest">
            <Radio className={`w-3 h-3 ${sweeping ? 'text-[#c8a200] animate-pulse' : 'text-zinc-700'}`} />
            {sweeping
              ? 'ACTIVE SWEEP IN PROGRESS...'
              : 'SCANNING FOR BLE TIMING GATES'
            }
          </div>

          {/* Frequency readout */}
          <div className="font-mono text-[9px] text-zinc-800 uppercase tracking-[0.2em] flex items-center gap-3">
            <span>FREQ: 2.4GHz</span>
            <span className="text-zinc-900">·</span>
            <span>PROTOCOL: BLE 5.2</span>
            <span className="text-zinc-900">·</span>
            <span>RANGE: 30m</span>
          </div>
        </div>

        {/* ── RIGHT: Ledger + console pane ─────────────────────────────── */}
        <div className="flex flex-col p-6 lg:p-8 gap-6">

          {/* Section label */}
          <div className="flex items-center gap-3">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400">
              SYSTEM DIAGNOSTIC LOG
            </p>
            <div className="flex-1 h-px bg-zinc-800/60" />
            <span className="font-mono text-[9px] text-zinc-800">v4.2.1</span>
          </div>

          {/* Log entries */}
          <div className="space-y-2.5 bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-4">
            {activeLog.map(entry => (
              <LogRow key={entry.key} entry={entry} />
            ))}

            {/* Blink cursor on last line */}
            <div className="font-mono text-[11px] text-zinc-800 flex items-center gap-1 pt-1">
              <span>{'>'}</span>
              <span
                className="inline-block w-1.5 h-3 bg-zinc-600 ml-0.5"
                style={{ animation: 'blink-caret 1.1s step-end infinite' }}
              />
            </div>
          </div>

          {/* Sweep activity log (appears during sweep) */}
          {sweepLines.length > 0 && (
            <div className="bg-zinc-900/50 border border-[#c8a200]/20 rounded-xl p-4 space-y-1.5">
              {sweepLines.map((line, i) => (
                <div
                  key={i}
                  className={`font-mono text-[10px] ${
                    i === sweepLines.length - 1 ? 'text-[#c8a200]' : 'text-zinc-400'
                  }`}
                >
                  {line}
                </div>
              ))}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Divider */}
          <div className="h-px bg-zinc-800/60" />

          {/* Command console */}
          <div className="space-y-3">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-700">
              COMMAND CONSOLE
            </p>
            <button
              onClick={initiateSweep}
              disabled={sweeping}
              className={`
                w-full font-mono text-xs font-bold uppercase tracking-widest
                px-4 py-3.5 rounded-lg border transition-all
                flex items-center justify-center gap-3
                ${sweeping
                  ? 'bg-zinc-900 border-[#c8a200]/30 text-[#c8a200] cursor-wait'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-[#c8a200]/60 hover:text-[#c8a200] hover:bg-zinc-800 active:scale-[0.99]'
                }
              `}
            >
              {sweeping ? (
                <>
                  <span
                    className="w-3 h-3 border border-[#c8a200]/60 border-t-[#c8a200] rounded-full"
                    style={{ animation: 'spin 0.8s linear infinite' }}
                  />
                  SWEEP IN PROGRESS...
                </>
              ) : (
                <>
                  <Wifi className="w-3.5 h-3.5" />
                  [ INITIATE MANUAL HARDWARE SWEEP ]
                </>
              )}
            </button>

            <p className="font-mono text-[9px] text-zinc-800 text-center leading-relaxed">
              BROADCAST MAC PING · BLE 2.4GHz · DASHR PROTOCOL v3
            </p>
          </div>

        </div>
      </div>

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <div className="border-t border-zinc-800/60 px-6 py-2 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4 font-mono text-[9px] text-zinc-800 uppercase tracking-widest">
          <span>SESSION: STANDBY</span>
          <span>·</span>
          <span>NODE SYNC: DISABLED</span>
        </div>
        <div className="font-mono text-[9px] text-zinc-800 uppercase tracking-widest">
          CORE ELITE NETWORK © 2026
        </div>
      </div>

    </div>
  );
}
