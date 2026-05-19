import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { WireConfig } from '../types';
import { ThermalSolver } from '../core/solver';

interface Props {
  solver: ThermalSolver | null;
  wireTemps: Map<number, Float64Array>;
  wires: WireConfig[];
  dx: number;
  numNodes: number;
  hoveredNode: number | null;
  selectedWireId: number | null;
  onHover: (node: number | null) => void;
  onSelectWire: (id: number | null) => void;
}

const CSTOPS = [
  [13, 8, 135],
  [84, 2, 163],
  [139, 10, 165],
  [185, 50, 137],
  [219, 92, 104],
  [244, 136, 73],
  [254, 188, 43],
  [240, 249, 33],
];

function plasmaRGB(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const idx = t * (CSTOPS.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, CSTOPS.length - 1);
  const f = idx - lo;
  return [
    Math.round(CSTOPS[lo][0] + f * (CSTOPS[hi][0] - CSTOPS[lo][0])),
    Math.round(CSTOPS[lo][1] + f * (CSTOPS[hi][1] - CSTOPS[lo][1])),
    Math.round(CSTOPS[lo][2] + f * (CSTOPS[hi][2] - CSTOPS[lo][2])),
  ];
}

function hexToRGBA(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const SimulationPlot: React.FC<Props> = ({
  solver, wireTemps, wires, dx, numNodes, hoveredNode, selectedWireId, onHover, onSelectWire,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 65, r: 16, t: 16, b: 58 };

  const handleMouse = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const plotW = size.w - pad.l - pad.r;
      const frac = (x - pad.l) / plotW;
      if (frac < 0 || frac > 1) { onHover(null); return; }
      onHover(Math.round(frac * (numNodes - 1)));
    },
    [numNodes, size.w, onHover],
  );

  const handleClick = useCallback(() => {
    if (wires.length === 0) return;
    const currentIdx = wires.findIndex((w) => w.id === selectedWireId);
    const nextIdx = (currentIdx + 1) % wires.length;
    onSelectWire(wires[nextIdx].id);
  }, [wires, selectedWireId, onSelectWire]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || wireTemps.size === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const N = numNodes;
    const w = size.w, h = size.h;
    const plotW = w - pad.l - pad.r;
    const hmH = 16;
    const plotH = h - pad.t - pad.b - hmH - 4;

    // Temperature range across all wires (log scale)
    let tMin = Infinity, tMax = -Infinity;
    wireTemps.forEach((temps) => {
      for (let i = 0; i < temps.length; i++) {
        if (temps[i] < tMin) tMin = temps[i];
        if (temps[i] > tMax) tMax = temps[i];
      }
    });
    tMin = Math.max(tMin, 0.001);
    tMax = Math.max(tMax, tMin * 2);
    const logMin = Math.floor(Math.log10(tMin));
    const logMax = Math.ceil(Math.log10(tMax));
    const logRange = logMax - logMin || 1;

    const xMax = (N - 1) * dx;
    const xScreen = (i: number) => pad.l + (i / (N - 1)) * plotW;
    const yScreen = (T: number) => {
      const lt = Math.log10(Math.max(T, 1e-4));
      return pad.t + plotH * (1 - (lt - logMin) / logRange);
    };

    // Background
    ctx.fillStyle = '#060a10';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#12171f';
    ctx.lineWidth = 0.5;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    for (let p = logMin; p <= logMax; p++) {
      const y = yScreen(Math.pow(10, p));
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = '#555d68';
      ctx.textAlign = 'right';
      const val = Math.pow(10, p);
      ctx.fillText(p >= 0 ? val.toFixed(0) + ' K' : val.toExponential(0) + ' K', pad.l - 6, y);
    }

    const xSteps = Math.min(10, Math.ceil(xMax));
    for (let xi = 0; xi <= xSteps; xi++) {
      const xm = (xi / xSteps) * xMax;
      const sx = pad.l + (xi / xSteps) * plotW;
      ctx.beginPath();
      ctx.moveTo(sx, pad.t);
      ctx.lineTo(sx, pad.t + plotH);
      ctx.stroke();
      ctx.fillStyle = '#555d68';
      ctx.textAlign = 'center';
      ctx.fillText(xm.toFixed(2) + ' m', sx, pad.t + plotH + 11);
    }

    // Draw temperature curves for each wire
    for (const wire of wires) {
      const temps = wireTemps.get(wire.id);
      if (!temps || temps.length < 2) continue;

      const isSelected = wire.id === selectedWireId;
      const baseAlpha = isSelected ? 1.0 : 0.4;

      // Glow
      ctx.beginPath();
      for (let i = 0; i < N && i < temps.length; i++) {
        const x = xScreen(i), y = yScreen(temps[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hexToRGBA(wire.color, 0.12 * baseAlpha);
      ctx.lineWidth = isSelected ? 6 : 3;
      ctx.stroke();

      // Main curve
      ctx.beginPath();
      for (let i = 0; i < N && i < temps.length; i++) {
        const x = xScreen(i), y = yScreen(temps[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = hexToRGBA(wire.color, baseAlpha);
      ctx.lineWidth = isSelected ? 2.0 : 1.0;
      ctx.stroke();
    }

    // Heatmap strip (selected wire)
    const hmWireId = selectedWireId !== null ? selectedWireId : (wires.length > 0 ? wires[0].id : -1);
    const hmTemps = wireTemps.get(hmWireId);
    if (hmTemps) {
      const hmY = pad.t + plotH + 26;
      const nodeW = plotW / N;
      for (let i = 0; i < N && i < hmTemps.length; i++) {
        const lt = Math.log10(Math.max(hmTemps[i], 1e-4));
        const t = (lt - logMin) / logRange;
        const [r, g, b] = plasmaRGB(t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(pad.l + i * nodeW, hmY, nodeW + 0.5, hmH);
      }
      ctx.strokeStyle = '#21262d';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(pad.l, hmY, plotW, hmH);
    }

    // Hovered crosshair
    if (hoveredNode !== null && hoveredNode >= 0 && hoveredNode < N) {
      const hx = xScreen(hoveredNode);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ffffff30';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, pad.t);
      ctx.lineTo(hx, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const wire of wires) {
        const temps = wireTemps.get(wire.id);
        if (!temps || hoveredNode >= temps.length) continue;
        const hy = yScreen(temps[hoveredNode]);
        ctx.beginPath();
        ctx.arc(hx, hy, wire.id === selectedWireId ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = wire.color;
        ctx.fill();
        if (wire.id === selectedWireId) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Wire legend (top-right)
    const legendX = w - pad.r - 10;
    let legendY = pad.t + 8;
    ctx.textAlign = 'right';
    ctx.font = '9px "JetBrains Mono", monospace';
    for (const wire of wires) {
      ctx.fillStyle = wire.color;
      ctx.fillRect(legendX - 50, legendY - 4, 8, 8);
      ctx.fillStyle = wire.id === selectedWireId ? '#ffffff' : '#888';
      ctx.fillText(wire.label, legendX, legendY + 2);
      legendY += 14;
    }

    // Axis labels
    ctx.fillStyle = '#555d68';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Position [m]', pad.l + plotW / 2, h - 4);
    ctx.save();
    ctx.translate(12, pad.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Temperature [K]', 0, 0);
    ctx.restore();
  }, [wireTemps, wires, size, dx, numNodes, hoveredNode, selectedWireId]);

  // Info bar
  let infoText = 'Hover over chart to inspect | Click to cycle selected wire';
  if (hoveredNode !== null && solver) {
    const parts: string[] = [`NODE: ${String(hoveredNode).padStart(4, '0')}  |  X: ${(hoveredNode * dx).toFixed(4)} m`];
    for (const wire of wires) {
      const ns = solver.getWireNodeState(wire.id, hoveredNode);
      if (ns) {
        const marker = wire.id === selectedWireId ? '>' : ' ';
        parts.push(
          `${marker}${wire.label}: ${ns.temperature.toFixed(3)} K [${ns.materialName}]`
        );
      }
    }
    infoText = parts.join('  |  ');
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 mx-3 mt-2">
      <div ref={containerRef} className="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onMouseMove={handleMouse}
          onMouseLeave={() => onHover(null)}
          onClick={handleClick}
          style={{ width: size.w, height: size.h }}
        />
      </div>
      <div className="h-7 flex items-center px-3 bg-[#0d1117] border border-[#21262d] rounded mt-1 text-[10px] text-gray-400 tracking-wide overflow-hidden whitespace-nowrap">
        {infoText}
      </div>
    </div>
  );
};

export default SimulationPlot;