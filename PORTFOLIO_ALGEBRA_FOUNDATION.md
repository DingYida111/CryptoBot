# Portfolio Algebra Foundation

> First-phase design document for a unified `instrument / security / strategy / residual` framework
> Scope: define the mathematical base layer and software contracts before solver implementation
> Status: design-only, actionable for Python or TypeScript implementation

---

## 1. Goal

CryptoBot is currently centered on one main trading target: `BTC-USDT-SWAP`.

That is acceptable for a single-strategy bot, but it does not scale well once we need to support:

- multiple underlyings such as `BTC`, `ETH`, `XAUT`
- multiple tradable forms such as `spot`, `perp`, `future`
- composite trades such as `BTC-ETH spread`
- multiple strategy families under one risk and execution system

The target state is:

- all standard trades should be represented as combinations of approved strategy bases
- any deviation from those standard bases must enter a controlled `residual` bucket
- all positions, exposures, and trade decisions should be expressed under one linear algebra layer

This document defines the first implementable step toward that target.

---

## 2. Core View

The framework should not start from “strategy code”.

It should start from a common algebra:

1. `Security`
   The smallest risk atom tracked by the portfolio layer.

2. `Instrument`
   A tradable object, atomic or composite, that can be mapped to security exposure.

3. `Strategy`
   A family of approved trade directions and constraint templates, not just a name or one signal.

4. `Residual`
   The non-standard part of a trade or position that cannot or should not be fully represented by strategy bases.

5. `Optimizer`
   A solver-facing layer that takes current state plus constraints and chooses the best trade increment.

This means the real center of the system is not “which strategy fired”, but:

- what instruments we hold
- what security exposures those imply
- which part is standard strategy exposure
- which part is residual
- what incremental trade is allowed next

---

## 3. Design Principles

### 3.1 Standard-first, residual-controlled

Do not force every trade to fit the strategy basis perfectly.

Correct principle:

- standard trades should be represented by strategy basis first
- non-standard pieces go into `residual`
- residual must be bounded, explained, and monitored

This is safer than over-trading just to preserve a mathematically clean decomposition.

### 3.2 Security means risk atom, not marketing name

Do not define `Security` too coarsely.

Bad simplification:

- “BTC spot and BTC perp both map to BTC”

That loses critical structure:

- funding
- quote-currency cash effect
- margin usage
- contract multiplier
- venue-specific liquidation behavior

So `Security` should represent the smallest portfolio risk unit that matters operationally.

### 3.3 Separate exposure mapping from execution details

The algebra layer should work with normalized quantities and linear exposures.

Execution-layer details such as:

- lot size
- contract size
- maker/taker constraints
- reduce-only
- venue order types

should be attached to instruments, but not mixed into the core portfolio math.

### 3.4 Solve incremental trades, not full state replacement

The default optimization variable should be trade increment `dq`, not full target position `q`.

This is operationally safer because:

- current holdings already exist
- transaction costs depend on changes
- emergency flattening is special behavior
- residual naturally belongs to the delta layer

### 3.5 Linear first, nonlinear later

Phase 1 should support a linear or mixed-integer linear foundation only.

This is enough for:

- exposure limits
- absolute value risk terms
- turnover penalties
- gross / net bounds
- integer lot constraints
- residual penalties

Nonlinear effects such as impact, liquidation surfaces, and fill probability can be added later.

---

## 4. Scope of This First Phase

This document only covers the foundational layer.

### In scope

- canonical object model
- mathematical definitions
- instrument-to-security exposure mapping
- strategy-basis representation
- residual mechanism
- solver input/output contract
- first implementation milestones

### Out of scope

- full LP/MIP implementation
- venue routing engine
- multi-venue settlement and cross-margin modeling
- nonlinear slippage model
- production auto-trading for new assets

---

## 5. Canonical Definitions

### 5.1 Security

`Security` is the smallest portfolio exposure atom the system tracks.

Properties:

- immutable identity
- explicit unit
- explicit mark source
- explicit category

Examples:

