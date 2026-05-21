// src/core/solver.ts
// Complete Crank-Nicolson Multi-Wire Thermal Solver with Three-State Boundaries

import type { SolverConfig, Plate, PlateType, MaterialType, NodeState, WireConfig, StepResult } from '../types';
import { interpolateTabulated, COPPER, NBTI, type MaterialTable } from '../constants/materials';

/* ===================================================================
   FRIDGE COOLING CURVE
   Smooth tanh-based model:
   Q_fridge(T) = Q_capacity * tanh(T / 4.2)
   =================================================================== */
function fridgeCoolingPower(T: number, coolingCapacityWatts: number): number {
  if (T <= 0) return 0;
  return coolingCapacityWatts * Math.tanh(T / 4.2);
}

function fridgeCoolingDerivative(T: number, coolingCapacityWatts: number): number {
  if (T <= 0) return 0;
  const sech = 1.0 / Math.cosh(T / 4.2);
  return coolingCapacityWatts * sech * sech / 4.2;
}

/* ===================================================================
   PlateState - Runtime state for dynamic/resistor plates
   =================================================================== */
interface PlateRuntime {
  plate: Plate;
  currentTemperature: number;
}

/* ===================================================================
   WireSolverState
   Per-wire numerical state and Crank-Nicolson solver.
   =================================================================== */
export class WireSolverState {
  readonly wireId: number;
  readonly N: number;
  readonly area: number;
  currentAmps: number;
  temperatures: Float64Array;
  k: Float64Array;
  cp: Float64Array;
  rhoE: Float64Array;
  rho: Float64Array;
  materialType: MaterialType[];
  plateTypeAtNode: (PlateType | null)[];
  plateConfigAtNode: (Plate | null)[];
  isFixed: boolean[];
  fixedTemps: Float64Array;

  // Pre-allocated tridiagonal work arrays (allocation-free Thomas solve)
  private lower: Float64Array;
  private diag: Float64Array;
  private upper: Float64Array;
  private rhs: Float64Array;
  private cprime: Float64Array;
  private dprime: Float64Array;

  constructor(wireConfig: WireConfig, N: number, plates: Plate[]) {
    this.wireId = wireConfig.id;
    this.N = N;
    this.area = wireConfig.crossSectionalArea;
    this.currentAmps = wireConfig.currentAmps;

    this.temperatures = new Float64Array(N);
    this.k = new Float64Array(N);
    this.cp = new Float64Array(N);
    this.rhoE = new Float64Array(N);
    this.rho = new Float64Array(N);
    this.materialType = new Array<MaterialType>(N).fill('copper');
    this.isFixed = new Array<boolean>(N).fill(false);
    this.fixedTemps = new Float64Array(N);
    this.plateTypeAtNode = new Array<PlateType | null>(N).fill(null);
    this.plateConfigAtNode = new Array<Plate | null>(N).fill(null);

    // Pre-allocate Thomas algorithm work arrays
    this.lower = new Float64Array(N);
    this.diag = new Float64Array(N);
    this.upper = new Float64Array(N);
    this.rhs = new Float64Array(N);
    this.cprime = new Float64Array(N);
    this.dprime = new Float64Array(N);

    // Assign materials from wire-specific segments
    for (const seg of wireConfig.segments) {
      const lo = Math.max(0, seg.startNode);
      const hi = Math.min(N - 1, seg.endNode);
      for (let i = lo; i <= hi; i++) this.materialType[i] = seg.materialType;
    }

    // Register plates with three-state logic
    const sorted = [...plates]
      .map((p) => ({ ...p, nodeIndex: Math.max(0, Math.min(p.nodeIndex, N - 1)) }))
      .sort((a, b) => a.nodeIndex - b.nodeIndex);

    for (const p of sorted) {
      const idx = p.nodeIndex;
      this.plateTypeAtNode[idx] = p.plateType;
      this.plateConfigAtNode[idx] = p;

      if (p.plateType === 'fixed') {
        this.isFixed[idx] = true;
        this.fixedTemps[idx] = p.temperature;
      } else {
        // Dynamic and resistor nodes participate in the matrix system
        this.isFixed[idx] = false;
      }
    }

    // Ensure last node has a valid boundary (Dirichlet fallback)
    if (!this.plateTypeAtNode[N - 1]) {
      this.isFixed[N - 1] = true;
      this.fixedTemps[N - 1] = sorted.length > 0 ? sorted[sorted.length - 1].temperature : 300;
    }

    // Initial temperatures: linear interpolation between all plates
    this.initTemperatures(sorted);

    // Compute initial material properties
    this.updateMaterialProperties();
  }

