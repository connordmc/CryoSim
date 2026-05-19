# Material Property Models and Constants

This module provides cryogenic material properties, analytical parameterizations, and tabulated lookup tables used throughout the simulation. Properties are evaluated across a wide temperature range ($0.5 \text{ K} \le T \le 500 \text{ K}$) and log-spaced into pre-computed tables for fast $O(\log N)$ binary search interpolation.

## Material Characterization

### OFHC Copper (RRR = 50)
Copper material properties are tailored for Oxygen-Free High-Conductivity (OFHC) copper with a Residual Resistivity Ratio (RRR) of 50. 
* **Density ($\rho$):** $8960.0 \text{ kg/m}^3$
* **Thermal Conductivity ($k$):** Modeled using the standard NIST rational polynomial fit. Below $4 \text{ K}$, the temperature parameter is clamped to $4 \text{ K}$ to avoid low-temperature divergence in the polynomial expression.
* **Specific Heat ($C_p$):** Employs the NIST 7th-order log-polynomial fit from $4 \text{ K}$ to $300 \text{ K}$. For temperatures below $4 \text{ K}$, it smoothly transitions to an analytical low-temperature specific heat model combining electronic ($\gamma T$) and lattice cubic ($\beta T^3$) terms:
  $$C_p(T) = 0.0108T + 0.00076T^3$$
* **Electrical Resistivity ($\rho_E$):** Evaluated using the Bloch-Grüneisen model, which solves the scattering integrand via numerical Simpson integration. It bounds the residual resistivity at $\rho_0 = \rho_{300} / \RRR$ (where $\rho_{300} = 15.53 \text{ n}\Omega\cdot\text{m}$) and scales phonon contributions relative to a Debye temperature ($\theta_D$) of $343 \text{ K}$.

### NbTi (Superconductor)
[cite_start]Niobium-Titanium properties capture both the normal-conducting and superconducting regimes[cite: 115].
* [cite_start]**Density ($\rho$):** $6000.0 \text{ kg/m}^3$ [cite: 115]
* **Thermal Conductivity ($k$):** Implemented using three distinct piecewise polynomial fits depending on the temperature regime to align accurately with empirical datasets[cite: 116, 117]:
  * [cite_start]$T \le 10 \text{ K}$ [cite: 116]
  * [cite_start]$10 \text{ K} < T \le 100 \text{ K}$ [cite: 116]
  * $T > 100 \text{ K}$ [cite: 117]
* [cite_start]**Specific Heat ($C_p$):** Modeled across four piecewise continuous temperature bands to track lattice and electronic contributions up to room temperature and beyond[cite: 115]:
  * $T < 20 \text{ K}$: Captures low-temperature electronic and phonon contributions ($0.1657T + 0.0029T^3$)[cite: 115].
  * [cite_start]$20 \text{ K} \le T < 50 \text{ K}$ [cite: 115]
  * [cite_start]$50 \text{ K} \le T < 175 \text{ K}$ [cite: 115]
  * $175 \text{ K} \le T \le 500 \text{ K}$ [cite: 115]
* **Electrical Resistivity ($\rho_E$):** Represented as a step-function across the critical superconducting transition temperature ($T_c = 9.2 \text{ K}$). It acts as a perfect superconductor ($\rho_E = 0$) when $T \le 9.2 \text{ K}$ and transitions to its normal-state state-alloy residual resistivity of $5.6 \times 10^{-7} \ \Omega\cdot\text{m}$ when $T > 9.2 \text{ K}$.

---

## Numerical Framework & Tabulation

To alleviate the computational overhead of evaluating continuous transcendental functions and numerical integrals (e.g., Bloch-Grüneisen integrands) at every simulation time step, properties are pre-compiled into fixed-size datasets upon initialization.

### Tabulation Pipeline (`buildTable`)
During startup, `buildTable` constructs an isolated `MaterialTable` instance for each constituent material.
* **Table Size ($N$):** 500 nodes.
* **Temperature Bounds:** Logarithmically spaced from $T_{\min} = 0.5 \text{ K}$ to $T_{\max} = 500 \text{ K}$. Logarithmic spacing ensures fine-grained resolution in ultra-low cryogenic zones where property curves vary sharply across fractions of a Kelvin.
* **Floor Clamping:** Protects numeric stability in solvers by forcing a strict physical floor value on calculated points ($k \ge 10^{-12} \text{ W/(m}\cdot\text{K)}$ and $C_p \ge 10^{-8} \text{ J/(kg}\cdot\text{K)}$).

### Runtime Retrieval (`interpolateTabulated`)
State calculations look up required conditions at run time via linear interpolation over the generated log tables. The function utilizes a bit-shifted binary search (`>> 1`) to achieve $O(\log N)$ performance:

1. **Boundary Clamping:** Inputs extending past table limits are clamped out-of-bounds to the absolute values at $T_{\min}$ or $T_{\max}$ without throwing errors.
2. **Binary Search Localizing:** Efficiently seeks the closest index bounding pair `[lo, hi]` matching temperature $T$.
3. **Linear Fraction Application:** Determines the exact proportional fraction between points to linearly scale and output the precise property parameter.