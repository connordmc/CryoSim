import React from 'react';
import type { WireConfig, Plate } from '../types';

interface Props {
  wires: WireConfig[];
  plates: Plate[];
  numNodes: number;
  hoveredNode: number | null;
  selectedWireId: number | null;
}

const MAT_COLORS: Record<string, string> = {
  copper: '#0e7490',
  nbti: '#7e22ce',
};

const SystemMap: React.FC<Props> = ({ wires, plates, numNodes, hoveredNode, selectedWireId }) => {
  const N = Math.max(numNodes - 1, 1);

  const displayWires = selectedWireId !== null
    ? wires.filter((w) => w.id === selectedWireId)
    : wires;

  return (
    <div className="flex-none mx-3 mb-2">
      <div className="text-[9px] uppercase tracking-widest text-gray-600 mb-1">
        System Map {wires.length > 1 ? `(${wires.length} wires)` : ''}
      </div>
      <div className="space-y-1">
        {displayWires.map((wire) => (
          <div key={wire.id} className="relative h-8 bg-[#0d1117] border border-[#21262d] rounded overflow-hidden">
            {/* Wire label */}
            <div className="absolute top-0.5 left-1 text-[8px] text-gray-500 z-10 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: wire.color }} />
              {wire.label}
            </div>

            {/* Material segments */}
            {wire.segments.map((seg) => {
              const left = (Math.max(0, seg.startNode) / N) * 100;
              const right = (Math.min(N, seg.endNode) / N) * 100;
              return (
                <div
                  key={`${wire.id}-${seg.id}`}
                  className="absolute top-0 h-full opacity-50"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(right - left, 0.2)}%`,
                    backgroundColor: MAT_COLORS[seg.materialType] || '#333',
                  }}
                />
              );
            })}

            {/* Plate markers */}
            {plates.map((p) => (
              <div
                key={p.id}
                className="absolute top-0 h-full flex flex-col items-center justify-end"
                style={{ left: `${(p.nodeIndex / N) * 100}%`, transform: 'translateX(-50%)' }}
              >
                <div
                  className={`w-1 flex-1 rounded-sm ${p.isFixed ? 'bg-amber-400' : 'border border-amber-400 bg-transparent'}`}
                />
                <span className="text-[6px] text-amber-400/80 leading-none mt-px">{p.temperature.toFixed(0)}K</span>
              </div>
            ))}

            {/* Hovered node */}
            {hoveredNode !== null && (
              <div
                className="absolute top-0 h-full w-px bg-white/50 pointer-events-none"
                style={{ left: `${(hoveredNode / N) * 100}%` }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-1">
        <span className="flex items-center gap-1 text-[8px] text-gray-400">
          <span className="w-2 h-2 rounded-sm bg-[#0e7490] inline-block" /> Cu
        </span>
        <span className="flex items-center gap-1 text-[8px] text-gray-400">
          <span className="w-2 h-2 rounded-sm bg-[#7e22ce] inline-block" /> NbTi
        </span>
        <span className="flex items-center gap-1 text-[8px] text-gray-400">
          <span className="w-2 h-1 rounded-sm bg-amber-400 inline-block" /> Fixed
        </span>
      </div>
    </div>
  );
};

export default SystemMap;