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
  heatCapacityJK?: number;         // C_plate (J/K)
  // Resistor mode fields:
  resistanceOhms?: number;         // Lumped boundary resistance (Ohms)
}

export interface LumpedResistor {
  nodeIndex: number;
  resistanceOhms: number;
}

export interface WireConfig {
  id: number;
  label: string;
  color: string;
  crossSectionalArea: number; // m^2
  currentAmps: number;
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