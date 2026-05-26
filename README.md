# Market Maker Simulator™

A deterministic, zero-latency quantitative execution matrix running natively in the browser. This terminal simulates high-frequency market microstructure, forcing the user to manage inventory risk, adverse selection, and continuous quoting algorithms against a synthetic, stochastically generated order flow.

## Theoretical Architecture

The simulation bypasses retail approximations, anchoring its quoting logic and risk matrices in rigorous academic market making frameworks.

### Avellaneda-Stoikov Inventory Management
The quoting engine abandons symmetric pegging and implements dynamic reservation pricing based on the Avellaneda-Stoikov (2008) framework. 

The Reservation Price $r(s, t)$ continuously shifts away from the mid-price $s$ to mean-revert accumulated inventory $q$:
$$r(s, t) = s - q \gamma \sigma^2 (T-t)$$

The Optimal Half-Spread $\delta$ expands and contracts deterministically based on real-time volatility $\sigma$ and risk aversion $\gamma$:
$$\delta = \frac{\gamma \sigma^2 (T-t)}{2} + \frac{1}{\gamma} \ln\left(1 + \frac{\gamma}{k}\right)$$

### Fractional Microstructure & Adverse Selection
The matrix relies on continuous-time non-Markovian stochastic processes to generate order flow.
* **VPIN & Kyle's Lambda ($\lambda$):** The execution engine actively computes the Volume-Synchronized Probability of Informed Trading and price impact coefficients, penalizing the user for supplying liquidity during toxic, directional momentum bursts.
* **Rough Volatility (RFSV):** The order arrival process is monitored via the Hurst Exponent ($H < 0.5$) and visualized in real-time through a fractional Volterra decay kernel, confirming anti-persistent, mean-reverting execution regimes.

## Technical Execution
* **Zero-Latency Infrastructure:** Engineered strictly with pure HTML, CSS, and vanilla JavaScript. 
* **Decoupled State Machine:** The stochastic Poisson fill simulator and Limit Order Book (LOB) array mutations operate independently of the DOM rendering loop, ensuring algorithmic integrity regardless of visual frame rate.
* **Abyssal Aesthetics:** The interface utilizes a strict `#0F0F0F` spatial environment, glassmorphic data containers, and tabular-numeric typography to mirror the cognitive optimization of Tier-1 proprietary trading tools.

## Developer
**Gorazd Atanasovski** *Founder, Algo Trading Society*
