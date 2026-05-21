# Thermal Solver Module

This directory contains the numerical solvers responsible for calculating the 1D transient and steady-state thermal behavior of multi-wire systems coupled with thermal anchoring plates (e.g., fixed temperatures, resistors, or dynamic cryogenic refrigeration stages).

---

## Technical Overview

### Mathematical Formulation
The module solves the 1D non-linear heat equation with temperature-dependent material properties ($\rho$, $C_p$, $k$, $\rho_e$) and localized volumetric source terms:

$$\rho(T) C_p(T) \frac{\partial T}{\partial t} = \frac{\partial}{\partial x} \left( k(T) \frac{\partial T}{\partial x} \right) + \frac{I^2 \rho_e(T)}{A(x)^2} + q_{\text{ext}}$$

### Discretization Architecture
* **`solver.ts`**: Uses a fully implicit **Crank-Nicolson scheme** integrated with an adaptive time-substepping rollback engine. Matrix inversion is performed via a fast, specialized linear-time $O(N)$ **Thomas Algorithm** for tridiagonal systems.
* **`Solver.cpp`**: Employs a generalized sparse system configuration powered by **Eigen::SparseMatrix** utilizing an automated numerical finite-difference Jacobian framework.

---

## Architectural Comparison Matrix

| Architectural Feature | `solver.ts` (Current State) | `Solver.cpp` (Current State) | Required Action for `solver.ts` |
| :--- | :--- | :--- | :--- |
| **Linear Algebra Core** | Rigid Tridiagonal ($O(N)$ Thomas Algorithm). | Generalized Sparse Layout (`Eigen::SparseMatrix`). | Keep for speed, but transition to a Banded/Sparse layout to allow off-diagonal thermal parasitic coupling. |
| **Material Evaluation** | Run-time adaptive, inline sub-stepping. | Strictly evaluated prior to solver calls. | Enforce explicit property updates immediately before evaluating matrix boundaries on Step 0. |
| **Interface Conduction** | Blends area arithmetically; uses harmonic $k$ for nodes. | Enforces strict harmonic interfacial resistances for plates. | Incorporate localized harmonic area evaluations to accurately model high-vacuum thermal contact resistances at the plates. |
| **Source Tracking** | Exact first-order Taylor analytical derivative. | Central-difference numerical Jacobian (contains a critical sign bug). | **Do NOT copy C++ here.** Maintain the analytical derivatives of `solver.ts`. |
| **Stability Controls** | High-fidelity adaptive sub-stepping rollback framework. | Throws `std::runtime_error`. | **Do NOT copy C++ here.** Maintain the sub-stepping architecture. |

---

## TODO: C++ Parity Alignment Plan

To bridge the architectural gaps where mathematically sound—while strictly maintaining TypeScript's superior stability and performance features—execute the following updates in `solver.ts`:

### 1. Matrix Layout Upgrade (Linear Algebra Core)
* **What to change:** Refactor `WireSolverState` to move away from the rigid tridiagonal private storage vectors (`lower`, `diag`, `upper`) and the restricted `thomasSolve()` sequence.
* **How to implement:** * Implement a **Banded Matrix layout** or a custom **Compressed Sparse Row (CSR)** structure to replace the three isolated tracking arrays. A banded layout with a lower/upper bandwidth of 1 retains the near $O(N)$ speed advantage for primary conduction.
  * Update the matrix assembly steps in `crankNicolsonStep` to map coefficients into this new layout.
  * Refactor the solver call to execute a banded LU factorization (with or without pivoting) or a sparse relaxation method. This exposes off-diagonal element coordinates so that multi-wire parasitic bridging, structural support heat links, and cross-talk terms can be injected into the system matrix—bringing it to parity with `Solver.cpp`'s structural capabilities.

### 2. Explicit Material Updates (Evaluation Sequence)
* **What to change:** Ensure material properties ($\kappa$, $C_p$, $\rho_e$) match initial temperature state conditions on Step 0 *prior* to parsing boundary constants or launching the sub-stepping orchestrator loops.
* **How to implement:**
  * Modify `ThermalSolver.step()` to invoke an explicit, standalone synchronization pass over all child wires at the very beginning of the function execution block:
    ```typescript
    // Ensure properties match current state before assessing boundaries or delta constraints
    for (const wire of this.wires) {
      wire.updateMaterialProperties();
    }
    ```
  * Decouple this initial pass from the active sub-stepping loop to ensure that step reductions do not introduce single-step lag or initialization errors on property tracking thresholds.

### 3. Interfacial Thermal Contact Model (Interface Conduction)
* **What to change:** Eliminate unphysical arithmetic area blending ($A_{\text{face}} = \frac{A_i + A_{i+1}}{2}$) across varying segment boundaries, node junctions, and integrated plates. 
* **How to implement:**
  * Refactor `computeHeatFluxAtNode(nodeIdx, dx)` to replace the face area calculations with a mathematically sound **harmonic mean area calculation**:
    ```typescript
    // Replace: const Aface = (this.areaNodes[i - 1] + this.areaNodes[i]) / 2;
    // With rigorous harmonic representation matching high-vacuum contact constraints:
    const A_left = this.areaNodes[i - 1];
    const A_curr = this.areaNodes[i];
    const Aface = (A_left + A_curr > 0) ? (2 * A_left * A_curr) / (A_left + A_curr) : 0;
    ```
  * Apply this same harmonic area transformation directly inside `crankNicolsonStep` during the assembly of the `alpha`, `beta`, `alphaEff`, and `betaEff` localized matrix coefficients to correctly map interfacial contact mechanics across plate anchors and tapering nodes.

> ### ⚠️ Crucial Architectural Guardrails
> * **DO NOT** replace the analytical Taylor first-order derivative engine in `solver.ts` with the C++ central-difference framework (preserving immunity to the C++ numerical sign bugs).
> * **DO NOT** deprecate the TypeScript adaptive rollback sub-stepping framework. Avoid the crude `std::runtime_error` paradigms found in the C++ project.
