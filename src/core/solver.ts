// src/core/solver.ts
// Complete Crank-Nicolson Multi-Wire Thermal Solver with Three-State Boundaries

import type { SolverConfig, Plate, PlateType, MaterialType, NodeState, WireConfig, StepResult } from '../types';
import { interpolateTabulated, interpolateTabulatedSlope, COPPER, NBTI, type MaterialTable } from '../constants/materials';

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
   Lumped joint thermal mass fallback for resistor plates that do not
   specify heatCapacityJK. A wire cell alone holds only ~nJ/K, so a
   physical joint mass is required for finite heating rates.
   =================================================================== */
const DEFAULT_RESISTOR_HEAT_CAPACITY_JK = 0.01;

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
  // Number of identical parallel strands represented by this wire entry.
  // The bundle is solved as one effective channel: with every strand at
  // the same temperature, the volumetric heat equation is identical for
  // each strand, so only extensive quantities (area, fluxes, lumped
  // joint mass/resistance) need scaling.
  readonly wireCount: number;
  // Per-strand cross-sectional area (m^2)
  readonly areaPerWire: number;
  // Effective conduction/mass area of the bundle: wireCount * areaPerWire
  readonly area: number;
  // TOTAL current through the bundle; strands share it equally
  currentAmps: number;
  // Number of wire entries in the whole system: a bias-driven resistor
  // plate is one physical object shared by every wire crossing its node,
  // so its power is split evenly across them.
  readonly totalWires: number;
  temperatures: Float64Array;
  k: Float64Array;
  cp: Float64Array;
  rhoE: Float64Array;
  // d(rhoE)/dT of the tabulated lookup, used to linearize the Joule
  // source implicitly (see crankNicolsonStep).
  drhoEdT: Float64Array;
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

  constructor(wireConfig: WireConfig, N: number, plates: Plate[], totalWires: number = 1) {
    this.wireId = wireConfig.id;
    this.N = N;
    this.totalWires = Math.max(1, totalWires);
    this.wireCount = Math.max(1, Math.round(wireConfig.wireCount ?? 1));
    this.areaPerWire = wireConfig.crossSectionalArea;
    this.area = this.wireCount * this.areaPerWire;
    this.currentAmps = wireConfig.currentAmps;

    this.temperatures = new Float64Array(N);
    this.k = new Float64Array(N);
    this.cp = new Float64Array(N);
    this.rhoE = new Float64Array(N);
    this.drhoEdT = new Float64Array(N);
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
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let seg = 0;
    for (let i = 0; i < this.N; i++) {
      // Nodes outside the plate span clamp to the nearest plate temperature;
      // extrapolating past the first plate can produce T < 0.
      if (i <= first.nodeIndex) {
        this.temperatures[i] = first.temperature;
        continue;
      }
      if (i >= last.nodeIndex) {
        this.temperatures[i] = last.temperature;
        continue;
      }
      while (seg + 1 < sorted.length && sorted[seg + 1].nodeIndex < i) seg++;
      const n0 = sorted[seg].nodeIndex;
      const n1 = sorted[seg + 1].nodeIndex;
      const t0 = sorted[seg].temperature;
      const t1 = sorted[seg + 1].temperature;
      const frac = n1 > n0 ? (i - n0) / (n1 - n0) : 1;
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
      this.drhoEdT[i] = interpolateTabulatedSlope(T, mat.temperatures, mat.rhoE);
      this.rho[i] = mat.rho;
    }
  }

  /* ===========================================================
     CRANK-NICOLSON IMPLICIT STEP (Three-State Boundary Logic)

     PDE: rho*Cp * dT/dt = d/dx(k * dT/dx) + I^2*rhoE/A^2 + qExt

     A is the EFFECTIVE area of the strand bundle (wireCount * A_wire)
     and I is the TOTAL bundle current. For n identical parallel strands
     each carrying I/n, the volumetric Joule density is
       n * (I/n)^2 * rhoE / A_wire / (n * A_wire) = I^2 * rhoE / A^2,
     i.e. exactly the single-channel form with the effective area, so the
     tridiagonal coefficients keep their shape. The transient term
     rho*Cp*dT/dt is intensive (same material in every strand); the
     bundle's combined thermal mass rho*Cp*A*dx enters wherever lumped
     (extensive) quantities are converted to volumetric ones.

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
       'dynamic'  -> Dirichlet at the plate's current temperature; the
                     plate itself is integrated by the lumped ODE in
                     ThermalSolver.updateDynamicPlates (its heat capacity
                     is orders of magnitude above a wire cell's, so it is
                     effectively constant during one wire solve)
       'resistor' -> participates in CN system with Joule source injection
                     and the joint's lumped heat capacity added to the
                     node's thermal inertia; if coolingCapacityWatts is
                     set, the joint is heat-sunk to the fridge via a
                     linearized tanh cooling curve (it models a load
                     mounted on a cooled stage rather than a joint
                     floating on the wire end)
       Node 0 (no plate): Neumann (insulated) via ghost-node symmetry
     =========================================================== */
  crankNicolsonStep(dt: number, dx: number, qExt: number): void {
    const N = this.N;
    const dx2 = dx * dx;
    const current = this.currentAmps;
    const A = this.area;
    const A2 = A * A;

    for (let i = 0; i < N; i++) {
      const plateConfig = this.plateConfigAtNode[i];
      const plateType = this.plateTypeAtNode[i];

      // -------- FIXED & DYNAMIC (Dirichlet) BOUNDARIES --------
      if (this.isFixed[i] || plateType === 'dynamic') {
        this.lower[i] = 0;
        this.diag[i] = 1;
        this.upper[i] = 0;
        this.rhs[i] = this.isFixed[i] ? this.fixedTemps[i] : this.temperatures[i];
        continue;
      }

      // Compute gamma (temporal inertia coefficient)
      let gamma = this.rho[i] * this.cp[i] / dt;

      // Base volumetric source: Joule heating + external power
      let source = current * current * this.rhoE[i] / A2 + qExt;

      // -------- SOURCE-JACOBIAN STABILIZATION --------
      // The Joule source q(T) = I^2 * rhoE(T) / A^2 is lagged at T^n, so
      // wherever d(rhoE)/dT > 0 (copper above ~20 K, the NbTi step at Tc)
      // the explicit source is positive feedback: each solve overshoots
      // the physical growth rate and the runaway is numerical as well as
      // physical. Following the C++ reference (cpp_sim a7d2951), add the
      // clamped source Jacobian J = I^2 * (drhoE/dT) / A^2 to the row.
      // Folding J into gamma puts +J on the diagonal and +J*T^n on the
      // RHS (every row uses gamma symmetrically), which damps the update
      // toward the linearized source rate, keeps the matrix strictly
      // diagonally dominant, and vanishes identically at steady state.
      const gamma0 = gamma;
      if (current !== 0 && this.drhoEdT[i] > 0) {
        const jq = current * current * this.drhoEdT[i] / A2;
        gamma += Math.min(jq, 1e3 * gamma0);
      }

      // -------- RESISTOR BOUNDARY NODE --------
      // Each of the n strands has its own joint of resistance R carrying
      // I/n, so the bundle dissipates n * (I/n)^2 * R = I^2 * R / n
      // (joints in parallel). The total is converted to W/m^3 over the
      // combined cell volume A * dx. The n joints' lumped heat capacities
      // are added to the node's thermal inertia: without joint mass, all
      // of Q lands on the wire cells' ~nJ/K capacity and the first step
      // overshoots by tens of kelvin at any nonzero current.
      if (plateType === 'resistor' && plateConfig) {
        const R = plateConfig.resistanceOhms || 0;
        if (plateConfig.currentAmps !== undefined) {
          // Bias mode: the resistor is its own circuit (heater/sample/
          // SC load) carrying plateConfig.currentAmps, NOT the wire's
          // lead current. One physical element: P = I_bias^2 * R, split
          // evenly across the wires terminating at this node.
          const biasI = plateConfig.currentAmps;
          source += biasI * biasI * R / this.totalWires / (A * dx);
        } else {
          // Joint mode: the resistor sits in the wire's circuit and
          // carries the bundle current (per-strand joints in parallel).
          source += current * current * (R / this.wireCount) / (A * dx);
        }

        const Cjoint = plateConfig.heatCapacityJK || DEFAULT_RESISTOR_HEAT_CAPACITY_JK;
        gamma += this.wireCount * Cjoint / (A * dx * dt);

        // A resistor joint mounted on a cooled stage (e.g. the 1-Ohm load
        // bolted to the mixing chamber) sinks heat to the fridge. Without
        // this term the joint hangs off the wire end thermally isolated:
        // even microwatts then ride the wire's ~1e-10 W/K conductance to
        // thousands of kelvin. Backward-Euler linearization of the fridge
        // curve (sink at T^n explicit, dQ/dT implicit via gamma) matches
        // the dynamic-plate treatment and cannot undershoot equilibrium.
        const Qcap = plateConfig.coolingCapacityWatts || 0;
        if (Qcap > 0) {
          const vol = A * dx;
          source -= fridgeCoolingPower(this.temperatures[i], Qcap) / vol;
          gamma += fridgeCoolingDerivative(this.temperatures[i], Qcap) / vol;
        }
      }

      // -------- CONSTRUCT MATRIX ROW --------
      if (i === 0) {
        // Node 0: Neumann BC via ghost-node symmetry (T_{-1} = T_1) unless it's a plate
        const kHalf = (this.k[0] + this.k[1] > 0)
          ? (2 * this.k[0] * this.k[1]) / (this.k[0] + this.k[1])
          : 0;
        const betaEff = 2.0 * kHalf / dx2;

        this.lower[i] = 0;
        this.diag[i] = gamma + 0.5 * betaEff;
        this.upper[i] = -0.5 * betaEff;
        this.rhs[i] = (gamma - 0.5 * betaEff) * this.temperatures[0]
                    + 0.5 * betaEff * this.temperatures[1]
                    + source;
      } else if (i === N - 1) {
        // Last node that isn't fixed - Neumann on the right side
        const kHalf = (this.k[N - 2] + this.k[N - 1] > 0)
          ? (2 * this.k[N - 2] * this.k[N - 1]) / (this.k[N - 2] + this.k[N - 1])
          : 0;
        const alphaEff = 2.0 * kHalf / dx2;

        this.lower[i] = -0.5 * alphaEff;
        this.diag[i] = gamma + 0.5 * alphaEff;
        this.upper[i] = 0;
        this.rhs[i] = 0.5 * alphaEff * this.temperatures[N - 2]
                    + (gamma - 0.5 * alphaEff) * this.temperatures[N - 1]
                    + source;
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
        this.diag[i] = gamma + 0.5 * (alpha + beta);
        this.upper[i] = -0.5 * beta;
        this.rhs[i] = 0.5 * alpha * this.temperatures[i - 1]
                    + (gamma - 0.5 * (alpha + beta)) * this.temperatures[i]
                    + 0.5 * beta * this.temperatures[i + 1]
                    + source;
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
     A is the bundle's effective area, so the returned load includes
     the contribution of every parallel strand (e.g. zero-current
     conduction heat leak scales linearly with wireCount).
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
  // Maximum temperature change allowed per SUBSTEP. Large enough for
  // ordinary transients, small enough to catch NbTi Tc crossings and
  // Joule-runaway feedback before they overshoot.
  private static readonly MAX_DELTA_T_THRESHOLD = 5.0;
  private static readonly SUBSTEP_GROWTH = 4;
  private static readonly MAX_DT_REDUCTIONS = 5;

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
      const ws = new WireSolverState(wc, this.N, plates, wireConfigs.length);
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

    // Snapshot full state (wire grids + plate temperatures) so failed
    // attempts can be rolled back cleanly.
    const prevTemps: Float64Array[] = this.wires.map(
      (w) => new Float64Array(w.temperatures)
    );
    const prevPlateTemps = this.plateRuntimes.map((pr) => pr.currentTemperature);

    // Scratch buffers for per-substep delta measurement
    const scratch: Float64Array[] = this.wires.map(
      (w) => new Float64Array(w.N)
    );

    // Adaptive substep logic
    let substeps = 1;
    let dtWasReduced = false;
    let converged = false;
    let maxDelta = 0;

    for (let attempt = 0; attempt <= ThermalSolver.MAX_DT_REDUCTIONS; attempt++) {
      // Reset state to start of step for this attempt
      if (attempt > 0) {
        for (let w = 0; w < this.wires.length; w++) {
          this.wires[w].temperatures.set(prevTemps[w]);
        }
        for (let p = 0; p < this.plateRuntimes.length; p++) {
          this.plateRuntimes[p].currentTemperature = prevPlateTemps[p];
        }
      }

      const subDt = dt / substeps;
      maxDelta = 0;

      for (let sub = 0; sub < substeps; sub++) {
        // Update material properties based on current temperatures
        for (const wire of this.wires) {
          wire.updateMaterialProperties();
        }

        // Write plate temperatures into all wires BEFORE solve
        this.syncDynamicPlateTemperatures();

        // Snapshot the substep start state for the stability check
        for (let w = 0; w < this.wires.length; w++) {
          scratch[w].set(this.wires[w].temperatures);
        }

        // Solve each wire independently with current plate states
        for (const wire of this.wires) {
          wire.crankNicolsonStep(subDt, this.dx, qExt);
        }

        // Update dynamic plate temperatures based on net heat flow from ALL wires
        this.updateDynamicPlates(subDt);

        // Maximum temperature change across this SUBSTEP. Measuring per
        // substep (not per full step) means refinement actually reduces
        // the metric for resolvable transients, while genuine runaways
        // keep failing and surface as an error below.
        for (let w = 0; w < this.wires.length; w++) {
          for (let i = 0; i < this.N; i++) {
            const delta = Math.abs(this.wires[w].temperatures[i] - scratch[w][i]);
            if (delta > maxDelta) maxDelta = delta;
          }
        }
      }

      this.lastMaxDeltaT = maxDelta;

      if (maxDelta <= ThermalSolver.MAX_DELTA_T_THRESHOLD) {
        converged = true;
        break;
      }
      substeps *= ThermalSolver.SUBSTEP_GROWTH;
      dtWasReduced = true;
    }

    this.dtReductionActive = substeps > 1;

    if (!converged) {
      // Roll back instead of accepting a diverged state
      for (let w = 0; w < this.wires.length; w++) {
        this.wires[w].temperatures.set(prevTemps[w]);
      }
      for (let p = 0; p < this.plateRuntimes.length; p++) {
        this.plateRuntimes[p].currentTemperature = prevPlateTemps[p];
      }
      throw new Error(
        `Solver cannot stabilize: ΔT=${maxDelta.toFixed(2)}K per substep at dt/${substeps / ThermalSolver.SUBSTEP_GROWTH}. ` +
        `Reduce dt or check wire/plate configuration for thermal runaway.`
      );
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
      // The full interval is always integrated (substeps * subDt = dt),
      // so callers must advance their clocks by dt, not dt/substeps.
      actualDt: dt,
      dtWasReduced,
      plateTemperatures: plateTemps,
    };
  }

  /* ===========================================================
     DYNAMIC PLATE UPDATE
     After all wires have been solved for a sub-step, compute the net
     conductive heat flow into each dynamic plate from all wires and
     integrate the lumped plate ODE:

       C_plate * dT/dt = Q_wires - Q_fridge(T)

     The fridge term is treated with a linearized backward-Euler step
     (Q evaluated at T^{n+1} to first order), which is unconditionally
     stable and cannot overshoot through the equilibrium into T < 0:

       dT = dt * (Q_wires - Q_fridge(T_n)) / (C_plate + dt * dQ/dT)

     The updated plate temperature is written back to every wire so the
     next solve sees the shared junction state (inter-wire coupling).
     This is the ONLY place fridge cooling is applied; the wire matrix
     treats the plate node as Dirichlet.
     =========================================================== */
  private updateDynamicPlates(dt: number): void {
    for (const pr of this.plateRuntimes) {
      // Resistor plates have no state of their own; report the hottest
      // wire temperature at the joint so telemetry reflects reality.
      if (pr.plate.plateType === 'resistor') {
        const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));
        let maxT = -Infinity;
        for (const wire of this.wires) {
          if (wire.temperatures[nodeIdx] > maxT) maxT = wire.temperatures[nodeIdx];
        }
        if (maxT > -Infinity) pr.currentTemperature = maxT;
        continue;
      }
      if (pr.plate.plateType !== 'dynamic') continue;

      const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));
      const Qcap = pr.plate.coolingCapacityWatts || 0;
      const Cplate = pr.plate.heatCapacityJK || 1.0;

      // Sum conductive heat flux from ALL wires at this plate node
      let totalQwires = 0;
      for (const wire of this.wires) {
        totalQwires += wire.computeHeatFluxAtNode(nodeIdx, this.dx);
      }

      const Qfridge = fridgeCoolingPower(pr.currentTemperature, Qcap);
      const dQdT = fridgeCoolingDerivative(pr.currentTemperature, Qcap);

      const deltaT = dt * (totalQwires - Qfridge) / (Cplate + dt * dQdT);
      pr.currentTemperature += deltaT;

      // Enforce physical minimum (cannot go below 1 mK)
      if (pr.currentTemperature < 0.001) {
        pr.currentTemperature = 0.001;
      }

      // Propagate the new junction temperature to all wires
      for (const wire of this.wires) {
        wire.temperatures[nodeIdx] = pr.currentTemperature;
      }
    }
  }

  /* ===========================================================
     SYNC DYNAMIC PLATE TEMPERATURES
     Writes each dynamic plate's temperature into all wire grids at the
     plate node, ensuring the wire solves (which clamp these nodes as
     Dirichlet) see a consistent shared junction state.
     =========================================================== */
  private syncDynamicPlateTemperatures(): void {
    for (const pr of this.plateRuntimes) {
      if (pr.plate.plateType !== 'dynamic') continue;

      const nodeIdx = Math.max(0, Math.min(pr.plate.nodeIndex, this.N - 1));
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