- `BTC_DELTA`
- `ETH_DELTA`
- `XAU_DELTA`
- `USD_CASH`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`
- `XAUT_ISSUER_RISK`

Important:

- `Security` is not required to be directly tradable
- one tradable instrument may load several securities
- one security may appear across many instruments

### 5.2 Instrument

`Instrument` is a tradable object or composite execution object.

Two kinds:

1. `AtomicInstrument`
   A venue-native orderable symbol.

Examples:

- `OKX:BTC-USDT-SPOT`
- `OKX:BTC-USDT-SWAP`
- `OKX:ETH-USDT-SPOT`

2. `CompositeInstrument`
   A synthetic object defined by a basket of child instruments.

Examples:

- `SYNTH:BTC-ETH-SPREAD`
- `SYNTH:BTC-SPOT-PERP-BASIS`

Composite instruments should be expanded to atomic instruments before execution, but may remain first-class objects in research, optimization, and reporting.

### 5.3 Strategy

`Strategy` is not just a signal function.

It is a template containing:

- approved basis directions
- allowed instrument universe
- parameter schema
- lifecycle semantics
- risk constraints
- objective contribution

Examples:

- `btc_directional`
- `eth_directional`
- `btc_eth_mean_reversion`
- `btc_spot_perp_carry`
- `xaut_defensive_overlay`

### 5.4 Residual

`Residual` is the part of a trade or position that is not covered by approved strategy bases.

Typical sources:

- emergency flatten
- forced de-risking
- partial fill
- fee / funding / financing drift
- lot-size rounding
- manual intervention
- venue mismatch or stale external state

Residual is allowed, but must be:

- bounded
- attributed
- persisted
- visible in monitoring

---

## 6. Mathematical Model

Assume:

- `n` instruments
- `m` securities
- `k` strategy basis directions

### 6.1 Position and trade state

- `q0 ∈ R^n`
  Current instrument position vector

- `dq ∈ R^n`
  Trade increment vector chosen for the next decision step

- `q1 = q0 + dq`
  Post-trade instrument position vector

### 6.2 Instrument-to-security exposure map

Define:

- `E ∈ R^(m×n)`
  Instrument-to-security exposure matrix

Then:

- `s0 = E q0`
  Current security exposure

- `ds = E dq`
  Incremental security exposure

- `s1 = E q1`
  Post-trade security exposure

Important interpretation:

- `E` should express normalized portfolio exposure
- execution cash flow should be modeled separately when needed

### 6.3 Strategy basis decomposition

Define:

- `B ∈ R^(n×k)`
  Strategy-basis trade matrix

Each column of `B` is one approved canonical direction in instrument space.

Then the standard-first decomposition is:

- `dq = B w + r`

where:

- `w ∈ R^k`
  Strategy coefficients

- `r ∈ R^n`
  Residual trade vector

This is the key equation of the framework.

It means:

- the optimizer should first allocate to approved basis directions `B w`
- any part outside that span becomes residual `r`

### 6.4 Exposure view of residual

Residual also creates security exposure:

- `dr = E r`

So the portfolio must manage two linked residuals:

- instrument residual `r`
- security residual `dr`

Instrument residual matters for execution and settlement.

Security residual matters for risk.

### 6.5 Objective skeleton

A first-phase linear objective can take this shape:

maximize:

- signal reward
- carry or basis reward
- liquidity reward

minus:

- transaction cost penalty
- residual penalty
- turnover penalty
- concentration penalty

In simplified form:

`max alpha^T w - c^T |dq| - lambda_r * ||W_r r||_1 - lambda_s * ||W_s s1||_risk`

The exact objective coefficients are strategy-dependent, but the decomposition above should stay stable.

### 6.6 Absolute value linearization

Any term like `|x|` should be linearized with auxiliary variables.

Example:

- introduce `y >= 0`
- enforce `y >= x`
- enforce `y >= -x`

Then minimize or constrain `y`.

This pattern will be reused for:

- gross exposure
- turnover
- residual budget
- absolute risk terms

---

## 7. Why `dq = B w + r` Is Better Than Direct Strategy Positions

There are two natural formulations:

1. represent absolute positions as strategy combinations
2. represent trade increments as strategy combinations

This framework chooses the second as default.

Reason:

- current positions may already contain legacy or manual state
- emergency actions are naturally incremental
- fees and turnover live on trades, not only terminal positions
- partial fills and de-risking are easier to represent on `dq`
- residual is cleaner as an incremental exception

Absolute target positions can still be used later, but they should be derived from incremental decisions, not replace them.

---

## 8. Security Taxonomy

Phase 1 should use a small but explicit taxonomy.

Recommended categories:

- `delta`
- `cash`
- `funding`
- `basis`
- `issuer`
- `borrow`
- `other`

### 8.1 Minimal initial set

For CryptoBot’s likely next step, start with:

- `BTC_DELTA`
- `ETH_DELTA`
- `XAU_DELTA`
- `USDT_CASH`
- `USD_CASH`
- `BTC_PERP_FUNDING_OKX`
- `ETH_PERP_FUNDING_OKX`

Do not add dozens of risk atoms on day one.

But do not collapse everything into only `{BTC, ETH, XAUT}` either.

---

## 9. Instrument Model

Each instrument must expose at least these attributes.

### 9.1 Required fields

- `instrument_id`
- `kind`: `spot | perp | future | synthetic | spread`
- `venue`
- `base_asset`
- `quote_asset`
- `quantity_unit`
- `price_unit`
- `min_trade_size`
- `step_size`
- `contract_multiplier`
- `allowed_sides`
- `exposure_rules`
- `cashflow_rules`
- `execution_rules`

### 9.2 Critical distinction

Each instrument needs at least two mappings:

1. `position exposure map`
   What portfolio exposure one unit of position contributes.

2. `trade cashflow map`
   What cash / fee / financing effect one unit of trade causes.

This distinction is mandatory.

If the same object is used for both, the optimizer and PnL engine will eventually become inconsistent.

### 9.3 Example table

| Instrument | Kind | Position exposure sketch | Trade cashflow sketch |
|---|---|---|---|
| `OKX:BTC-USDT-SPOT` | spot | `+BTC_DELTA` | `-USDT_CASH - fee` when buying |
| `OKX:BTC-USDT-SWAP` | perp | `+BTC_DELTA`, funding sensitivity | margin/funding/fee effects |
| `OKX:ETH-USDT-SPOT` | spot | `+ETH_DELTA` | `-USDT_CASH - fee` when buying |
| `SYNTH:BTC-ETH-SPREAD` | synthetic | `+BTC_DELTA - beta * ETH_DELTA` | expanded to child cashflows |

---

## 10. Strategy Model

Each strategy template should define:

- `strategy_id`
- `label`
- `basis_ids`
- `allowed_instruments`
- `activation_conditions`
- `objective_model`
- `risk_constraints`
- `lifecycle_rules`
- `parameter_schema`

### 10.1 Strategy basis vs strategy template

Keep these separate:

1. `StrategyBasis`
   A canonical direction in instrument space.

2. `StrategyTemplate`
   A family that selects and constrains basis directions.

Example:

- `basis: long_btc_perp_okx`
- `basis: long_btc_spot_short_btc_perp`
- `basis: long_btc_short_eth`

These bases may all belong to different strategy templates.

This separation prevents the system from hard-wiring one basis to one strategy name.

### 10.2 Example basis directions

Examples in instrument coordinates:

- `b1 = +1 * OKX:BTC-USDT-SWAP`
- `b2 = +1 * OKX:BTC-USDT-SPOT - 1 * OKX:BTC-USDT-SWAP`
- `b3 = +1 * OKX:BTC-USDT-SPOT - beta * OKX:ETH-USDT-SPOT`

The optimizer chooses `w1`, `w2`, `w3`.

Any remaining trade component falls into `r`.

---

## 11. Residual Policy

Residual is not a bug by default.

It is a controlled exception channel.

### 11.1 Allowed residual reasons

Phase 1 should support explicit reason codes:

- `MANUAL_OVERRIDE`
- `EMERGENCY_FLATTEN`
- `LOT_ROUNDING`
- `PARTIAL_FILL`
- `FEE_DRIFT`
- `FUNDING_DRIFT`
- `STATE_RECONCILIATION`
- `MARGIN_DELEVERAGE`

### 11.2 Residual constraints

Residual should be constrained in at least three ways:

1. `per-instrument bound`
   Keep individual residual legs from growing silently.

2. `portfolio L1 budget`
   Example: `||W_r r||_1 <= R_max`

3. `security residual bound`
   Example: `||E r||_risk <= S_residual_max`

### 11.3 Residual monitoring

Residual must be persisted and surfaced in:

- optimization output
- execution audit logs
- portfolio state snapshots
- health dashboards

The key operational question is:

- “What fraction of the current risk is standard strategy risk?”
- “What fraction is residual exception risk?”

---

## 12. Flattening Rules

The user already stated an important exception:

- except for forced full flatten, trades should be mapped into the strategy algebra

This should become an explicit policy.

### 12.1 Standard flatten

Standard exits should still be represented through strategy basis when possible.

Example:

- unwind `long_btc_perp_okx` by applying negative strategy weight

### 12.2 Forced flatten

Forced flatten may bypass basis purity.

Examples:

- venue risk event
- margin call risk
- stale internal state
- operator panic exit

These should be encoded as residual trades with:

- explicit reason code
- elevated priority
- post-event reconciliation task

---

## 13. State Model

The portfolio layer should maintain four linked states.

### 13.1 Instrument position state

- current quantity by instrument
- entry metadata
- venue identifiers

### 13.2 Security exposure state

- aggregated exposures by security
- mark prices
- risk metrics

### 13.3 Cash and margin state

- free cash
- locked margin
- venue balances
- funding accrual

### 13.4 Residual state

- residual positions
- residual trade history
- residual reason attribution

Do not hide residual inside normal position state.

It needs to be inspectable as a first-class object.

---

## 14. Data Contracts

This section is intentionally Python-friendly.

The same conceptual model can be implemented in Python or TypeScript.

### 14.1 `SecuritySpec`

```python
from dataclasses import dataclass
from typing import Literal