  private initTemperatures(sorted: Plate[]): void {
    if (sorted.length === 0) {
      this.temperatures.fill(4.0);
      return;
    }
    let cp = 0;
    for (let i = 0; i < this.N; i++) {
      if (cp + 1 < sorted.length && i > sorted[cp + 1].nodeIndex) cp++;
      if (i === sorted[cp].nodeIndex) {
        this.temperatures[i] = sorted[cp].temperature;
        continue;
      }
      if (cp + 1 >= sorted.length) {
        this.temperatures[i] = sorted[cp].temperature;
        continue;
      }
      const n0 = sorted[cp].nodeIndex;
      const n1 = sorted[cp + 1].nodeIndex;
      const t0 = sorted[cp].temperature;
      const t1 = sorted[cp + 1].temperature;
      const frac = (i - n0) / (n1 - n0);
      this.temperatures[i] = t0 + frac * (t1 - t0);
    }
  }

  updateMaterialProperties(): void {
    for (let i = 0; i < this.N; i++) {
      const T = Math.max(this.temperatures[i], 0.01);
      const mat: MaterialTable = this.materialType[i] === 'copper' ? COPPER : NBTI;
      this.k[i] = Math.max(interpolateTabulated(T, mat.temperatures, mat.k), 1e-12);
      this.cp[i] = Math.max(interpolateTabulated(T, mat.temperatures, mat.cp), 1e-8);
      this.rhoE[i] = Math.max(interpolateTabulated(T, mat.temperatures, mat.rhoE), 0);
      this.rho[i] = mat.rho;
    }
  }

