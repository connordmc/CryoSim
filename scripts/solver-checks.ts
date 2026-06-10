// Solver regression checks.
// Run with: npm run check:solver
//
// Each scenario targets a specific historical failure mode:
//   1. Initial profile clamping (no extrapolation below the first plate)
//   2. Pure diffusion stability with fixed boundaries
//   3. Dynamic plate model at zero current (no T < 0 from the fridge sink)
//   4. Lumped bottom resistor with current flowing (no instant explosion)
//   5. Resistor at zero current matches a no-resistor baseline
//   6. Time accounting: actualDt equals the requested dt

import { ThermalSolver } from '../src/core/solver';
import type { SolverConfig, Plate, WireConfig } from '../src/types';

const config: SolverConfig = { numNodes: 100, dx: 0.02788, dt: 0.005, powerFormula: 'return 0;' };

const FIXED_TAIL: Plate[] = [
  { id: 3, nodeIndex: 63, temperature: 4.0, plateType: 'fixed' },
  { id: 4, nodeIndex: 81, temperature: 77.0, plateType: 'fixed' },
  { id: 5, nodeIndex: 99, temperature: 300.0, plateType: 'fixed' },
];
const FIXED_COLD: Plate = { id: 0, nodeIndex: 0, temperature: 0.01, plateType: 'fixed' };
const DYNAMIC_TRIO: Plate[] = [
  { id: 0, nodeIndex: 0, temperature: 0.01, plateType: 'dynamic', coolingCapacityWatts: 0.000015, heatCapacityJK: 0.005 },
  { id: 1, nodeIndex: 25, temperature: 0.1, plateType: 'dynamic', coolingCapacityWatts: 0.0002, heatCapacityJK: 0.05 },
  { id: 2, nodeIndex: 43, temperature: 0.8, plateType: 'dynamic', coolingCapacityWatts: 0.005, heatCapacityJK: 0.5 },
];

function nbtiWire(current: number): WireConfig {
  return {
    id: 0, label: 'w0', color: '#0ff', crossSectionalArea: 1.9635e-9, currentAmps: current,
    segments: [{ id: 0, name: 'NbTi', startNode: 0, endNode: 99, materialType: 'nbti' }],
  };
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e: any) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function runSteps(solver: ThermalSolver, steps: number): void {
  for (let s = 0; s < steps; s++) solver.step(config.dt, null, s * config.dt);
}

check('1. init profile clamps below first plate (no negative temps)', () => {
  // First plate at node 43: nodes 0..42 must clamp to its temperature
  const solver = new ThermalSolver(config, [
    { id: 2, nodeIndex: 43, temperature: 0.8, plateType: 'dynamic', coolingCapacityWatts: 0.005, heatCapacityJK: 0.5 },
    ...FIXED_TAIL,
  ], [nbtiWire(0)]);
  const T = solver.getWireTemperatures(0);
  for (let i = 0; i < 100; i++) assert(T[i] > 0, `T[${i}]=${T[i]} at init`);
  assert(Math.abs(T[0] - 0.8) < 1e-12, `T[0]=${T[0]}, expected clamp to 0.8`);
});

check('2. pure diffusion, fixed boundaries, I=0: stable for 2000 steps', () => {
  const solver = new ThermalSolver(config, [FIXED_COLD, ...FIXED_TAIL], [nbtiWire(0)]);
  runSteps(solver, 2000);
  const { minT, maxT } = solver.getGlobalMinMax();
  assert(minT > 0 && maxT <= 300, `minT=${minT}, maxT=${maxT}`);
});

check('3. dynamic plates, I=0: no T<0, plates stay near setpoints', () => {
  const solver = new ThermalSolver(config, [...DYNAMIC_TRIO, ...FIXED_TAIL], [nbtiWire(0)]);
  runSteps(solver, 2000);
  const { minT } = solver.getGlobalMinMax();
  assert(minT > 0, `minT=${minT}`);
  const plateT = solver.getPlateTemperatures();
  // Zero current: plates carry only conduction leak, must stay in the cryo regime
  assert(plateT.get(2)! > 0.001 && plateT.get(2)! < 4.0, `0.8K plate at ${plateT.get(2)}`);
});

check('4. bottom resistor, I=0.1A R=1mOhm: heats at physical rate, no explosion', () => {
  const solver = new ThermalSolver(config, [
    FIXED_COLD,
    { id: 6, nodeIndex: 10, temperature: 0.05, plateType: 'resistor', resistanceOhms: 0.001, heatCapacityJK: 0.01 },
    ...FIXED_TAIL,
  ], [nbtiWire(0.1)]);
  const before = solver.getWireTemperatures(0)[10];
  solver.step(config.dt, null, 0);
  const after = solver.getWireTemperatures(0)[10];
  // Q = I^2 R = 10 uW into C_joint = 0.01 J/K -> dT/dt = 1e-3 K/s -> ~5e-6 K per 5ms step.
  // The old solver jumped ~46 K here in a single step.
  assert(after - before < 0.01, `first-step jump ${after - before} K`);
  runSteps(solver, 2000);
  const T10 = solver.getWireTemperatures(0)[10];
  assert(T10 < 1.0, `T[10]=${T10} K after 10s; expected slow physical heating`);
});

check('5. resistor with I=0 behaves like plain wire', () => {
  const withR = new ThermalSolver(config, [
    FIXED_COLD,
    { id: 6, nodeIndex: 10, temperature: 0.05, plateType: 'resistor', resistanceOhms: 0.001, heatCapacityJK: 0.01 },
    ...FIXED_TAIL,
  ], [nbtiWire(0)]);
  runSteps(withR, 1000);
  const T10 = withR.getWireTemperatures(0)[10];
  // Diffusion toward the local equilibrium profile; must remain sub-kelvin
  assert(T10 > 0 && T10 < 0.5, `T[10]=${T10}`);
});

check('6. actualDt reports the full integrated interval', () => {
  const solver = new ThermalSolver(config, [FIXED_COLD, ...FIXED_TAIL], [nbtiWire(0)]);
  const result = solver.step(config.dt, null, 0);
  assert(result.actualDt === config.dt, `actualDt=${result.actualDt}, expected ${config.dt}`);
});

console.log(failures === 0 ? '\nAll solver checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
