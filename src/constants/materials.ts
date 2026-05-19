/* ===================================================================
   MATERIAL PROPERTY MODELS
   Copper: NIST OFHC polynomials (RRR = 50), Bloch-Gruneisen resistivity.
   NbTi:   Piecewise polynomial fits, step-function resistivity at Tc.
   =================================================================== */

// -- helpers --

function simpsonIntegrate(
  f: (x: number) => number,
  a: number,
  b: number,
  n: number,
): number {
  if (n % 2 !== 0) n++;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) {
    sum += (i % 2 === 0 ? 2 : 4) * f(a + i * h);
  }
  return (sum * h) / 3;
}

function bgIntegrand(x: number): number {
  if (x < 1e-10) return 0;
  if (x > 100) return Math.pow(x, 5) * Math.exp(-x);
  const ex = Math.exp(x);
  return Math.pow(x, 5) / ((ex - 1) * (1 - 1 / ex));
}

// -- Copper analytical formulas --

const CU_RHO = 8960.0; // kg m-3

function cuThermalConductivity(T: number): number {
  const a = 1.8743,
    b = -0.41538,
    c = -0.6018,
    d = 0.13294;
  const e = 0.26426,
    f = -0.0219,
    g = -0.051276,
    h = 0.0014871;
  const ii = 0.003723;
  if (T <= 0.01) T = 0.01;
  if (T <= 4) {
    const s4 = 2;
    const num = a + c * s4 + e * 4 + g * 4 * s4 + ii * 16;
    const den = 1 + b * s4 + d * 4 + f * T * s4 + h * 16;
    return Math.pow(10, num / den);
  }
  const sT = Math.sqrt(T);
  const num = a + c * sT + e * T + g * T * sT + ii * T * T;
  const den = 1 + b * sT + d * T + f * T * sT + h * T * T;
  return Math.pow(10, num / den);
}

function cuSpecificHeat(T: number): number {
  if (T <= 0.01) T = 0.01;
  if (T < 4) {
    return 0.0108 * T + 0.00076 * T * T * T;
  }
  const a = -1.91844,
    b2 = -0.15973,
    c = 8.61013;
  const d = -18.996,
    e = 21.9661,
    f = -12.7328;
  const g = 3.54322,
    h = -0.3797;
  const lT = Math.log10(T);
  const l2 = lT * lT,
    l3 = l2 * lT,
    l4 = l3 * lT;
  const l5 = l4 * lT,
    l6 = l5 * lT,
    l7 = l6 * lT;
  const log10Cp = a + b2 * lT + c * l2 + d * l3 + e * l4 + f * l5 + g * l6 + h * l7;
  return Math.pow(10, log10Cp);
}

// Bloch-Gruneisen model for OFHC Cu (RRR = 50)
const BG_THETA = 343.0;
const BG_RHO300 = 15.53e-9;
const BG_RHO0 = BG_RHO300 / 50;

let bgNorm: number | null = null;
function getBGNorm(): number {
  if (bgNorm === null) {
    bgNorm = simpsonIntegrate(bgIntegrand, 0, BG_THETA / 273, 200);
  }
  return bgNorm!;
}

function cuResistivity(T: number): number {
  if (T < 0.1) T = 0.1;
  const upper = Math.min(BG_THETA / T, 100);
  const integral = simpsonIntegrate(bgIntegrand, 0, upper, 200);
  const norm = getBGNorm();
  const phon =
    BG_RHO300 *
    Math.pow(T / BG_THETA, 5) *
    integral /
    (Math.pow(273 / BG_THETA, 5) * norm);
  return BG_RHO0 + phon;
}

// -- NbTi analytical formulas --

const NBTI_RHO = 6000.0; // kg m-3

function nbtiThermalConductivity(T: number): number {
  if (T <= 0.01) T = 0.01;
  if (T <= 10)
    return (
      -8.90853506962360e-4 * T * T * T +
      1.6706386304553200e-2 * T * T -
      4.4789876496699500e-2 * T +
      6.8105653491378900e-2
    );
  if (T <= 100)
    return (
      2.70707129507107e-14 * Math.pow(T, 6) -
      1.08954290563857e-10 * Math.pow(T, 5) +
      7.26142664655360e-8 * Math.pow(T, 4) -
      1.76888570047456e-5 * T * T * T +
      1.52357790620000e-3 * T * T +
      1.96574322011685e-2 * T +
      6.41124699451172e-4
    );
  return (
    -3.61188788799055e-8 * T * T * T +
    8.45169877815884e-5 * T * T -
    1.47662199022160e-2 * T +
    6.42534207706445
  );
}

function nbtiSpecificHeat(T: number): number {
  if (T <= 0.01) T = 0.01;
  if (T < 20) return 0.165714286 * T + 0.0029 * T * T * T;
  if (T < 50)
    return (
      7.392857143 -
      1.401089286 * T +
      0.098876786 * T * T +
      0.002139286 * T * T * T -
      3.8929e-5 * Math.pow(T, 4)
    );
  if (T < 175)
    return (
      -273.2142857 +
      14.82535714 * T -
      0.127910714 * T * T +
      5.31429e-4 * T * T * T -
      8.607142857e-7 * Math.pow(T, 4)
    );
  return (
    221.4285714 +
    2.4475 * T -
    9.225e-3 * T * T +
    1.66e-5 * T * T * T -
    1.123214286e-8 * Math.pow(T, 4)
  );
}

function nbtiResistivity(T: number): number {
  return T > 9.2 ? 5.6e-7 : 0;
}

// -- Tabulated property tables --

export interface MaterialTable {
  temperatures: number[];
  k: number[];
  cp: number[];
  rhoE: number[];
  rho: number;
}

const TABLE_N = 500;
const T_TABLE_MIN = 0.5;
const T_TABLE_MAX = 500;

function buildTable(
  kFn: (T: number) => number,
  cpFn: (T: number) => number,
  rhoEFn: (T: number) => number,
  rho: number,
): MaterialTable {
  const temps: number[] = [];
  const k: number[] = [];
  const cp: number[] = [];
  const rhoE: number[] = [];
  const logMin = Math.log10(T_TABLE_MIN);
  const logMax = Math.log10(T_TABLE_MAX);
  for (let i = 0; i < TABLE_N; i++) {
    const T = Math.pow(10, logMin + ((logMax - logMin) * i) / (TABLE_N - 1));
    temps.push(T);
    k.push(Math.max(kFn(T), 1e-12));
    cp.push(Math.max(cpFn(T), 1e-8));
    rhoE.push(Math.max(rhoEFn(T), 0));
  }
  return { temperatures: temps, k, cp, rhoE, rho };
}

export const COPPER: MaterialTable = buildTable(
  cuThermalConductivity,
  cuSpecificHeat,
  cuResistivity,
  CU_RHO,
);

export const NBTI: MaterialTable = buildTable(
  nbtiThermalConductivity,
  nbtiSpecificHeat,
  nbtiResistivity,
  NBTI_RHO,
);

// -- Interpolation --

export function interpolateTabulated(
  T: number,
  temps: number[],
  values: number[],
): number {
  const n = temps.length;
  if (T <= temps[0]) return values[0];
  if (T >= temps[n - 1]) return values[n - 1];
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (temps[mid] <= T) lo = mid;
    else hi = mid;
  }
  const frac = (T - temps[lo]) / (temps[hi] - temps[lo]);
  return values[lo] + frac * (values[hi] - values[lo]);
}