  /* ===========================================================
     CRANK-NICOLSON IMPLICIT STEP (Three-State Boundary Logic)

     PDE: rho*Cp * dT/dt = d/dx(k * dT/dx) + I^2*rhoE/A^2 + qExt

     Crank-Nicolson (theta=0.5):
       gamma = rho_i*Cp_i / dt
       alpha_i = k_{i-1/2} / dx^2  (harmonic mean)
       beta_i  = k_{i+1/2} / dx^2  (harmonic mean)

       LHS: -0.5*alpha * T_{i-1}^{n+1}
            + (gamma + 0.5*(alpha+beta)) * T_i^{n+1}
            - 0.5*beta * T_{i+1}^{n+1}

       RHS: 0.5*alpha * T_{i-1}^n
            + (gamma - 0.5*(alpha+beta)) * T_i^n
            + 0.5*beta * T_{i+1}^n
            + source

     Boundary Modes:
       'fixed'    -> diag=1, lower=upper=0, rhs=T_fixed (Dirichlet)
       'dynamic'  -> participates in CN system with cooling sink term
       'resistor' -> participates in CN system with Joule source injection
       Node 0 (no plate): Neumann (insulated) via ghost-node symmetry
     =========================================================== */
  crankNicolsonStep(dt: number, dx: number, qExt: number): void {
    const N = this.N;
    const dx2 = dx * dx;
    const current = this.currentAmps;
    const A = this.area;
    const A2 = A * A;

    for (let i = 0; i < N; i++) {
      // -------- FIXED (Dirichlet) BOUNDARY --------
      if (this.isFixed[i]) {
        this.lower[i] = 0;
        this.diag[i] = 1;
        this.upper[i] = 0;
        this.rhs[i] = this.fixedTemps[i];
        continue;
      }

      // Compute gamma (temporal inertia coefficient)
      const gamma = this.rho[i] * this.cp[i] / dt;

      // Base volumetric source: Joule heating + external power
      let source = current * current * this.rhoE[i] / A2 + qExt;

      // -------- RESISTOR BOUNDARY NODE --------
      // Inject lumped Joule heating Q = I^2 * R into the volumetric source
      // Converted to W/m^3 by dividing by cell volume (A * dx)
      const plateConfig = this.plateConfigAtNode[i];
      const plateType = this.plateTypeAtNode[i];

      if (plateType === 'resistor' && plateConfig && plateConfig.resistanceOhms) {
        const qResistor = current * current * plateConfig.resistanceOhms / (A * dx);
        source += qResistor;
      }

      // -------- DYNAMIC COOLING PLATE --------
      // Linearized implicit cooling: adds damping to diagonal and base load to RHS
      // Q_fridge(T) ~ Q_fridge(T_n) + dQ/dT|_n * (T^{n+1} - T_n)
      // This creates additional diagonal stiffness and RHS correction
      let dynamicDiagExtra = 0;
      let dynamicRhsExtra = 0;

      if (plateType === 'dynamic' && plateConfig) {
        const Qcap = plateConfig.coolingCapacityWatts || 0;
        const Cplate = plateConfig.heatCapacityJK || 1.0;
        const Tn = this.temperatures[i];

        // Fridge cooling at current temperature
        const Qfridge_n = fridgeCoolingPower(Tn, Qcap);
        const dQfridge_dT = fridgeCoolingDerivative(Tn, Qcap);

        // Convert cooling power to volumetric rate (W/m^3)
        // The plate acts as a localized heat sink distributed over one cell volume
        const cellVolume = A * dx;
        const coolingVolumetric = Qfridge_n / cellVolume;
        const coolingDerivVolumetric = dQfridge_dT / cellVolume;

        // Linearized implicit treatment:
        // Cooling term in equation: -Q_fridge(T^{n+1}) / (A*dx)
        //   ~ -(Qfridge_n + dQfridge_dT * (T^{n+1} - Tn)) / cellVolume
        // Move the T^{n+1} part to LHS (adds to diagonal)
        // Keep the constant part on RHS
        dynamicDiagExtra = 0.5 * coolingDerivVolumetric;
        dynamicRhsExtra = -coolingVolumetric + coolingDerivVolumetric * Tn;
        // The 0.5 factor on diagonal is the CN temporal centering
        // Net effect: stabilizes the cooling sink implicitly
      }

      // -------- CONSTRUCT MATRIX ROW --------
      if (i === 0) {
        // Node 0: Neumann BC via ghost-node symmetry (T_{-1} = T_1) unless it's a plate
        const kHalf = (this.k[0] + this.k[1] > 0)
          ? (2 * this.k[0] * this.k[1]) / (this.k[0] + this.k[1])
          : 0;
        const betaEff = 2.0 * kHalf / dx2;

        this.lower[i] = 0;
        this.diag[i] = gamma + 0.5 * betaEff + dynamicDiagExtra;
        this.upper[i] = -0.5 * betaEff;
        this.rhs[i] = (gamma - 0.5 * betaEff) * this.temperatures[0]
                    + 0.5 * betaEff * this.temperatures[1]
                    + source + dynamicRhsExtra;
      } else if (i === N - 1) {
        // Last node that isn't fixed - Neumann on the right side
        const kHalf = (this.k[N - 2] + this.k[N - 1] > 0)
          ? (2 * this.k[N - 2] * this.k[N - 1]) / (this.k[N - 2] + this.k[N - 1])
          : 0;
        const alphaEff = 2.0 * kHalf / dx2;

        this.lower[i] = -0.5 * alphaEff;
        this.diag[i] = gamma + 0.5 * alphaEff + dynamicDiagExtra;
        this.upper[i] = 0;
        this.rhs[i] = 0.5 * alphaEff * this.temperatures[N - 2]
                    + (gamma - 0.5 * alphaEff) * this.temperatures[N - 1]
                    + source + dynamicRhsExtra;
      } else {
        // Interior nodes (1 <= i <= N-2)
        const kL = (this.k[i - 1] + this.k[i] > 0)
          ? (2 * this.k[i - 1] * this.k[i]) / (this.k[i - 1] + this.k[i])
          : 0;
        const kR = (this.k[i] + this.k[i + 1] > 0)
          ? (2 * this.k[i] * this.k[i + 1]) / (this.k[i] + this.k[i + 1])
          : 0;

        const alpha = kL / dx2;
        const beta = kR / dx2;

        this.lower[i] = -0.5 * alpha;
        this.diag[i] = gamma + 0.5 * (alpha + beta) + dynamicDiagExtra;
        this.upper[i] = -0.5 * beta;
        this.rhs[i] = 0.5 * alpha * this.temperatures[i - 1]
                    + (gamma - 0.5 * (alpha + beta)) * this.temperatures[i]
                    + 0.5 * beta * this.temperatures[i + 1]
                    + source + dynamicRhsExtra;
      }
    }

    // Solve tridiagonal system using Thomas Algorithm
    this.thomasSolve();
  }