@dataclass(frozen=True)
class SecuritySpec:
    security_id: str
    category: Literal["delta", "cash", "funding", "basis", "issuer", "borrow", "other"]
    unit: str
    mark_source: str
    description: str
```

### 14.2 `InstrumentSpec`

```python
from dataclasses import dataclass, field
from typing import Literal

@dataclass(frozen=True)
class InstrumentSpec:
    instrument_id: str
    kind: Literal["spot", "perp", "future", "synthetic", "spread"]
    venue: str
    base_asset: str
    quote_asset: str
    quantity_unit: str
    price_unit: str
    min_trade_size: float
    step_size: float
    contract_multiplier: float
    allowed_sides: tuple[str, ...]
    position_exposure: dict[str, float]
    trade_cashflow: dict[str, float]
    tags: tuple[str, ...] = field(default_factory=tuple)
```

### 14.3 `StrategyBasisSpec`

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class StrategyBasisSpec:
    basis_id: str
    instrument_weights: dict[str, float]
    description: str
```

### 14.4 `StrategyTemplateSpec`

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class StrategyTemplateSpec:
    strategy_id: str
    basis_ids: tuple[str, ...]
    allowed_instruments: tuple[str, ...]
    parameter_schema: dict[str, str]
    lifecycle_rules: dict[str, str]
    tags: tuple[str, ...] = field(default_factory=tuple)
