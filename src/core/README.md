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

The `step` function advances the simulation by a given time interval `dt`. It automatically manages substeps if the temperature $\Delta$ exceeds the stability threshold (50K).

```typescript
const result = solver.step(dt, powerFn, currentTime);
```

## Steady State Calculation

For static analysis, use the built-in steady-state solver which iteratues until the solution converges within a specific threshold:

```typescript
const steadyStateSolver = ThermalSolver.computeSteadyState(config, plates, wireConfigs);
```

Key Features
* **Dynamic Plate Cooling:** Implements $Q_{fridge}(T) = Q_{capacity} tanh(T/4.2)$, modeling the non-linear cooling power of cryogenic systems.
* **Per-Node Area Support:** Unlike simplified models, this solver tracks the cross-sectional area per node, allowing for accurate simulation fo wires with varying thicknesses.
* **Heat Flux Monitoring:** Provides methods to calculate the heat leak at any node or plate, crucial for calculating the heat load on specific cooling stages. 