  /* ===========================================================
     THOMAS ALGORITHM (Tridiagonal Matrix Algorithm)
     Allocation-free, in-place forward/back sweep.
     =========================================================== */
  private thomasSolve(): void {
    const N = this.N;
    const a = this.lower;
    const b = this.diag;
    const c = this.upper;
    const d = this.rhs;
    const cp = this.cprime;
    const dp = this.dprime;

    // Forward sweep
    cp[0] = c[0] / b[0];
    dp[0] = d[0] / b[0];

    for (let i = 1; i < N; i++) {
      const denom = b[i] - a[i] * cp[i - 1];
      if (Math.abs(denom) < 1e-30) {
        // Prevent division by zero - use fallback
        cp[i] = 0;
        dp[i] = dp[i - 1];
      } else {
        cp[i] = c[i] / denom;
        dp[i] = (d[i] - a[i] * dp[i - 1]) / denom;
      }
    }

    // Back substitution
    this.temperatures[N - 1] = dp[N - 1];
    for (let i = N - 2; i >= 0; i--) {
      this.temperatures[i] = dp[i] - cp[i] * this.temperatures[i + 1];
    }
  }

  /* ===========================================================
     Compute conductive heat flux at a specific node index
     Q = A * k * dT/dx (using central/one-sided differences)
     Returns positive value = heat flowing INTO the node
     =========================================================== */
  computeHeatFluxAtNode(nodeIdx: number, dx: number): number {
    const i = nodeIdx;
    const A = this.area;
    let qNet = 0;

    if (i > 0) {
      const kL = (this.k[i - 1] + this.k[i] > 0)
        ? (2 * this.k[i - 1] * this.k[i]) / (this.k[i - 1] + this.k[i])
        : 0;
      // Heat flux from left neighbor into node i
      qNet += A * kL * (this.temperatures[i - 1] - this.temperatures[i]) / dx;
    }

    if (i < this.N - 1) {
      const kR = (this.k[i] + this.k[i + 1] > 0)
        ? (2 * this.k[i] * this.k[i + 1]) / (this.k[i] + this.k[i + 1])
        : 0;
      // Heat flux from right neighbor into node i
      qNet += A * kR * (this.temperatures[i + 1] - this.temperatures[i]) / dx;
    }

    return qNet;
  }

  getNodeState(idx: number): NodeState {
    const i = Math.max(0, Math.min(idx, this.N - 1));
    return {
      temperature: this.temperatures[i],
      k: this.k[i],
      cp: this.cp[i],
      rho: this.rho[i],
      rhoE: this.rhoE[i],
      isFixed: this.isFixed[i],
      isPlate: this.plateTypeAtNode[i] !== null,
      plateType: this.plateTypeAtNode[i],
      materialName: this.materialType[i],
    };
  }
}

/* ===================================================================
   ThermalSolver (Multi-Wire with Inter-Wire Plate Coupling)
   =================================================================== */
export class ThermalSolver {
  readonly N: number;
  readonly dx: number;
  readonly wires: WireSolverState[];
  private wireMap: Map<number, WireSolverState>;
  private plates: Plate[];
  private plateRuntimes: PlateRuntime[];

  // Adaptive dt state
  private lastMaxDeltaT: number = 0;
  private dtReductionActive: boolean = false;
  private static readonly MAX_DELTA_T_THRESHOLD = 50.0;
  private static readonly DT_REDUCTION_FACTOR = 0.25;
  private static readonly MAX_SUBSTEPS = 5;

  constructor(config: SolverConfig, plates: Plate[], wireConfigs: WireConfig[]) {
    this.N = Math.max(3, config.numNodes);
    this.dx = config.dx;
    this.plates = plates;
    this.wires = [];
    this.wireMap = new Map();

    // Initialize plate runtimes
    this.plateRuntimes = plates.map((p) => ({
      plate: p,
      currentTemperature: p.temperature,
    }));

    for (const wc of wireConfigs) {
      const ws = new WireSolverState(wc, this.N, plates);
      this.wires.push(ws);
      this.wireMap.set(wc.id, ws);
    }
  }

  /* ===========================================================
     MAIN STEP: Orchestrates wire solves + dynamic plate updates
     Implements adaptive dt with safety net
     =========================================================== */
  step(
    dt: number,
    powerFn: ((t: number) => number) | null,
    t: number,
  ): StepResult {
    let qExt = 0;
    if (powerFn) {
      try { qExt = powerFn(t); } catch { qExt = 0; }
    }

    // Store previous temperatures for delta check
    const prevTemps: Float64Array[] = this.wires.map(
      (w) => new Float64Array(w.temperatures)
    );

    // Adaptive substep logic
    let actualDt = dt;
    let substeps = 1;
    let dtWasReduced = false;

    // Attempt the step, potentially with reduced dt
    for (let attempt = 0; attempt < ThermalSolver.MAX_SUBSTEPS; attempt++) {
      const subDt = dt / substeps;

      // Reset temperatures to start of this attempt
      if (attempt > 0) {
        for (let w = 0; w < this.wires.length; w++) {
          this.wires[w].temperatures.set(prevTemps[w]);
        }
        // Reset dynamic plate temperatures
        for (const pr of this.plateRuntimes) {
          if (pr.plate.plateType === 'dynamic') {
            const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));
            pr.currentTemperature = prevTemps[0][nodeIdx];
          }
        }
      }

      let maxDelta = 0;

      for (let sub = 0; sub < substeps; sub++) {
        // Update material properties based on current temperatures
        for (const wire of this.wires) {
          wire.updateMaterialProperties();
        }

        // Synchronize dynamic plate temperatures across wires BEFORE solve
        this.syncDynamicPlateTemperatures();

        // Solve each wire independently with current plate states
        for (const wire of this.wires) {
          wire.crankNicolsonStep(subDt, this.dx, qExt);
        }

        // Update dynamic plate temperatures based on net heat flow from ALL wires
        this.updateDynamicPlates(subDt);

        // Compute maximum delta T across entire grid
        for (let w = 0; w < this.wires.length; w++) {
          for (let i = 0; i < this.N; i++) {
            const delta = Math.abs(this.wires[w].temperatures[i] - prevTemps[w][i]);
            if (delta > maxDelta) maxDelta = delta;
          }
        }
      }

      this.lastMaxDeltaT = maxDelta;

