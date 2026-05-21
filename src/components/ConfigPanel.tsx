// src/components/ConfigPanel.tsx
// Complete refactored configuration panel with three-state plate boundary selector

import React, { useState } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import type { Plate, PlateType, MaterialSegment, SolverConfig, MaterialType, WireConfig } from '../types';

interface Props {
  config: SolverConfig;
  plates: Plate[];
  wires: WireConfig[];
  selectedWireId: number | null;
  plateTemperatures: Map<number, number>;
  onConfigChange: (c: SolverConfig) => void;
  onPlatesChange: (p: Plate[]) => void;
  onWiresChange: (w: WireConfig[]) => void;
  onSelectWire: (id: number | null) => void;
  wireColors: string[];
}

const TABS = ['Plates', 'Wires', 'Physics'] as const;
const inp =
  'w-full bg-[#161b22] border border-[#21262d] rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20';
const lbl = 'text-[10px] uppercase tracking-wider text-gray-500 mb-0.5';
const selectCls =
  'w-full bg-[#161b22] border border-[#21262d] rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:border-cyan-500/50 focus:outline-none';

const ConfigPanel: React.FC<Props> = ({
  config, plates, wires, selectedWireId, plateTemperatures,
  onConfigChange, onPlatesChange, onWiresChange, onSelectWire, wireColors,
}) => {
  const [tab, setTab] = useState<number>(0);

  // Plates helpers
  const addPlate = () => {
    const id = plates.length > 0 ? Math.max(...plates.map((p) => p.id)) + 1 : 0;
    onPlatesChange([
      ...plates,
      {
        id,
        nodeIndex: Math.floor(config.numNodes / 2),
        temperature: 10,
        plateType: 'fixed',
        coolingCapacityWatts: 0.001,
        heatCapacityJK: 1.0,
        resistanceOhms: 0,
      },
    ]);
  };

  const removePlate = (id: number) => onPlatesChange(plates.filter((p) => p.id !== id));

  const setPlateField = (id: number, key: keyof Plate, value: number | string | boolean) => {
    onPlatesChange(plates.map((p) => {
      if (p.id !== id) return p;
      return { ...p, [key]: value };
    }));
  };

  // Wire helpers
  const addWire = () => {
    const id = wires.length > 0 ? Math.max(...wires.map((w) => w.id)) + 1 : 0;
    const color = wireColors[id % wireColors.length];
    onWiresChange([
      ...wires,
      {
        id,
        label: `Wire ${id}`,
        color,
        crossSectionalArea: 1.9635e-9,
        currentAmps: 0,
        segments: [
          { id: 0, name: 'Full Length', startNode: 0, endNode: config.numNodes - 1, materialType: 'copper' as MaterialType },
        ],
      },
    ]);
    onSelectWire(id);
  };

  const removeWire = (id: number) => {
    const newWires = wires.filter((w) => w.id !== id);
    onWiresChange(newWires);
    if (selectedWireId === id) {
      onSelectWire(newWires.length > 0 ? newWires[0].id : null);
    }
  };

  const duplicateWire = (id: number) => {
    const src = wires.find((w) => w.id === id);
    if (!src) return;
    const newId = wires.length > 0 ? Math.max(...wires.map((w) => w.id)) + 1 : 0;
    const color = wireColors[newId % wireColors.length];
    onWiresChange([
      ...wires,
      {
        ...src,
        id: newId,
        label: src.label + ' (copy)',
        color,
        segments: src.segments.map((s) => ({ ...s })),
      },
    ]);
    onSelectWire(newId);
  };

  const setWireField = (id: number, key: string, value: any) => {
    onWiresChange(wires.map((w) => (w.id === id ? { ...w, [key]: value } : w)));
  };

  // Segment helpers for selected wire
  const selectedWire = wires.find((w) => w.id === selectedWireId) || null;

  const addSegment = () => {
    if (!selectedWire) return;
    const segId = selectedWire.segments.length > 0
      ? Math.max(...selectedWire.segments.map((s) => s.id)) + 1 : 0;
    const newSegs = [
      ...selectedWire.segments,
      { id: segId, name: 'New Segment', startNode: 0, endNode: config.numNodes - 1, materialType: 'copper' as MaterialType },
    ];
    setWireField(selectedWire.id, 'segments', newSegs);
  };

  const removeSegment = (segId: number) => {
    if (!selectedWire) return;
    setWireField(selectedWire.id, 'segments', selectedWire.segments.filter((s) => s.id !== segId));
  };

  const setSegField = (segId: number, key: keyof MaterialSegment, value: string | number) => {
    if (!selectedWire) return;
    const newSegs = selectedWire.segments.map((s) => (s.id === segId ? { ...s, [key]: value } : s));
    setWireField(selectedWire.id, 'segments', newSegs);
  };

  return (
    <div className="w-80 flex-none flex flex-col bg-[#0d1117] border-r border-[#21262d] select-none">
      {/* Tab bar */}
      <div className="flex border-b border-[#21262d]">
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            className={`flex-1 py-2 text-[10px] uppercase tracking-widest transition-colors ${
              tab === i
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-[#161b22]'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* TAB 0: PLATES */}
        {tab === 0 && (
          <>
            {plates.map((p) => {
              const liveTemp = plateTemperatures.get(p.id);
              return (
                <div key={p.id} className="bg-[#161b22] border border-[#21262d] rounded p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-400 font-semibold">PLATE #{p.id}</span>
                    <div className="flex items-center gap-1">
                      {p.plateType === 'dynamic' && liveTemp !== undefined && (
                        <span className="text-[9px] text-emerald-400 font-mono">
                          {liveTemp.toFixed(4)} K
                        </span>
                      )}
                      <button onClick={() => removePlate(p.id)} className="text-gray-600 hover:text-red-400">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Node index and temperature */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className={lbl}>Node Idx</div>
                      <input
                        type="number"
                        className={inp}
                        value={p.nodeIndex}
                        min={0}
                        max={config.numNodes - 1}
                        onChange={(e) => setPlateField(p.id, 'nodeIndex', parseInt(e.target.value) || 0)}
                      />
                    </div>
                    <div>
                      <div className={lbl}>Init Temp (K)</div>
                      <input
                        type="number"
                        className={inp}
                        value={p.temperature}
                        step={0.1}
                        onChange={(e) => setPlateField(p.id, 'temperature', parseFloat(e.target.value) || 0.01)}
                      />
                    </div>
                  </div>

                  {/* Plate type selector */}
                  <div>
                    <div className={lbl}>Boundary Type</div>
                    <select
                      className={selectCls}
                      value={p.plateType}
                      onChange={(e) => setPlateField(p.id, 'plateType', e.target.value as PlateType)}
                    >
                      <option value="fixed">Fixed Temperature (Dirichlet)</option>
                      <option value="dynamic">Dynamic Cooling Plate</option>
                      <option value="resistor">Lumped Boundary Resistor</option>
                    </select>
                  </div>

                  {/* Conditional fields based on plate type */}
                  {p.plateType === 'fixed' && (
                    <div className="bg-[#0d1117] border border-[#21262d] rounded p-1.5">
                      <div className="text-[9px] text-amber-400">
                        Infinite thermal sink at {p.temperature.toFixed(2)} K
                      </div>
                    </div>
                  )}

                  {p.plateType === 'dynamic' && (
                    <div className="space-y-1.5 bg-[#0d1117] border border-[#21262d] rounded p-2">
                      <div className="text-[9px] text-emerald-400 font-semibold">Dynamic Cooling Parameters</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className={lbl}>Q_max (W)</div>
                          <input
                            type="number"
                            className={inp}
                            value={p.coolingCapacityWatts || 0}
                            step={0.0001}
                            onChange={(e) => setPlateField(p.id, 'coolingCapacityWatts', parseFloat(e.target.value) || 0)}
                          />
                        </div>
                        <div>
                          <div className={lbl}>C_plate (J/K)</div>
                          <input
                            type="number"
                            className={inp}
                            value={p.heatCapacityJK || 1.0}
                            step={0.01}
                            onChange={(e) => setPlateField(p.id, 'heatCapacityJK', parseFloat(e.target.value) || 0.01)}
                          />
                        </div>
                      </div>
                      <div className="text-[8px] text-gray-600">
                        Q_fridge = Q_max * tanh(T / 4.2)
                      </div>
                    </div>
                  )}

                  {p.plateType === 'resistor' && (
                    <div className="space-y-1.5 bg-[#0d1117] border border-[#21262d] rounded p-2">
                      <div className="text-[9px] text-red-400 font-semibold">Lumped Resistor Parameters</div>
                      <div>
                        <div className={lbl}>Resistance (Ohms)</div>
                        <input
                          type="number"
                          className={inp}
                          value={p.resistanceOhms || 0}
                          step={0.001}
                          onChange={(e) => setPlateField(p.id, 'resistanceOhms', parseFloat(e.target.value) || 0)}
                        />
                      </div>
                      <div className="text-[8px] text-gray-600">
                        Q_joule = I^2 * R (injected into matrix RHS)
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <button
              onClick={addPlate}
              className="w-full py-1.5 border border-dashed border-[#21262d] rounded text-xs text-gray-500 hover:text-cyan-400 hover:border-cyan-500/40 transition-colors flex items-center justify-center gap-1"
            >
              <Plus size={12} /> Add Plate
            </button>
          </>
        )}

        {/* TAB 1: WIRES */}
        {tab === 1 && (
          <>
            <div className="space-y-1">
              {wires.map((w) => (
                <div
                  key={w.id}
                  onClick={() => onSelectWire(w.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    selectedWireId === w.id
                      ? 'bg-[#161b22] border border-cyan-500/30'
                      : 'hover:bg-[#161b22] border border-transparent'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full flex-none" style={{ backgroundColor: w.color }} />
                  <span className="text-xs text-gray-300 flex-1 truncate">{w.label}</span>
                  <button onClick={(e) => { e.stopPropagation(); duplicateWire(w.id); }} className="text-gray-600 hover:text-cyan-400">
                    <Copy size={11} />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); removeWire(w.id); }} className="text-gray-600 hover:text-red-400">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={addWire}
              className="w-full py-1.5 border border-dashed border-[#21262d] rounded text-xs text-gray-500 hover:text-cyan-400 hover:border-cyan-500/40 transition-colors flex items-center justify-center gap-1"
            >
              <Plus size={12} /> Add Wire
            </button>

            {/* Selected wire detail */}
            {selectedWire && (
              <div className="mt-3 pt-3 border-t border-[#21262d] space-y-2">
                <div className="text-[10px] text-cyan-400 font-semibold uppercase tracking-wider">
                  Wire Configuration
                </div>
                <div>
                  <div className={lbl}>Label</div>
                  <input
                    type="text"
                    className={inp}
                    value={selectedWire.label}
                    onChange={(e) => setWireField(selectedWire.id, 'label', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className={lbl}>Area (m²)</div>
                    <input
                      type="number"
                      className={inp}
                      value={selectedWire.crossSectionalArea}
                      step={1e-10}
                      onChange={(e) => setWireField(selectedWire.id, 'crossSectionalArea', parseFloat(e.target.value) || 1e-9)}
                    />
                  </div>
                  <div>
                    <div className={lbl}>Current (A)</div>
                    <input
                      type="number"
                      className={inp}
                      value={selectedWire.currentAmps}
                      step={0.1}
                      onChange={(e) => setWireField(selectedWire.id, 'currentAmps', parseFloat(e.target.value) || 0)}
                    />
                  </div>
                </div>

                {/* Segments */}
                <div className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider mt-3">
                  Material Segments
                </div>
                {selectedWire.segments.map((s) => (
                  <div key={s.id} className="bg-[#0d1117] border border-[#21262d] rounded p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <input
                        type="text"
                        className="bg-transparent text-[10px] text-gray-300 font-semibold border-none outline-none w-full"
                        value={s.name}
                        onChange={(e) => setSegField(s.id, 'name', e.target.value)}
                      />
                      <button onClick={() => removeSegment(s.id)} className="text-gray-600 hover:text-red-400 ml-1">
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className={lbl}>Start Node</div>
                        <input
                          type="number"
                          className={inp}
                          value={s.startNode}
                          min={0}
                          onChange={(e) => setSegField(s.id, 'startNode', parseInt(e.target.value) || 0)}
                        />
                      </div>
                      <div>
                        <div className={lbl}>End Node</div>
                        <input
                          type="number"
                          className={inp}
                          value={s.endNode}
                          min={0}
                          onChange={(e) => setSegField(s.id, 'endNode', parseInt(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                    <div>
                      <div className={lbl}>Material</div>
                      <select
                        className={selectCls}
                        value={s.materialType}
                        onChange={(e) => setSegField(s.id, 'materialType', e.target.value)}
                      >
                        <option value="copper">Copper (OFHC)</option>
                        <option value="nbti">NbTi</option>
                      </select>
                    </div>
                  </div>
                ))}
                <button
                  onClick={addSegment}
                  className="w-full py-1.5 border border-dashed border-[#21262d] rounded text-xs text-gray-500 hover:text-cyan-400 hover:border-cyan-500/40 transition-colors flex items-center justify-center gap-1"
                >
                  <Plus size={12} /> Add Segment
                </button>
              </div>
            )}
          </>
        )}

        {/* TAB 2: PHYSICS */}
        {tab === 2 && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className={lbl}>Nodes (N)</div>
                <input
                  type="number"
                  className={inp}
                  value={config.numNodes}
                  min={3}
                  max={2000}
                  onChange={(e) => onConfigChange({ ...config, numNodes: parseInt(e.target.value) || 3 })}
                />
              </div>
              <div>
                <div className={lbl}>dx (m)</div>
                <input
                  type="number"
                  className={inp}
                  value={config.dx}
                  step={0.001}
                  onChange={(e) => onConfigChange({ ...config, dx: parseFloat(e.target.value) || 0.01 })}
                />
              </div>
              <div>
                <div className={lbl}>dt (s)</div>
                <input
                  type="number"
                  className={inp}
                  value={config.dt}
                  step={0.0001}
                  onChange={(e) => onConfigChange({ ...config, dt: parseFloat(e.target.value) || 0.001 })}
                />
              </div>
              <div>
                <div className={lbl}>Total Length</div>
                <div className="text-xs text-gray-400 pt-1.5">
                  {((config.numNodes - 1) * config.dx).toFixed(4)} m
                </div>
              </div>
            </div>
            <div>
              <div className={lbl}>External Power q(t) [W/m³]</div>
              <textarea
                className={inp + ' h-20 resize-none'}
                value={config.powerFormula}
                onChange={(e) => onConfigChange({ ...config, powerFormula: e.target.value })}
              />
              <div className="text-[9px] text-gray-600 mt-0.5">
                JS function body. Arg: t (time in s). Return W/m³.
              </div>
            </div>
            <div className="bg-[#161b22] border border-[#21262d] rounded p-2 text-[9px] text-gray-500 space-y-1">
              <div className="text-cyan-400 font-semibold">Solver: Crank-Nicolson (Implicit)</div>
              <div>2nd-order accurate, unconditionally stable</div>
              <div>Thomas Algorithm (TDMA) tridiagonal solve</div>
              <div>Harmonic-mean k at cell interfaces</div>
              <div>Three-state boundaries: Fixed / Dynamic / Resistor</div>
              <div>Adaptive dt with max-deltaT safety net</div>
              <div>Inter-wire coupling via shared dynamic plate nodes</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConfigPanel;