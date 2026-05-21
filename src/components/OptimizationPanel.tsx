// src/components/OptimizationPanel.tsx
// Complete new optimization workspace component for parameter sweeps

import React, { useState, useCallback } from 'react';
import type { SolverConfig, Plate, WireConfig, OptimizationResultA, OptimizationResultB, SweepPoint } from '../types';
import { ThermalSolver } from '../core/solver';

interface Props {
  config: SolverConfig;
  plates: Plate[];
  wires: WireConfig[];
}

const BENCHMARK_POWER_W = 225.0; // Cesium deposition system target
const SAFETY_THRESHOLD_PERCENT = 10.0;
const RECOMMENDED_MARGIN_PERCENT = 5.0;
const DEFAULT_CURRENT_A = 7.5;

const sectionCls = 'bg-[#161b22] border border-[#21262d] rounded p-4 space-y-3';
const btnCls = 'px-4 py-2 bg-[#21262d] border border-[#30363d] rounded text-xs text-cyan-300 hover:bg-[#30363d] hover:text-white transition-colors font-semibold tracking-wide';
const headerCls = 'text-sm font-semibold text-cyan-400 uppercase tracking-wider';
const subHeaderCls = 'text-[10px] text-gray-400 uppercase tracking-wider';
const metricBoxCls = 'bg-[#0d1117] border border-[#21262d] rounded p-2 text-center';

