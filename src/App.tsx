import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { SolverConfig, Plate, WireConfig } from './types';
import { ThermalSolver } from './core/solver';
import TelemetryBar from './components/TelemetryBar';
import ConfigPanel from './components/ConfigPanel';
import SimulationPlot from './components/SimulationPlot';
import SystemMap from './components/SystemMap';

const WIRE_COLORS = [
  '#00ffd5', '#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3',
  '#54a0ff', '#5f27cd', '#01a3a4', '#f368e0', '#ee5a24',
];

const DEFAULT_CONFIG: SolverConfig = {
  numNodes: 100,
  dx: 0.02788,
  dt: 0.005,
  powerFormula: 'return 0;',
};

const DEFAULT_PLATES: Plate[] = [
  { id: 0, nodeIndex: 0,  temperature: 4.0,   isFixed: true, maxPower: 0 },
  { id: 1, nodeIndex: 43, temperature: 4.0,   isFixed: true, maxPower: 0 },
  { id: 2, nodeIndex: 63, temperature: 4.0,   isFixed: true, maxPower: 0 },
  { id: 3, nodeIndex: 81, temperature: 77.0,  isFixed: true, maxPower: 0 },
  { id: 4, nodeIndex: 99, temperature: 300.0, isFixed: true, maxPower: 0 },
];

const DEFAULT_WIRES: WireConfig[] = [
  {
    id: 0,
    label: 'SC Lead (NbTi)',
    color: WIRE_COLORS[0],
    crossSectionalArea: 1.9635e-9,
    currentAmps: 7.5,
    segments: [
      { id: 0, name: 'Copper Lead-In',      startNode: 0,  endNode: 42, materialType: 'copper' },
      { id: 1, name: 'NbTi Superconductor', startNode: 43, endNode: 63, materialType: 'nbti' },
      { id: 2, name: 'Copper Lead-Out',     startNode: 64, endNode: 99, materialType: 'copper' },
    ],
  },
  {
    id: 1,
    label: 'Structural Support',
    color: WIRE_COLORS[1],
    crossSectionalArea: 7.854e-9,
    currentAmps: 0,
    segments: [
      { id: 0, name: 'Full Copper', startNode: 0, endNode: 99, materialType: 'copper' },
    ],
  },
];

const STEPS_PER_FRAME = 10;

export default function App() {
  const [config, setConfig] = useState<SolverConfig>(DEFAULT_CONFIG);
  const [plates, setPlates] = useState<Plate[]>(DEFAULT_PLATES);
  const [wires, setWires] = useState<WireConfig[]>(DEFAULT_WIRES);
  const [isRunning, setIsRunning] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [simTime, setSimTime] = useState(0);
  const [wireTemps, setWireTemps] = useState<Map<number, Float64Array>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);
  const [selectedWireId, setSelectedWireId] = useState<number | null>(0);

  const solverRef = useRef<ThermalSolver | null>(null);
  const simRef = useRef({ step: 0, time: 0 });
  const configRef = useRef(config);
  configRef.current = config;

  const buildSolver = useCallback(() => {
    try {
      const s = new ThermalSolver(config, plates, wires);
      solverRef.current = s;
      simRef.current = { step: 0, time: 0 };
      setWireTemps(s.getAllTemperatures());
      setStepCount(0);
      setSimTime(0);
      setError(null);
      if (wires.length > 0 && selectedWireId === null) {
        setSelectedWireId(wires[0].id);
      }
    } catch (e: any) {
      setError(e.message || String(e));
      solverRef.current = null;
    }
  }, [config.numNodes, config.dx, plates, wires]);

  useEffect(buildSolver, [buildSolver]);

  useEffect(() => {
    if (!isRunning) return;
    let id: number;

    const loop = () => {
      const solver = solverRef.current;
      const cfg = configRef.current;
      if (!solver) { setIsRunning(false); return; }

      let powerFn: ((t: number) => number) | null = null;
      try {
        powerFn = new Function('t', cfg.powerFormula) as (t: number) => number;
        powerFn(0);
      } catch {
        powerFn = null;
      }

      try {
        for (let i = 0; i < STEPS_PER_FRAME; i++) {
          solver.step(cfg.dt, powerFn, simRef.current.time);
          simRef.current.step++;
          simRef.current.time += cfg.dt;
        }
        setWireTemps(solver.getAllTemperatures());
        setStepCount(simRef.current.step);
        setSimTime(simRef.current.time);
        setError(null);
      } catch (e: any) {
        setIsRunning(false);
        setError(e.message || String(e));
      }

      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [isRunning]);

  const handleToggle = () => setIsRunning((r) => !r);

  const handleReset = () => {
    setIsRunning(false);
    buildSolver();
  };

  const handleStep = () => {
    const solver = solverRef.current;
    const cfg = configRef.current;
    if (!solver) return;
    let powerFn: ((t: number) => number) | null = null;
    try {
      powerFn = new Function('t', cfg.powerFormula) as (t: number) => number;
      powerFn(0);
    } catch { powerFn = null; }
    try {
      solver.step(cfg.dt, powerFn, simRef.current.time);
      simRef.current.step++;
      simRef.current.time += cfg.dt;
      setWireTemps(solver.getAllTemperatures());
      setStepCount(simRef.current.step);
      setSimTime(simRef.current.time);
      setError(null);
    } catch (e: any) {
      setError(e.message || String(e));
    }
  };

  const handleExport = () => {
    const solver = solverRef.current;
    if (!solver) return;
    const headers = ['Node', 'Position_m'];
    for (const w of wires) {
      headers.push(`T_${w.label}_K`);
      headers.push(`Material_${w.label}`);
    }
    const rows = [headers.join(',')];
    for (let i = 0; i < solver.N; i++) {
      const cols: string[] = [String(i), (i * config.dx).toFixed(6)];
      for (const w of wires) {
        const ns = solver.getWireNodeState(w.id, i);
        cols.push(ns ? ns.temperature.toFixed(6) : '0');
        cols.push(ns ? ns.materialName : 'unknown');
      }
      rows.push(cols.join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cryo_multiwire_step${stepCount}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const solver = solverRef.current;
  const { minT, maxT } = solver
    ? solver.getGlobalMinMax()
    : { minT: 0, maxT: 0 };

  return (
    <div className="flex flex-col h-screen bg-[#060a10] text-gray-100 font-mono">
      <TelemetryBar
        isRunning={isRunning}
        stepCount={stepCount}
        simTime={simTime}
        maxT={maxT}
        minT={minT}
        numWires={wires.length}
        error={error}
        onToggle={handleToggle}
        onReset={handleReset}
        onStep={handleStep}
        onExport={handleExport}
      />

      <div className="flex flex-1 overflow-hidden">
        <ConfigPanel
          config={config}
          plates={plates}
          wires={wires}
          selectedWireId={selectedWireId}
          onConfigChange={setConfig}
          onPlatesChange={setPlates}
          onWiresChange={setWires}
          onSelectWire={setSelectedWireId}
          wireColors={WIRE_COLORS}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          <SimulationPlot
            solver={solver}
            wireTemps={wireTemps}
            wires={wires}
            dx={config.dx}
            numNodes={config.numNodes}
            hoveredNode={hoveredNode}
            selectedWireId={selectedWireId}
            onHover={setHoveredNode}
            onSelectWire={setSelectedWireId}
          />
          <SystemMap
            wires={wires}
            plates={plates}
            numNodes={config.numNodes}
            hoveredNode={hoveredNode}
            selectedWireId={selectedWireId}
          />
        </div>
      </div>
    </div>
  );
}