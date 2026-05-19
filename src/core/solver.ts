import type { SolverConfig, Plate, MaterialType, NodeState, WireConfig } from '../types';
import { interpolateTabulated, COPPER, NBTI, type MaterialTable } from '../constants/materials';

/* ===================================================================
   WireSolverState
   Per-wire numerical state and Crank-Nicolson solver.
   =================================================================== */
class WireSolverState {
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

    // Register plates (shared across wires on the same node axis)
    const sorted = [...plates]
      .map((p) => ({ ...p, nodeIndex: Math.max(0, Math.min(p.nodeIndex, N - 1)) }))
      .sort((a, b) => a.nodeIndex - b.nodeIndex);
    for (const p of sorted) {
      if (p.isFixed) {
        this.isFixed[p.nodeIndex] = true;
        this.fixedTemps[p.nodeIndex] = p.temperature;
      }
    }
    // Last node always Dirichlet
    this.isFixed[N - 1] = true;
    if (!this.fixedTemps[N - 1]) {
      this.fixedTemps[N - 1] = sorted.length > 0 ? sorted[sorted.length - 1].temperature : 300;
    }

    // Initial temperatures: linear interpolation between plates
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
     CRANK-NICOLSON IMPLICIT STEP
     
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
     
     Node 0: Neumann (insulated) via ghost-node symmetry.
     Fixed nodes: diag=1, lower=upper=0, rhs=T_fixed.
     =========================================================== */
  crankNicolsonStep(dt: number, dx: number, qExt: number): void {
    const N = this.N;
    const dx2 = dx * dx;
    const current = this.currentAmps;
    const A2 = this.area * this.area;

    for (let i = 0; i < N; i++) {
      // Fixed Dirichlet nodes
      if (this.isFixed[i]) {
        this.lower[i] = 0;
        this.diag[i] = 1;
        this.upper[i] = 0;
        this.rhs[i] = this.fixedTemps[i];
        continue;
      }

      const gamma = this.rho[i] * this.cp[i] / dt;
      const source = current * current * this.rhoE[i] / A2 + qExt;

      if (i === 0) {
        // Node 0: Insulated BC via ghost-node symmetry (T_{-1} = T_1)
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
      } else {
        // Interior nodes (1 <= i <= N-2)
        const kL = (this.k[i - 1] + this.k[i] > 0)
          ? (2 * this.k[i - 1] * this.k[i]) / (this.k[i - 1] + this.k[i])
          : 0;
        const kR = (i + 1 < N && this.k[i] + this.k[i + 1] > 0)
          ? (2 * this.k[i] * this.k[i + 1]) / (this.k[i] + this.k[i + 1])
          : 0;

        const alpha = kL / dx2;
        const beta = kR / dx2;

        this.lower[i] = -0.5 * alpha;
        this.diag[i] = gamma + 0.5 * (alpha + beta);
        this.upper[i] = -0.5 * beta;
        this.rhs[i] = 0.5 * alpha * this.temperatures[i - 1]
                    + (gamma - 0.5 * (alpha + beta)) * this.temperatures[i]
                    + (i + 1 < N ? 0.5 * beta * this.temperatures[i + 1] : 0)
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
      cp[i] = c[i] / denom;
      dp[i] = (d[i] - a[i] * dp[i - 1]) / denom;
    }

    // Back substitution
    this.temperatures[N - 1] = dp[N - 1];
    for (let i = N - 2; i >= 0; i--) {
      this.temperatures[i] = dp[i] - cp[i] * this.temperatures[i + 1];
    }
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
      isPlate: this.isFixed[i],
      materialName: this.materialType[i],
    };
  }
}

/* ===================================================================
   ThermalSolver (Multi-Wire)
   =================================================================== */
export class ThermalSolver {
  readonly N: number;
  readonly dx: number;
  readonly wires: WireSolverState[];
  private wireMap: Map<number, WireSolverState>;

  constructor(config: SolverConfig, plates: Plate[], wireConfigs: WireConfig[]) {
    this.N = Math.max(3, config.numNodes);
    this.dx = config.dx;
    this.wires = [];
    this.wireMap = new Map();

    for (const wc of wireConfigs) {
      const ws = new WireSolverState(wc, this.N, plates);
      this.wires.push(ws);
      this.wireMap.set(wc.id, ws);
    }
  }

  step(
    dt: number,
    powerFn: ((t: number) => number) | null,
    t: number,
  ): void {
    let qExt = 0;
    if (powerFn) {
      try { qExt = powerFn(t); } catch { qExt = 0; }
    }

    for (const wire of this.wires) {
      wire.updateMaterialProperties();
      wire.crankNicolsonStep(dt, this.dx, qExt);
    }

    this.validate();
  }

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

  updateWireCurrent(wireId: number, current: number): void {
    const w = this.wireMap.get(wireId);
    if (w) w.currentAmps = current;
  }
}