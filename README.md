# CryoSim — Cryogenic Multi-Wire Thermal Simulator

Interactive Crank–Nicolson (CN-TDMA) simulator for the thermal profile of
current-carrying wire bundles running down a dilution refrigerator: 1D heat
equation with temperature-dependent Cu/NbTi properties, Joule heating,
three-state plate boundaries (fixed / dynamic fridge-cooled / lumped
resistor), and inter-wire coupling through shared plates.

- `npm install && npm run dev` — run locally
- `npm run check:solver` — solver regression suite (12 scenarios)
- `npm run build` — typecheck + production bundle

Solver internals are documented in [src/core/README.md](src/core/README.md).

---

## Changes — June 2026 (`claude/dual-wire-refactor`)

### Root cause of the `T > 10000 K` runaway with the new defaults

The Thomas solve was investigated and exonerated: the CN matrix is strictly
diagonally dominant (`|diag| = γ + ½(α+β) > ½(α+β) = |off-diags|`), so TDMA
is exact and stable for it. The "infinite temperature source" was the Joule
source term combined with the default operating point:

1. **The source was explicit (lagged one step).** The volumetric Joule term
   `q = I²·ρe(T)/A²` was evaluated at the *old* temperature. Wherever
   `dρe/dT > 0` (copper above ~20 K, and the NbTi resistivity step at
   Tc = 9.2 K) this is positive feedback: each solve overshoots the
   physical growth rate. The C++ reference fixed this in cpp_sim commit
   `a7d2951` ("Adjusted accuracy by implementing jacobian"); the TypeScript
   port never received the equivalent.
2. **The default operating point had no cryogenic steady state.** 7.5 A
   through the 2×Ø50 µm lead pair is a current density of ~1.9×10⁹ A/m².
   Copper resistivity rises ~50× from 4 K → 300 K (RRR = 50), so the copper
   segments undergo genuine thermal runaway — the solver was faithfully
   integrating a wire that physically vaporizes, then stopping at the
   10 000 K guard. The same current through the requested 1 Ω bottom load
   would dissipate I²R/2 ≈ 28 W at the mixing chamber, ~6 orders of
   magnitude above its 15 µW cooling capacity.
3. **Why cpp_sim looks calmer with the same inputs.** The C++ `qgen()`
   computes segment resistance with a hard-coded 0.001 m² "unity" area
   (`Solver.cpp:14`), suppressing distributed Joule heat by ~10⁵ relative
   to its own 7.85×10⁻⁹ m² geometry, and it pins node 0 to 0.01 K after
   every solve (`Solver.cpp:219`, marked "VERY TEMPORARY"). The original
   `PythonSim.py` ran this exact 1 Ω-load system at `CURRENT_AMPS = 0.0`
   ("Zero-Load Conduction Leak") — the earlier, more accurate rendition the
   discrepancy traces back to.

### Solver fixes (`src/core/solver.ts`, `src/constants/materials.ts`)

- **Semi-implicit Joule source (cpp Jacobian analogue).** Each row now adds
  the clamped source Jacobian `J = I²·(dρe/dT)/A²` to the diagonal and
  `J·Tⁿ` to the RHS (folded into γ, matching the C++ `Jacob` structure).
  `dρe/dT` comes from `interpolateTabulatedSlope()`, the exact derivative
  of the piecewise-linear property table, so the linearization agrees with
  the lookup inside every table bin — including the single-bin NbTi step at
  Tc. The term keeps the matrix strictly diagonally dominant, damps quench
  fronts to the linearized physical rate, and vanishes at steady state.
- **Resistor plates can be heat-sunk to the fridge.** A lumped resistor
  with `coolingCapacityWatts > 0` now sinks `Q_max·tanh(T/4.2)` with the
  same linearized backward-Euler treatment as dynamic plates. Previously a
  resistor joint floated on the wire end: through a Ø50 µm NbTi lead
  (~10⁻¹⁰ W/K to the nearest plate) even microwatts rode to thousands of
  kelvin. A load bolted to the mixing chamber is cooled by it; `0` (the
  prior behavior) still models a floating joint.

### Default configuration (`src/App.tsx`)

- **Bottom plate is now the lumped 1 Ω load**: `resistor`, `nodeIndex 0`,
  init 0.01 K, heat-sunk to the MC stage (Q_max = 15 µW, C = 5 mJ/K) — the
  counterpart of cpp_sim's `qgen_base(1.0, I)` bottom node and PythonSim's
  `LOAD_RESISTANCE = 1.0`.
- **Default lead current 7.5 A → 1 mA.** At 1 mA the load dissipates
  0.5 µW and settles near 0.1–0.3 K; the Ø50 µm copper segments carry a
  benign current density. 7.5 A in this geometry has no bounded solution
  (see analysis above) — if you raise the current, raise the cross-section
  with it.
- Fixed the `Copper Lead-Out` segment end node (500 → 499, was out of
  bounds and silently clamped).

### Error log UI (`TelemetryBar.tsx`, `ErrorLogModal.tsx`, `App.tsx`)

- New **LOG** button in the telemetry bar (with unread-count badge) opens a
  modal showing the full, untruncated history of solver errors and
  warnings — each entry stamped with step, simulation time, and wall-clock
  time, with copy-all and clear. The inline error text (previously clipped
  at 260 px) is now clickable and opens the same log.
- Logged events: solver build failures, step errors (e.g. the runaway
  guard), and adaptive-dt engagement transitions. Consecutive duplicates
  collapse into one entry; the log keeps the last 200.

### Other fixes on this branch

- Live plate temperature readouts (top bar and Plates panel) now include
  resistor plates — previously a resistor bottom plate had no readout at
  all (only `dynamic` plates were listed).
- Config panel exposes the resistor sink (`Sink Q_max`) field and documents
  the per-strand joint convention (`Q = I²R/n`, joints in parallel).
- Regression suite extended (`scripts/solver-checks.ts`):
  - **10** — fridge-sunk 1 Ω MC load at 1 mA settles near base temperature;
  - **11** — NbTi quench: a resolvable normal-state march stays bounded; an
    unresolvable one (physical runaway faster than the deepest substep
    refinement) throws a descriptive error with the state rolled back,
    never NaN/negative/10 000+ K;
  - **12** — the full 500-node default dual-wire configuration stays
    cryogenic (direct regression for the reported `T > 10000 K` error).

### Known modeling difference vs. cpp_sim (intentional, documented)

CryoSim's `wireCount` models *parallel* strands sharing `currentAmps`
(total current). cpp_sim models the 2-wire pair as a *series* loop — both
wires carry the full current (it doubles ρe instead). At fixed total
current the volumetric dissipation differs by ×4. To reproduce series-pair
(down-and-back) behavior here, set `currentAmps = 2 × I_loop`: each strand
then carries `I_loop` and the volumetric Joule term `(2I)²ρe/(2A)² =
I²ρe/A²` matches the series pair exactly.
