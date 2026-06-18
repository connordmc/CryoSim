// src/components/ErrorLogModal.tsx
// Full-text solver event log. The telemetry bar truncates errors to fit;
// this modal shows every message untruncated with its step/time context.

import React, { useEffect } from 'react';
import { X, Trash2, Copy } from 'lucide-react';
import type { LogEntry } from '../types';

interface Props {
  entries: LogEntry[];
  onClose: () => void;
  onClear: () => void;
}

const KIND_STYLES: Record<LogEntry['kind'], string> = {
  error: 'text-red-400 border-red-500/40 bg-red-500/10',
  warning: 'text-amber-400 border-amber-500/40 bg-amber-500/10',
};

const ErrorLogModal: React.FC<Props> = ({ entries, onClose, onClear }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyAll = () => {
    const text = entries
      .map((e) =>
        `[${e.wallTime.toISOString()}] step=${e.step} t=${e.simTime.toFixed(6)}s ${e.kind.toUpperCase()}: ${e.message}`)
      .join('\n');
    navigator.clipboard?.writeText(text);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-[#0d1117] border border-[#21262d] rounded-lg w-full max-w-3xl max-h-[80vh] flex flex-col font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#21262d]">
          <span className="text-xs uppercase tracking-widest text-gray-300">
            Solver Event Log
            <span className="ml-2 text-gray-500">({entries.length})</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={copyAll}
              disabled={entries.length === 0}
              className="px-2 py-1 text-[10px] text-gray-400 hover:text-cyan-400 border border-[#21262d] rounded flex items-center gap-1 disabled:opacity-40"
            >
              <Copy size={11} /> COPY
            </button>
            <button
              onClick={onClear}
              disabled={entries.length === 0}
              className="px-2 py-1 text-[10px] text-gray-400 hover:text-red-400 border border-[#21262d] rounded flex items-center gap-1 disabled:opacity-40"
            >
              <Trash2 size={11} /> CLEAR
            </button>
            <button onClick={onClose} className="text-gray-500 hover:text-white ml-1">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {entries.length === 0 && (
            <div className="text-xs text-gray-600 text-center py-8">
              No solver errors or warnings recorded.
            </div>
          )}
          {[...entries].reverse().map((e) => (
            <div key={e.id} className="bg-[#161b22] border border-[#21262d] rounded p-2">
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border rounded ${KIND_STYLES[e.kind]}`}>
                  {e.kind}
                </span>
                <span className="text-[9px] text-gray-500">
                  step {e.step} &middot; t = {e.simTime.toFixed(6)} s &middot; {e.wallTime.toLocaleTimeString()}
                </span>
              </div>
              <div className="text-[11px] text-gray-200 whitespace-pre-wrap break-words leading-relaxed">
                {e.message}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ErrorLogModal;
