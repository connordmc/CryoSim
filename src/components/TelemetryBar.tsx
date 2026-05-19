import React from 'react';
import { Play, Pause, RotateCcw, ChevronRight, Download } from 'lucide-react';

interface Props {
  isRunning: boolean;
  stepCount: number;
  simTime: number;
  maxT: number;
  minT: number;
  numWires: number;
  error: string | null;
  onToggle: () => void;
  onReset: () => void;
  onStep: () => void;
  onExport: () => void;
}

const Metric: React.FC<{ label: string; value: string; accent?: string }> = ({
  label,
  value,
  accent = 'text-cyan-400',
}) => (
  <div className="bg-[#0d1117] border border-[#21262d] rounded px-3 py-1 flex flex-col items-center min-w-[90px]">
    <span className="text-[9px] uppercase tracking-widest text-gray-500">{label}</span>
    <span className={`text-sm font-semibold ${accent} tracking-tight`}>{value}</span>
  </div>
);

const TelemetryBar: React.FC<Props> = ({
  isRunning, stepCount, simTime, maxT, minT, numWires, error,
  onToggle, onReset, onStep, onExport,
}) => {
  const btn =
    'px-2.5 py-1.5 bg-[#161b22] border border-[#21262d] rounded text-xs text-gray-300 hover:bg-[#1c2129] hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-40';

  return (
    <div className="h-20 flex-none flex items-center gap-2 px-3 bg-[#0a0e14] border-b border-[#21262d]">
      <button className={btn} onClick={onToggle}>
        {isRunning ? <Pause size={13} /> : <Play size={13} />}
        <span>{isRunning ? 'PAUSE' : 'RUN'}</span>
      </button>
      <button className={btn} onClick={onReset}>
        <RotateCcw size={13} /> RESET
      </button>
      <button className={btn} onClick={onStep} disabled={isRunning}>
        <ChevronRight size={13} /> STEP
      </button>

      <div className="w-px h-6 bg-[#21262d] mx-1" />

      <div className="flex items-center gap-2 flex-1 overflow-x-auto">
        <Metric label="Steps" value={String(stepCount).padStart(6, '0')} />
        <Metric label="Time (s)" value={simTime.toFixed(4)} />
        <Metric label="T_max (K)" value={maxT.toFixed(3)} accent="text-red-400" />
        <Metric label="T_min (K)" value={minT.toFixed(3)} accent="text-blue-400" />
        <Metric label="Wires" value={String(numWires)} accent="text-emerald-400" />
        <Metric label="Solver" value="CN-TDMA" accent="text-purple-400" />
      </div>

      {error && (
        <span className="text-[10px] text-red-400 truncate max-w-[260px]" title={error}>
          {error}
        </span>
      )}

      <button className={btn} onClick={onExport}>
        <Download size={13} /> CSV
      </button>
    </div>
  );
};

export default TelemetryBar;