```

### 14.5 `PortfolioState`

```python
from dataclasses import dataclass

@dataclass
class PortfolioState:
    instrument_positions: dict[str, float]
    security_exposures: dict[str, float]
    cash_balances: dict[str, float]
    residual_positions: dict[str, float]
```

### 14.6 `OptimizationRequest`

```python
from dataclasses import dataclass

@dataclass
class OptimizationRequest:
    portfolio_state: PortfolioState
    enabled_strategies: list[str]
    basis_ids: list[str]
    objective_scores: dict[str, float]
    instrument_bounds: dict[str, tuple[float, float]]
    security_bounds: dict[str, tuple[float, float]]
    residual_budget: float
```

The exact code can change, but the object boundaries should stay stable.

---

## 15. Example: BTC Spot, BTC Perp, ETH Spot, BTC-ETH Spread

Assume these instruments:

- `i1 = OKX:BTC-USDT-SPOT`
- `i2 = OKX:BTC-USDT-SWAP`
- `i3 = OKX:ETH-USDT-SPOT`
- `i4 = SYNTH:BTC-ETH-SPREAD`

Assume these securities:

- `s1 = BTC_DELTA`
- `s2 = ETH_DELTA`
- `s3 = USDT_CASH`
- `s4 = BTC_PERP_FUNDING_OKX`

### 15.1 Exposure sketch

Example normalized exposure matrix:

| Security \\ Instrument | `i1` BTC spot | `i2` BTC perp | `i3` ETH spot | `i4` BTC-ETH spread |
|---|---:|---:|---:|---:|
| `BTC_DELTA` | 1 | 1 | 0 | 1 |
| `ETH_DELTA` | 0 | 0 | 1 | -beta |
| `USDT_CASH` | 0 | 0 | 0 | 0 |
| `BTC_PERP_FUNDING_OKX` | 0 | 1 | 0 | 0 |

This is intentionally simplified.

The real implementation may use instrument-specific normalization such as:

- BTC notional
- USD delta
- per-contract delta

But the shape of the model should remain the same.

### 15.2 Basis sketch

Suppose approved basis directions are:

- `b1`: long BTC perp
- `b2`: long BTC spot, short BTC perp
- `b3`: long BTC, short beta ETH

Then:

- `dq = B w + r`

could represent:

- directional BTC exposure through `b1`
- carry/basis through `b2`
- cross-asset spread through `b3`

Anything not covered becomes `r`.

---

## 16. First-Phase Constraints

These are the first constraints worth implementing.

### 16.1 Instrument bounds

- maximum long / short quantity
- maximum turnover per step
- allowed side restrictions

### 16.2 Security bounds

- net BTC delta bound
- net ETH delta bound
- net XAU delta bound
- funding exposure bound

### 16.3 Cash and margin bounds

- minimum free cash
- maximum margin usage
- venue-specific leverage cap

### 16.4 Residual bounds

- max residual per instrument
- max residual gross
- max residual risk exposure

### 16.5 Integer / lot constraints

- contract quantities must satisfy exchange step rules
- spot quantities must respect lot size

These can be linearized with integer or mixed-integer variables when needed.

---

## 17. First-Phase Deliverables

This is the most important implementation section.

The first engineering step should **not** be “build the solver”.

It should be these five deliverables.

### 17.1 Canonical registries

Create static registries for:

- `SecuritySpec`
- `InstrumentSpec`
- `StrategyBasisSpec`
- `StrategyTemplateSpec`

Deliverable:

- one versioned source of truth for all identifiers

### 17.2 Exposure compiler

Build a pure function layer that:

- vectorizes instrument positions
- computes security exposures via `E`
- expands composite instruments into atomic form when needed

Deliverable:

- deterministic exposure computation from portfolio state

### 17.3 Residual ledger

Build a residual tracking component that:

- stores residual position by instrument
- stores residual reason codes
- computes residual security exposure

Deliverable:

- residual visible as a first-class state object

### 17.4 Optimization input builder

Build a request compiler that converts:

- current state
- enabled strategies
- bounds
- signal scores

into a normalized optimization payload.

Deliverable:

- a solver-ready, language-agnostic request format

### 17.5 Invariant tests

Add tests for:

- exposure correctness
- composite expansion correctness
- residual accounting correctness
- unit normalization correctness

Deliverable:

- trust in the bookkeeping layer before any live optimization

---

## 18. Recommended Storage Tables

The current project already stores managed strategy snapshots.

For the algebra layer, add separate tables later such as:

- `security_specs`
- `instrument_specs`
- `strategy_basis_specs`
- `strategy_template_specs`
- `portfolio_snapshots`
- `security_exposure_snapshots`
- `residual_snapshots`
- `optimization_requests`
- `optimization_results`

Do not overload existing trade logs for this purpose.

This framework needs structure, not just text logs.

---

## 19. Acceptance Criteria for Phase 1

Before moving to a solver-backed trading workflow, the following should hold:

1. Every supported instrument can be mapped deterministically to security exposure.
2. Composite instruments can be expanded into atomic instruments without ambiguity.
3. Every standard trade request can be represented as `B w`.
4. Every non-standard component is explicitly booked into residual `r`.
5. Residual exposure can be bounded and reported.
6. Instrument units, security units, and execution units are not mixed silently.

If these six are not true, adding LP/MIP will only formalize bad bookkeeping.

---

## 20. Recommended Build Order

Recommended engineering order:

1. define registries and ids
2. build exposure compiler
3. build residual ledger
4. build normalized portfolio snapshot
5. build optimization request format
6. only then integrate LP/MIP

This order is deliberate.

The portfolio algebra is the safety layer.

The solver comes after that.

---

## 21. Critical Risks

These are the main ways this project can fail.

### 21.1 Security definitions too coarse

If `Security` is reduced to only asset name, risk will be hidden instead of modeled.

### 21.2 Unit inconsistency

If the system mixes:

- contract count
- coin quantity
- USD notional
- delta exposure

without explicit conversion rules, PnL and risk will drift silently.

### 21.3 Strategy templates too weak

If strategy is modeled as only “one vector”, lifecycle and execution semantics disappear.

### 21.4 Residual hidden inside normal positions

If residual is not separated, the system will lose the ability to distinguish intentional risk from exception risk.

### 21.5 Solver-first implementation

If the team builds optimization before stable exposure bookkeeping, the entire stack becomes fragile.

---

## 22. Suggested Next Document

After this foundation is accepted, the next document should define:

- concrete Python module layout
- exact registry file format
- canonical matrix builder
- optimization variable naming
- LP/MIP constraint catalog
- residual persistence schema
- compatibility path with current `strategy_runner` and `runtime`

That next document should move from concept to package structure and implementation tickets.

---

## 23. Bottom Line

The correct target is not:

- “every trade must perfectly fit a strategy”

The correct target is:

- “every standard trade should be represented by strategy basis first, every deviation should enter controlled residual, and all of it should be governed under one instrument/security algebra”

That is the right mathematical base for a safer and more extensible multi-asset trading system.
