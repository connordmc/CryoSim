export type MaterialType = 'copper' | 'nbti';

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
  isFixed: boolean;
  maxPower: number;
}

export interface WireConfig {
  id: number;
  label: string;
  color: string;
  crossSectionalArea: number; // m^2
  currentAmps: number;
  segments: MaterialSegment[];
}

export interface NodeState {
  temperature: number;
  k: number;
  cp: number;
  rho: number;
  rhoE: number;
  isFixed: boolean;
  isPlate: boolean;
  materialName: MaterialType;
}

export interface SolverConfig {
  numNodes: number;
  dx: number;
  dt: number;
  powerFormula: string;
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