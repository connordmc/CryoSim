// src/types.ts
// Complete updated type definitions for the Cryogenic Thermal Simulation Platform

export type MaterialType = 'copper' | 'nbti';

export type PlateType = 'fixed' | 'dynamic' | 'resistor';

export interface MaterialSegment {
  id: number;
  name: string;
  startNode: number;
  endNode: number;
  materialType: MaterialType;
}

export interface Plate {
  id: number;
  nodeIndex: number;
  temperature: number;
  plateType: PlateType;
  // Fixed mode: temperature is the Dirichlet value
  // Dynamic mode fields:
  coolingCapacityWatts?: number;   // Q_max for the fridge curve (W)
  // Dynamic mode: C_plate; Resistor mode: lumped joint thermal mass (J/K).
  // For resistor plates on multi-strand wires this is PER JOINT (each
  // strand has its own joint); the solver sums them.
  heatCapacityJK?: number;
  // Resistor mode fields:
  // Lumped boundary resistance (Ohms) PER STRAND. Strands' joints sit
  // electrically in parallel, so a bundle of n sees R_eff = R / n.
  resistanceOhms?: number;
}

export interface LumpedResistor {
  nodeIndex: number;
  resistanceOhms: number;
}

export interface WireConfig {
  id: number;
  label: string;
  color: string;
  // Number of identical parallel wires this entry represents (>= 1).
  // The strands run the same path, share `currentAmps` equally (parallel
  // electrical paths), and conduct heat through their combined area.
  // Defaults to 1 when omitted.
  wireCount?: number;
  crossSectionalArea: number; // m^2 PER WIRE; effective area = wireCount * this
  currentAmps: number;        // TOTAL current through the bundle (A)
  segments: MaterialSegment[];
  resistors?: LumpedResistor[];
}

export interface NodeState {
  temperature: number;
  k: number;
  cp: number;
  rho: number;
  rhoE: number;
  isFixed: boolean;
  isPlate: boolean;
  plateType: PlateType | null;
  materialName: MaterialType;
}

export interface SolverConfig {
  numNodes: number;
  dx: number;
  dt: number;
  powerFormula: string;
}

// One entry in the solver event log (untruncated error/warning history
// surfaced through the telemetry-bar LOG button).
export interface LogEntry {
  id: number;
  wallTime: Date;
  step: number;
  simTime: number;
  kind: 'error' | 'warning';
  message: string;
}

export interface StepResult {
  maxDeltaT: number;
  actualDt: number;
  dtWasReduced: boolean;
  plateTemperatures: Map<number, number>;
}

export interface WireTemperatureSnapshot {
  wireId: number;
  temperatures: Float64Array;
}

export interface HoveredInfo {
  nodeIndex: number;
  x: number;
  wireId: number;
  temperature: number;
  materialName: MaterialType;
  k: number;
  cp: number;
  rhoE: number;
}

export interface OptimizationResultA {
  totalJouleDissipationW: number;
  benchmarkW: number;
  percentOfBenchmark: number;
  passed: boolean;
  wireBreakdown: Array<{
    wireId: number;
    label: string;
    dissipationW: number;
    currentArea: number;
    recommendedArea: number;
  }>;
}

export interface SweepPoint {
  lengthMm: number;
  leakMicroW: number;
  productQLMicroWm: number;
}

export interface OptimizationResultB {
  sweepData: SweepPoint[];
  plateTemperatureShifts: Map<number, number>;
  interWireCoupled: boolean;
}