const OptimizationPanel: React.FC<Props> = ({ config, plates, wires }) => {
  const [resultA, setResultA] = useState<OptimizationResultA | null>(null);
  const [resultB, setResultB] = useState<OptimizationResultB | null>(null);
  const [runningA, setRunningA] = useState(false);
  const [runningB, setRunningB] = useState(false);
  const [sweepMinMm, setSweepMinMm] = useState(100);
  const [sweepMaxMm, setSweepMaxMm] = useState(200);
  const [sweepSteps, setSweepSteps] = useState(11);
  const [progressB, setProgressB] = useState(0);

  /* ===========================================================
     ROUTINE A: High-Current Lead Dominance Check (7.5A State)
     Evaluates total Joule dissipation vs 225W benchmark
     =========================================================== */
  const runRoutineA = useCallback(() => {
    setRunningA(true);
    setResultA(null);

    // Use setTimeout to avoid blocking UI
    setTimeout(() => {
      try {
        // Create wire configs with full 7.5A current on all current-carrying wires
        const wiresFullCurrent: WireConfig[] = wires.map((w) => ({
          ...w,
          currentAmps: w.currentAmps > 0 ? DEFAULT_CURRENT_A : 0,
        }));

        // Run to steady state
        const solver = ThermalSolver.computeSteadyState(
          config,
          plates,
          wiresFullCurrent,
          8000,
          1e-9,
        );

        // Compute total Joule dissipation
        const totalDissipation = ThermalSolver.computeTotalJouleDissipation(solver, config.dx);
        const percentOfBenchmark = (totalDissipation / BENCHMARK_POWER_W) * 100;
        const passed = percentOfBenchmark < SAFETY_THRESHOLD_PERCENT;

        // Per-wire breakdown and recommendations
        const wireBreakdown = wiresFullCurrent.map((wc) => {
          const wire = solver.wires.find((w) => w.wireId === wc.id);
          if (!wire || wire.currentAmps === 0) {
            return {
              wireId: wc.id,
              label: wc.label,
              dissipationW: 0,
              currentArea: wc.crossSectionalArea,
              recommendedArea: wc.crossSectionalArea,
            };
          }

          // Compute this wire's Joule dissipation
          let wireDissipation = 0;
          const I = wire.currentAmps;
          const A = wire.area;
          for (let i = 0; i < wire.N; i++) {
            wireDissipation += I * I * wire.rhoE[i] * config.dx / A;
          }

          // Recommended area to hit 5% of benchmark (RECOMMENDED_MARGIN_PERCENT)
          // P = I^2 * rho_avg * L / A, so A_new = A_old * P_old / P_target
          const activeWireCount = wires.filter((w) => w.currentAmps > 0).length;
          const targetDissipation = (RECOMMENDED_MARGIN_PERCENT / 100) * BENCHMARK_POWER_W / Math.max(activeWireCount, 1);
          const recommendedArea = wireDissipation > 0
            ? wc.crossSectionalArea * (wireDissipation / targetDissipation)
            : wc.crossSectionalArea;

          return {
            wireId: wc.id,
            label: wc.label,
            dissipationW: wireDissipation,
            currentArea: wc.crossSectionalArea,
            recommendedArea: Math.max(recommendedArea, wc.crossSectionalArea),
          };
        });

        setResultA({
          totalJouleDissipationW: totalDissipation,
          benchmarkW: BENCHMARK_POWER_W,
          percentOfBenchmark,
          passed,
          wireBreakdown,
        });
      } catch (err: any) {
        console.error('Routine A failed:', err);
        setResultA(null);
      } finally {
        setRunningA(false);
      }
    }, 50);
  }, [config, plates, wires]);

  /* ===========================================================
     ROUTINE B: Stage-by-Stage Cold-State Thermal Leak Sweep (0A)
     Sweeps NbTi segment length and measures thermal leak
     =========================================================== */
  const runRoutineB = useCallback(() => {
    setRunningB(true);
    setResultB(null);
    setProgressB(0);

    setTimeout(() => {
      try {
        const sweepData: SweepPoint[] = [];
        const lengthsToSweep: number[] = [];

        for (let step = 0; step < sweepSteps; step++) {
          const lengthMm = sweepMinMm + (sweepMaxMm - sweepMinMm) * step / Math.max(sweepSteps - 1, 1);
          lengthsToSweep.push(lengthMm);
        }

        // Determine which wires have NbTi segments
        const nbtiWireIndices: number[] = [];
        for (let wi = 0; wi < wires.length; wi++) {
          if (wires[wi].segments.some((s) => s.materialType === 'nbti')) {
            nbtiWireIndices.push(wi);
          }
        }

        // Find NbTi segment node range for length scaling
        const referenceWire = nbtiWireIndices.length > 0 ? wires[nbtiWireIndices[0]] : wires[0];
        const nbtiSeg = referenceWire.segments.find((s) => s.materialType === 'nbti');
        const nbtiStartNode = nbtiSeg ? nbtiSeg.startNode : 40;
        const nbtiEndNodeBase = nbtiSeg ? nbtiSeg.endNode : 60;
        const baseNbtiNodes = nbtiEndNodeBase - nbtiStartNode;
        const baseNbtiLengthMm = baseNbtiNodes * config.dx * 1000;

        // Track inter-wire plate temperature shifts
        let baselinePlateTemps: Map<number, number> | null = null;
        const plateShifts = new Map<number, number>();

        for (let step = 0; step < sweepSteps; step++) {
          const lengthMm = lengthsToSweep[step];

          // Scale the NbTi end node proportionally to the length
          const scaleFactor = lengthMm / Math.max(baseNbtiLengthMm, 1);
          const newNbtiNodes = Math.max(2, Math.round(baseNbtiNodes * scaleFactor));
          const newEndNode = Math.min(nbtiStartNode + newNbtiNodes, config.numNodes - 2);

          // Recalculate dx to accommodate the new physical length
          const newDx = (lengthMm / 1000) / Math.max(newNbtiNodes, 1);

          // Create modified wire configs with zero current and adjusted NbTi length
          const modifiedWires: WireConfig[] = wires.map((w) => ({
            ...w,
            currentAmps: 0,
            segments: w.segments.map((s) => {
              if (s.materialType === 'nbti') {
                return { ...s, endNode: newEndNode };
              }
              // Adjust segments that come after NbTi
              if (s.startNode > nbtiStartNode) {
                const offset = newEndNode - nbtiEndNodeBase;
                return {
                  ...s,
                  startNode: Math.min(s.startNode + offset, config.numNodes - 1),
                  endNode: Math.min(s.endNode + offset, config.numNodes - 1),
                };
              }
              return s;
            }),
          }));

          // Create config with adjusted dx for this sweep point
          const sweepConfig: SolverConfig = {
            ...config,
            dx: newDx > 0.001 ? newDx : config.dx,
          };

          // Run to steady state with zero current
          const solver = ThermalSolver.computeSteadyState(
            sweepConfig,
            plates,
            modifiedWires,
            5000,
            1e-10,
          );

          // Measure heat leak at the coldest plate node
          const coldPlates = plates
            .filter((p) => p.nodeIndex < config.numNodes / 2)
            .sort((a, b) => a.nodeIndex - b.nodeIndex);
          const measureNode = coldPlates.length > 0 ? coldPlates[0].nodeIndex : 0;

          const leakW = Math.abs(ThermalSolver.computeHeatLeakAtNode(solver, measureNode, sweepConfig.dx));
          const leakMicroW = leakW * 1e6;
          const productQLMicroWm = leakMicroW * (lengthMm / 1000);

          sweepData.push({
            lengthMm,
            leakMicroW,
            productQLMicroWm,
          });

          // Track plate temperatures for inter-wire coupling analysis
          const currentPlateTemps = solver.getPlateTemperatures();
          if (!baselinePlateTemps) {
            baselinePlateTemps = currentPlateTemps;
          } else {
            currentPlateTemps.forEach((temp, plateId) => {
              const baseline = baselinePlateTemps!.get(plateId) || temp;
              const shift = Math.abs(temp - baseline);
              const existingShift = plateShifts.get(plateId) || 0;
              if (shift > existingShift) {
                plateShifts.set(plateId, shift);
              }
            });
          }

          setProgressB(Math.round(((step + 1) / sweepSteps) * 100));
        }

        // Check if dynamic plates are active (inter-wire coupling)
        const hasDynamic = plates.some((p) => p.plateType === 'dynamic');

        setResultB({
          sweepData,
          plateTemperatureShifts: plateShifts,
          interWireCoupled: hasDynamic && wires.length > 1,
        });
      } catch (err: any) {
        console.error('Routine B failed:', err);
        setResultB(null);
      } finally {
        setRunningB(false);
      }
    }, 50);
  }, [config, plates, wires, sweepMinMm, sweepMaxMm, sweepSteps]);

  /* ===========================================================
     RENDER
     =========================================================== */
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#060a10]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-cyan-400 tracking-wide">Optimization Workspace</h2>
        <div className="text-[9px] text-gray-600 uppercase tracking-widest">
          {wires.length} wires | {plates.length} plates | {config.numNodes} nodes
        </div>
      </div>

      {/* ============ ROUTINE A ============ */}
      <div className={sectionCls}>
        <div className="flex items-center justify-between">
          <div>
            <div className={headerCls}>Routine A: High-Current Lead Dominance</div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              Verify total Joule dissipation at 7.5A stays below 10% of {BENCHMARK_POWER_W}W benchmark
            </div>
          </div>
          <button
            className={btnCls}
            onClick={runRoutineA}
            disabled={runningA}
          >
            {runningA ? 'Computing...' : 'Run Check'}
          </button>
        </div>

        {resultA && (
          <div className="space-y-3 mt-3 border-t border-[#21262d] pt-3">
            {/* Summary metrics */}
            <div className="grid grid-cols-3 gap-3">
              <div className={metricBoxCls}>
                <div className={subHeaderCls}>Total Dissipation</div>
                <div className="text-sm font-bold text-cyan-300 font-mono">
                  {resultA.totalJouleDissipationW < 0.001
                    ? (resultA.totalJouleDissipationW * 1e6).toFixed(2) + ' \u00B5W'
                    : resultA.totalJouleDissipationW < 1
                    ? (resultA.totalJouleDissipationW * 1000).toFixed(4) + ' mW'
                    : resultA.totalJouleDissipationW.toFixed(6) + ' W'}
                </div>
              </div>
              <div className={metricBoxCls}>
                <div className={subHeaderCls}>% of Benchmark</div>
                <div className={`text-sm font-bold font-mono ${resultA.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {resultA.percentOfBenchmark.toFixed(4)}%
                </div>
              </div>
              <div className={metricBoxCls}>
                <div className={subHeaderCls}>Status</div>
                <div className={`text-sm font-bold ${resultA.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {resultA.passed ? 'PASS' : 'FAIL'}
                </div>
                <div className="text-[8px] text-gray-600">
                  Threshold: {SAFETY_THRESHOLD_PERCENT}%
                </div>
              </div>
            </div>

            {/* Per-wire breakdown table */}
            <div>
              <div className={subHeaderCls + ' mb-1'}>Per-Wire Breakdown</div>
              <div className="bg-[#0d1117] border border-[#21262d] rounded overflow-hidden">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-[#21262d] text-gray-500">
                      <th className="text-left px-2 py-1.5 font-medium">Wire</th>
                      <th className="text-right px-2 py-1.5 font-medium">Dissipation</th>
                      <th className="text-right px-2 py-1.5 font-medium">Current Area</th>
                      <th className="text-right px-2 py-1.5 font-medium">Recommended Area</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultA.wireBreakdown.map((wb) => (
                      <tr key={wb.wireId} className="border-b border-[#161b22] text-gray-300">
                        <td className="px-2 py-1.5 text-cyan-300">{wb.label}</td>
                        <td className="text-right px-2 py-1.5 font-mono">
                          {wb.dissipationW < 0.001
                            ? (wb.dissipationW * 1e6).toFixed(2) + ' \u00B5W'
                            : (wb.dissipationW * 1000).toFixed(4) + ' mW'}
                        </td>
                        <td className="text-right px-2 py-1.5 font-mono">
                          {wb.currentArea.toExponential(3)} m\u00B2
                        </td>
                        <td className="text-right px-2 py-1.5 font-mono text-amber-400">
                          {wb.recommendedArea.toExponential(3)} m\u00B2
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ============ ROUTINE B ============ */}
      <div className={sectionCls}>
        <div className="flex items-center justify-between">
          <div>
            <div className={headerCls}>Routine B: Cold-State Thermal Leak Sweep</div>
            <div className="text-[10px] text-gray-500 mt-0.5">
              Parametric NbTi length sweep (0A) verifying 1/L leak proportionality through cold stages
            </div>
          </div>
          <button
            className={btnCls}
            onClick={runRoutineB}
            disabled={runningB}
          >
            {runningB ? `${progressB}%` : 'Run Sweep'}
          </button>
        </div>

        {/* Sweep parameters */}
        <div className="grid grid-cols-3 gap-3 mt-2">
          <div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Min Length (mm)</div>
            <input
              type="number"
              className="w-full bg-[#0d1117] border border-[#21262d] rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:border-cyan-500/50 focus:outline-none"
              value={sweepMinMm}
              min={10}
              onChange={(e) => setSweepMinMm(parseFloat(e.target.value) || 100)}
            />
          </div>
          <div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Max Length (mm)</div>
            <input
              type="number"
              className="w-full bg-[#0d1117] border border-[#21262d] rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:border-cyan-500/50 focus:outline-none"
              value={sweepMaxMm}
              min={sweepMinMm + 10}
              onChange={(e) => setSweepMaxMm(parseFloat(e.target.value) || 200)}
            />
          </div>
          <div>
            <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">Steps</div>
            <input
              type="number"
              className="w-full bg-[#0d1117] border border-[#21262d] rounded px-2 py-1 text-xs text-cyan-300 font-mono focus:border-cyan-500/50 focus:outline-none"
              value={sweepSteps}
              min={3}
              max={50}
              onChange={(e) => setSweepSteps(parseInt(e.target.value) || 11)}
            />
          </div>
        </div>

        {resultB && (
          <div className="space-y-3 mt-3 border-t border-[#21262d] pt-3">
            {/* Sweep data table */}
            <div>
              <div className={subHeaderCls + ' mb-1'}>Sweep Results (Thermal Leak vs Length)</div>
              <div className="bg-[#0d1117] border border-[#21262d] rounded overflow-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-[#0d1117]">
                    <tr className="border-b border-[#21262d] text-gray-500">
                      <th className="text-left px-2 py-1.5 font-medium">Length (mm)</th>
                      <th className="text-right px-2 py-1.5 font-medium">Leak (\u00B5W)</th>
                      <th className="text-right px-2 py-1.5 font-medium">Q*L (\u00B5W*m)</th>
                      <th className="text-right px-2 py-1.5 font-medium">1/L Valid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultB.sweepData.map((pt, idx) => {
                      // Check if Q*L is approximately constant (validates 1/L proportionality)
                      const avgQL = resultB.sweepData.reduce((sum, p) => sum + p.productQLMicroWm, 0) / resultB.sweepData.length;
                      const deviation = avgQL > 0 ? Math.abs(pt.productQLMicroWm - avgQL) / avgQL * 100 : 0;
                      const isValid = deviation < 15; // Within 15% of mean

                      return (
                        <tr key={idx} className="border-b border-[#161b22] text-gray-300">
                          <td className="px-2 py-1 font-mono">{pt.lengthMm.toFixed(1)}</td>
                          <td className="text-right px-2 py-1 font-mono text-cyan-300">
                            {pt.leakMicroW.toFixed(4)}
                          </td>
                          <td className="text-right px-2 py-1 font-mono text-amber-300">
                            {pt.productQLMicroWm.toFixed(6)}
                          </td>
                          <td className="text-right px-2 py-1">
                            <span className={isValid ? 'text-emerald-400' : 'text-red-400'}>
                              {isValid ? 'OK' : `${deviation.toFixed(1)}%`}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 1/L Proportionality Summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className={metricBoxCls}>
                <div className={subHeaderCls}>Q*L Product (mean)</div>
                <div className="text-sm font-bold text-amber-300 font-mono">
                  {(resultB.sweepData.reduce((sum, p) => sum + p.productQLMicroWm, 0) / resultB.sweepData.length).toFixed(6)} \u00B5W*m
                </div>
                <div className="text-[8px] text-gray-600 mt-0.5">
                  Should be constant if leak ~ 1/L
                </div>
              </div>
              <div className={metricBoxCls}>
                <div className={subHeaderCls}>Q*L Std Dev</div>
                <div className="text-sm font-bold text-purple-400 font-mono">
                  {(() => {
                    const values = resultB.sweepData.map((p) => p.productQLMicroWm);
                    const mean = values.reduce((a, b) => a + b, 0) / values.length;
                    const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
                    return Math.sqrt(variance).toFixed(6);
                  })()}
                </div>
                <div className="text-[8px] text-gray-600 mt-0.5">
                  Low value confirms 1/L
                </div>
              </div>
            </div>

            {/* Inter-wire coupling report */}
            {resultB.interWireCoupled && (
              <div className="bg-[#0d1117] border border-cyan-500/20 rounded p-3">
                <div className="text-[10px] text-cyan-400 font-semibold uppercase tracking-wider mb-1">
                  Inter-Wire Coupling Report (Dynamic Plates Active)
                </div>
                <div className="text-[9px] text-gray-400 space-y-0.5">
                  {Array.from(resultB.plateTemperatureShifts.entries()).map(([plateId, shift]) => (
                    <div key={plateId} className="flex justify-between">
                      <span>Plate #{plateId} max temperature drift:</span>
                      <span className="text-amber-400 font-mono">
                        {shift < 0.001
                          ? (shift * 1e6).toFixed(2) + ' \u00B5K'
                          : shift < 1
                          ? (shift * 1000).toFixed(4) + ' mK'
                          : shift.toFixed(6) + ' K'}
                      </span>
                    </div>
                  ))}
                  {resultB.plateTemperatureShifts.size === 0 && (
                    <div className="text-gray-600">No measurable plate drift detected in sweep range.</div>
                  )}
                </div>
              </div>
            )}

            {!resultB.interWireCoupled && (
              <div className="bg-[#0d1117] border border-[#21262d] rounded p-2">
                <div className="text-[9px] text-gray-600">
                  Inter-wire coupling inactive. Enable Dynamic plates and add multiple wires to see coupling effects.
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div className="text-[8px] text-gray-700 text-center pt-2 border-t border-[#21262d]">
        Optimization routines use independent solver instances. Main simulation is unaffected during sweep execution.
      </div>
    </div>
  );
};

export default OptimizationPanel;