      // Check convergence safety
      if (maxDelta > ThermalSolver.MAX_DELTA_T_THRESHOLD) {
        substeps *= 4;
        dtWasReduced = true;
        if (substeps > Math.pow(4, ThermalSolver.MAX_SUBSTEPS)) {
          // Cannot converge even with maximum reduction
          this.dtReductionActive = true;
          actualDt = dt / substeps;
          break;
        }
        continue;
      } else {
        actualDt = dt / substeps;
        this.dtReductionActive = substeps > 1;
        break;
      }
    }

    // Validate final state
    this.validate();

    // Collect plate temperatures
    const plateTemps = new Map<number, number>();
    for (const pr of this.plateRuntimes) {
      plateTemps.set(pr.plate.id, pr.currentTemperature);
    }

    return {
      maxDeltaT: this.lastMaxDeltaT,
      actualDt,
      dtWasReduced,
      plateTemperatures: plateTemps,
    };
  }

  /* ===========================================================
     DYNAMIC PLATE UPDATE
     After all wires have been solved for a sub-step,
     compute net heat flow into each dynamic plate from all wires,
     then update the plate temperature:
     dT_plate = (Q_wires - Q_fridge(T_plate)) * dt / C_plate
     =========================================================== */
  private updateDynamicPlates(dt: number): void {
    for (const pr of this.plateRuntimes) {
      if (pr.plate.plateType !== 'dynamic') continue;

      const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));
      const Qcap = pr.plate.coolingCapacityWatts || 0;
      const Cplate = pr.plate.heatCapacityJK || 1.0;

      // Sum conductive heat flux from ALL wires at this plate node
      let totalQwires = 0;
      for (const wire of this.wires) {
        totalQwires += wire.computeHeatFluxAtNode(nodeIdx, this.dx);
      }

      // Fridge cooling power at current plate temperature
      const Qfridge = fridgeCoolingPower(pr.currentTemperature, Qcap);

      // Temperature update
      const deltaT = (totalQwires - Qfridge) * dt / Cplate;
      pr.currentTemperature += deltaT;

      // Enforce physical minimum (cannot go below 1 mK)
      if (pr.currentTemperature < 0.001) {
        pr.currentTemperature = 0.001;
      }
    }
  }

  /* ===========================================================
     SYNC DYNAMIC PLATE TEMPERATURES
     Propagates updated plate temperatures back to all wire nodes
     so the next solve step uses the coupled state.
     This implements inter-wire coupling via shared plate nodes.
     =========================================================== */
  private syncDynamicPlateTemperatures(): void {
    for (const pr of this.plateRuntimes) {
      if (pr.plate.plateType !== 'dynamic') continue;

      const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));

      // Average the wire temperatures at this node to determine plate temperature
      let avgTemp = 0;
      let count = 0;
      for (const wire of this.wires) {
        avgTemp += wire.temperatures[nodeIdx];
        count++;
      }

      if (count > 0) {
        // Blend: plate tracks the average wire temperature at the junction
        // but weighted by its thermal inertia
        const wireAvg = avgTemp / count;
        const Cplate = pr.plate.heatCapacityJK || 1.0;
        // Use a relaxation: heavier plates are slower to respond
        const relaxation = Math.min(1.0, 1.0 / (1.0 + Cplate * 0.01));
        pr.currentTemperature = pr.currentTemperature * (1 - relaxation) + wireAvg * relaxation;
      }

      // Write plate temperature back to all wires at this node
      for (const wire of this.wires) {
        wire.temperatures[nodeIdx] = pr.currentTemperature;
      }
    }
  }

  /* ===========================================================
     VALIDATION
     Check all wire temperatures for physical sanity.
     =========================================================== */
  private validate(): void {
    for (const wire of this.wires) {
      for (let i = 0; i < wire.N; i++) {
        const T = wire.temperatures[i];
        if (!isFinite(T))
          throw new Error(`Solver error: NaN/Inf on wire "${wire.wireId}" at node ${i}`);
        if (T < 0)
          throw new Error(`Solver error: T < 0 K on wire "${wire.wireId}" node ${i} (T=${T.toExponential(3)})`);
        if (T > 10000)
          throw new Error(`Solver error: T > 10000 K on wire "${wire.wireId}" node ${i} (T=${T.toExponential(3)})`);
      }
    }
  }

  /* ===========================================================
     PUBLIC ACCESSORS
     =========================================================== */
  getWireTemperatures(wireId: number): Float64Array {
    const w = this.wireMap.get(wireId);
    return w ? w.temperatures : new Float64Array(0);
  }

  getAllTemperatures(): Map<number, Float64Array> {
    const result = new Map<number, Float64Array>();
    for (const wire of this.wires) {
      result.set(wire.wireId, new Float64Array(wire.temperatures));
    }
    return result;
  }

  getWireNodeState(wireId: number, nodeIndex: number): NodeState | null {
    const w = this.wireMap.get(wireId);
    if (!w) return null;
    return w.getNodeState(nodeIndex);
  }

  getGlobalMinMax(): { minT: number; maxT: number } {
    let minT = Infinity;
    let maxT = -Infinity;
    for (const wire of this.wires) {
      for (let i = 0; i < wire.N; i++) {
        const T = wire.temperatures[i];
        if (T < minT) minT = T;
        if (T > maxT) maxT = T;
      }
    }
    return { minT, maxT };
  }

  getPlateTemperatures(): Map<number, number> {
    const result = new Map<number, number>();
    for (const pr of this.plateRuntimes) {
      result.set(pr.plate.id, pr.currentTemperature);
    }
    return result;
  }

  getDtReductionActive(): boolean {
    return this.dtReductionActive;
  }

  getLastMaxDeltaT(): number {
    return this.lastMaxDeltaT;
  }

  /* ===========================================================
     STATIC UTILITIES for Optimization Routines
     =========================================================== */
  static computeSteadyState(
    config: SolverConfig,
    plates: Plate[],
    wireConfigs: WireConfig[],
    maxIterations: number = 5000,
    convergenceThreshold: number = 1e-8,
  ): ThermalSolver {
    const solver = new ThermalSolver(config, plates, wireConfigs);
    const dt = config.dt;

    for (let iter = 0; iter < maxIterations; iter++) {
      const prevTemps = solver.wires.map((w) => new Float64Array(w.temperatures));

      for (const wire of solver.wires) {
        wire.updateMaterialProperties();
      }
      solver.syncDynamicPlateTemperatures();
      for (const wire of solver.wires) {
        wire.crankNicolsonStep(dt, solver.dx, 0);
      }
      solver.updateDynamicPlates(dt);

      // Check convergence
      let maxDelta = 0;
      for (let w = 0; w < solver.wires.length; w++) {
        for (let i = 0; i < solver.N; i++) {
          const delta = Math.abs(solver.wires[w].temperatures[i] - prevTemps[w][i]);
          if (delta > maxDelta) maxDelta = delta;
        }
      }

      if (maxDelta < convergenceThreshold) break;
    }

    return solver;
  }

  static computeTotalJouleDissipation(solver: ThermalSolver, dx: number): number {
    let totalPower = 0;
    for (const wire of solver.wires) {
      const I = wire.currentAmps;
      if (I === 0) continue;
      const A = wire.area;
      for (let i = 0; i < wire.N; i++) {
        // P = I^2 * rhoE * dx / A  (power per node segment)
        const segPower = I * I * wire.rhoE[i] * dx / A;
        totalPower += segPower;
      }
    }
    return totalPower;
  }

  static computeHeatLeakAtNode(solver: ThermalSolver, nodeIdx: number, dx: number): number {
    let totalLeak = 0;
    for (const wire of solver.wires) {
      totalLeak += wire.computeHeatFluxAtNode(nodeIdx, dx);
    }
    return totalLeak;
  }
}