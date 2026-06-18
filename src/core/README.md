# Cryogenic Thermal Solver

This repository contains a high-performance numerical solver designed to model the thermal profile and superconducting regime of wires in a cryogenic environment. It utilizes a **Crank-Nicolson finite difference scheme** to solve the 1D heat equation across a multi-node mesh, accounting for temperature-dependent material properties, Joule heating, and dynamic plate cooling.

## Physics & Mathematical Model

The solver models heat transfer through a conductive wire using the heat diffusion equation, extended to include internal heat generation (Joule heating) and external cooling sinks (cryogenic plates).

### Governing Equation

The fundamental PDE governing the temperature $T$ at any point $x$ and time $t$ is:

$$\rho C_p \frac{\partial T}{\partial t} = \frac{\partial}{\partial x} \left( k(T) \frac{\partial T}{\partial x} \right) + \frac{I^2 \rho_e(T)}{A^2} + \dot{q}_{\text{ext}}$$

Where:
* $\rho, C_p, k$: Density, specific heat capacity, and thermal conductivity (temperature-dependent).
* $I$: Current flowing through the wire.
* $\rho_e$: Electrical resistivity of the material.
* $A$: Cross-sectional area of the wire segment.
* $\dot{q}_{\text{ext}}$: External volumetric heat sources or sinks (e.g., cooling plates).

### Numerical Implementation

To ensure stability and accuracy, the solver employs the **Crank-Nicolson method**, an implicit second-order method in time. The domain is discretized into $N$ nodes with spacing $\Delta x$.

1.  **Discretization**: The spatial derivative is approximated using central differences, resulting in a tri-diagonal system of equations for the temperature at the next time step.
2.  **Thomas Algorithm**: The system is solved efficiently using the Thomas algorithm (tridiagonal matrix algorithm), which provides $O(N)$ computational complexity.
3.  **Material Properties**: Properties ($k, C_p, \rho_e$) are interpolated from tabulated data for Copper and NbTi, ensuring the model accurately captures the phase change and material behavior at cryogenic temperatures.

## Project Structure

* `solver.ts`: Contains the core `ThermalSolver` and `WireSolverState` classes. This handles the matrix assembly, step integration, and boundary condition management.
* `types.ts`: Defines the configuration interfaces for plates, wires, and materials.
* `constants/materials.ts`: Contains the temperature-dependent physical properties for Copper and NbTi.

## Usage

### Initialization
The solver is initialized with a configuration object defining the nodal density, step size, and physical layout of the fridge plates.

```typescript
const solver = new ThermalSolver(config, plates, wireConfigs);
```

## Stepping

The `step` function advances the simulation by a given time interval `dt`. It automatically subdivides the interval into substeps whenever the per-substep temperature change exceeds the stability threshold (5 K), and reports the diagnostics in the returned `StepResult` (`actualDt` always equals the full integrated `dt`). If the step cannot be stabilized even at the maximum substep refinement, the state is rolled back and an error is thrown.

```typescript
const result = solver.step(dt, powerFn, currentTime);
```

## Steady State Calculation

For static analysis, use the built-in steady-state solver which iterates until the solution converges within a specific threshold:

```typescript
const steadyStateSolver = ThermalSolver.computeSteadyState(config, plates, wireConfigs);
```

Key Features
* **Parallel Wire Bundles:** Each wire entry models `wireCount` identical parallel strands (the default configuration runs a pair of 2 identical wires down the fridge). The bundle is solved as one effective channel of area $A_{eff} = n \cdot A_{wire}$ carrying the total current $I$: because every strand sees the same volumetric equation, the tridiagonal coefficients are unchanged, while extensive quantities scale with $n$ — zero-current conduction heat leaks ($A_{eff} \int \kappa(T)\,dT$), Joule dissipation ($I^2 \rho_e / A_{eff}^2$ volumetric, i.e. parallel paths halve the total at fixed $I$), plate heat-flux couplings, and lumped joint mass/resistance ($n C_{joint}$, $R/n$).
* **Dynamic Plate Cooling:** Implements $Q_{fridge}(T) = Q_{capacity} tanh(T/4.2)$, modeling the non-linear cooling power of cryogenic systems. Each dynamic plate is clamped as a Dirichlet node during the wire solve (its heat capacity dwarfs a wire cell's) and then integrated as a lumped ODE, $C_{plate} \, dT/dt = Q_{wires} - Q_{fridge}(T)$, with a linearized backward-Euler treatment of the fridge term for unconditional stability.
* **Lumped Boundary Resistors:** Resistor plates contribute the joints' lumped heat capacity (`heatCapacityJK` per joint) to the node's thermal inertia, so the heating transient is physical rather than mesh-dependent. Two circuit modes: with the plate's `currentAmps` (bias) set, the resistor is its own circuit dissipating $I_{bias}^2 R$ split across the wires at the node (a heater, or an SC load carrying the lead current dissipation-free at bias 0); with it unset, the resistor is a joint in the wire's circuit injecting $Q = I^2 R / n$ (per-strand joints in parallel). Setting `coolingCapacityWatts > 0` heat-sinks the joint to the fridge with the same linearized $Q_{max} \tanh(T/4.2)$ curve as dynamic plates — modeling a load mounted on a cooled stage (e.g. the 1 Ω load bolted to the mixing chamber) instead of a joint floating on the wire end.
* **Semi-Implicit Joule Source:** The temperature dependence of the Joule term is linearized per step: the clamped source Jacobian $J = I^2 (d\rho_e/dT) / A_{eff}^2$ is added to the diagonal with $J\,T^n$ on the RHS (the C++ reference's `Jacob` treatment, cpp_sim `a7d2951`). $d\rho_e/dT$ is the exact slope of the piecewise-linear property table, so quench fronts crossing the NbTi resistivity step at $T_c$ advance at the damped linearized rate instead of overshooting; the term preserves strict diagonal dominance and vanishes at steady state.
* **Per-Wire Geometry:** Cross-sectional area is tracked per wire entry (per strand, with `wireCount` strands per bundle), allowing mixed wire gauges across the harness.
* **Heat Flux Monitoring:** Provides methods to calculate the heat leak at any node or plate, crucial for calculating the heat load on specific cooling stages. 
