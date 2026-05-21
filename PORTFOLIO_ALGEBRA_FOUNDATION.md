# Portfolio Algebra Foundation V1

> TypeScript-first implementation plan for a unified `instrument / security / strategy / residual` layer
> Scope: first deployable version for single-instrument `BTC-USDT-SWAP`
> Status: migration plan, not solver implementation

---

## 1. Goal

CryptoBot already has working runtime and execution layers:

- `src/trade/strategy_runner.ts`
- `src/trade/chop_grid.ts`
- `src/runtime/*`
- `src/monitor/storage.ts`

What it does not yet have is a stable portfolio algebra layer that can answer these questions in a uniform way:

- what instrument position do we hold
- what underlying security exposure does that imply
- which part of a trade is standard strategy basis
- which part is non-standard residual
- how can we later replace ad hoc trade logic with a controlled optimizer

The target state is:

- standard trades should be represented by approved strategy basis first
- deviations should be recorded as controlled residual
- the algebra layer should remain pure and side-effect-free
- the first implementation should not disrupt the current trading path

This V1 plan deliberately starts small:

- one instrument
- one basis
- no LP solver
- no execution-path replacement

---

## 2. Guiding Principle

The correct target is not:

- “every trade must perfectly fit a strategy”

The correct target is:

- “every standard trade should be represented by strategy basis first, every deviation should enter controlled residual, and all of it should be governed under one instrument/security algebra”

That is the core idea this V1 implements.

---

## 3. Why V1 Is Narrow

The single biggest risk here is over-abstracting too early.

So V1 is intentionally narrow:

- underlying: `BTC`
- instrument: `OKX:BTC-USDT-SWAP`
- strategy basis count: `1`
- residual policy: record first, constrain later
- optimizer: stub only

This gives us a stable base without rewriting the live bot.

---

## 4. Non-Goals for V1

V1 does **not** include:

- multi-asset support
- composite instrument expansion
- multi-column strategy basis matrix
- LP / MIP solver integration
- residual budget constraints
- execution-path replacement
- controller lifecycle changes

These are intentionally deferred.

---

## 5. Relationship to Current Runtime

Portfolio algebra should sit below the current runtime/controller layer, not replace it.

```text
┌──────────────────────────┐
│   StrategySupervisor     │
│   lifecycle + polling    │
└────────┬─────────────────┘
         │ calls
┌────────▼─────────────────┐
│   StrategyController     │
│   start / sync / stop    │
└────────┬─────────────────┘
         │ reads / writes
┌────────▼─────────────────┐
│   PortfolioAlgebra       │
│   exposure + basis +     │
│   residual + optimizer   │
└────────┬─────────────────┘
         │ reads
┌────────▼─────────────────┐
│   OKX Trade / Market API │
└──────────────────────────┘
```

### 5.1 Boundary rule

`PortfolioAlgebra` must be a pure computation layer.

It may:

- read structured state
- compute exposures
- compute basis decomposition
- compute residual
- compile optimization input
- produce decision intent

It may not:

- place orders
- own API clients
- own DB connections
- manage lifecycle
- poll exchanges
- call controllers directly

All side effects remain in the existing runtime and trade layers.

---

## 6. Core Algebra

V1 keeps the same core decomposition:

- `dq = B w + r`

where:

- `dq`
  instrument trade increment
- `B`
  strategy basis matrix
- `w`
  strategy weights
- `r`
  residual instrument delta

For V1:

- there is only one instrument
- there is only one basis column
- `w` is scalar
- `r` is also scalar in instrument space

That is enough to validate the bookkeeping model before generalization.

---

## 7. Security Model

`Security` means risk atom, not simply asset marketing name.

Even with one BTC perpetual, we already care about more than one conceptual exposure:

- delta exposure
- funding sensitivity
- cash / margin state

### 7.1 Active V1 set

Active in V1:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`

Reserved, not active in V1:

- `ETH_DELTA`
- `XAU_DELTA`
- `USD_CASH`
- `ETH_PERP_FUNDING_OKX`

### 7.2 Important simplification

For V1 only, `BTC_PERP_FUNDING_OKX` uses a placeholder sensitivity equal to contract value.

That means:

- it is tracked explicitly as a separate security id
- but its numeric exposure is temporarily approximated as equal to delta sensitivity

This is a bookkeeping approximation, not a permanent economic model.

---

## 8. Instrument Model

V1 supports only one instrument:

- `OKX:BTC-USDT-SWAP`

### 8.1 Unit rule

Do not normalize to `1`.

Use real contract value.

For OKX `BTC-USDT-SWAP`, V1 should use:

- `contractMultiplier = 0.01`

That means one contract corresponds to:

- `+0.01 BTC_DELTA`
- `+0.01 BTC_PERP_FUNDING_OKX` in the V1 placeholder model

This is important because:

- `E * q` should directly produce BTC quantity
- multiplying by mark price should produce USD notional
- unit consistency is easier to test

### 8.2 V1 exposure matrix

With one instrument, `E` is:

| Security \\ Instrument | `OKX:BTC-USDT-SWAP` |
|---|---:|
| `BTC_DELTA` | `0.01` |
| `USDT_CASH` | `0` |
| `BTC_PERP_FUNDING_OKX` | `0.01` |

This is a V1 practical matrix, not a finished economic model.

---

## 9. Strategy Basis Model

V1 supports only one basis:

- `b1 = +1 * OKX:BTC-USDT-SWAP`

That means:

- `B` is a `1 x 1` matrix
- `w` is the standard strategy trade size in contracts
- `r` is any extra contract delta not explained by basis

This sounds trivial, but it is exactly the right first step:

- it proves the identity `dq = B w + r`
- it validates the registry machinery
- it creates a clean path to multiple bases later

---

## 10. Residual Policy

V1 residual is record-only, not constraint-driven.

That means:

- residual is computed
- residual is persisted
- residual is tagged with reason code
- residual is logged and monitored
- residual does not yet participate in LP constraints

### 10.1 Allowed V1 reason codes

- `MANUAL_OVERRIDE`
- `EMERGENCY_FLATTEN`
- `LOT_ROUNDING`
- `PARTIAL_FILL`
- `FEE_DRIFT`
- `FUNDING_DRIFT`
- `STATE_RECONCILIATION`
- `UNROUTED_DECISION`

### 10.2 V1 monitoring rule

Even though V1 does not constrain residual, it should still expose:

- residual gross
- residual / gross ratio
- residual reason breakdown

Suggested warning threshold:

- residual gross ratio `> 5%`

This is warning-only in V1.

---

## 11. State Model

V1 should not directly merge execution objects into one mutable in-memory struct.

Instead:

- define one new canonical `PortfolioState`
- build adapters from existing runtime state into that canonical shape

Why:

- `PositionState` is execution-oriented
- `ChopGridSnapshot` is regime / inventory execution state
- algebra state should be stable, minimal, and persistent

### 11.1 Canonical state

V1 `PortfolioState` should contain:

- instrument positions
- current security exposures
- cash / margin summary
- residual state
- metadata for current strategy regime and mode

### 11.2 Adapter rule

Do this:

- `strategy_runner` state -> adapter -> `PortfolioState`
- `chop_grid` state -> adapter -> `PortfolioState`

Do not do this:

- rewrite existing trade state machines just to fit the algebra model

---

## 12. TypeScript Data Contracts

V1 is full-stack TypeScript.

Do not keep Python dataclass examples in this document.

Also, do not rely on TypeScript compile-time types alone.

Every core contract should have:

- branded id types
- readonly interfaces
- matching `zod` runtime schemas

### 12.1 Branded ids

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };

export type SecurityId = Brand<string, "SecurityId">;
export type InstrumentId = Brand<string, "InstrumentId">;
export type StrategyBasisId = Brand<string, "StrategyBasisId">;
export type StrategyId = Brand<string, "StrategyId">;
export type ResidualReasonCode = Brand<string, "ResidualReasonCode">;
```

### 12.2 SecuritySpec

```ts
export type SecurityCategory =
  | "delta"
  | "cash"
  | "funding"
  | "basis"
  | "issuer"
  | "borrow"
  | "other";

export interface SecuritySpec {
  readonly securityId: SecurityId;
  readonly category: SecurityCategory;
  readonly unit: string;
  readonly markSource: string;
  readonly description: string;
  readonly active: boolean;
}
```

### 12.3 InstrumentSpec

```ts
export type InstrumentKind =
  | "spot"
  | "perp"
  | "future"
  | "synthetic"
  | "spread";

export interface InstrumentSpec {
  readonly instrumentId: InstrumentId;
  readonly kind: InstrumentKind;
  readonly venue: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly quantityUnit: string;
  readonly priceUnit: string;
  readonly minTradeSize: number;
  readonly stepSize: number;
  readonly contractMultiplier: number;
  readonly allowedSides: readonly ("buy" | "sell")[];
  readonly exposurePerContract: Readonly<Record<SecurityId, number>>;
  readonly tags: readonly string[];
}
```

### 12.4 StrategyBasisSpec

```ts
export interface StrategyBasisSpec {
  readonly basisId: StrategyBasisId;
  readonly instrumentWeights: Readonly<Record<InstrumentId, number>>;
  readonly description: string;
  readonly active: boolean;
}
```

### 12.5 StrategyTemplateSpec

```ts
export interface StrategyTemplateSpec {
  readonly strategyId: StrategyId;
  readonly basisIds: readonly StrategyBasisId[];
  readonly allowedInstruments: readonly InstrumentId[];
  readonly parameterSchema: Readonly<Record<string, string>>;
  readonly lifecycleRules: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}
```

### 12.6 PortfolioState

```ts
export interface PortfolioState {
  readonly asOfMs: number;
  readonly instrumentPositions: Readonly<Record<InstrumentId, number>>;
  readonly securityExposures: Readonly<Record<SecurityId, number>>;
  readonly cashBalances: Readonly<Record<string, number>>;
  readonly residualPositions: Readonly<Record<InstrumentId, number>>;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
```

### 12.7 OptimizationRequest

```ts
export interface OptimizationRequest {
  readonly portfolioState: PortfolioState;
  readonly enabledStrategies: readonly StrategyId[];
  readonly basisIds: readonly StrategyBasisId[];
  readonly objectiveScores: Readonly<Record<string, number>>;
  readonly instrumentBounds: Readonly<Record<InstrumentId, readonly [number, number]>>;
  readonly securityBounds: Readonly<Record<SecurityId, readonly [number, number]>>;
}
```

### 12.8 Runtime validation rule

Each of the interfaces above should have a matching `zod` schema.

Reason:

- DB rows are runtime data
- exchange payloads are runtime data
- recovered snapshots are runtime data
- JSON logs are runtime data

Compile-time types alone are not enough.

---

## 13. Proposed V1 File Layout

V1 should add a new `src/portfolio/` tree.

```text
src/portfolio/
  ids.ts
  security_spec.ts
  instrument_spec.ts
  basis.ts
  residual.ts
  exposure.ts
  portfolio_state.ts
  optimizer_request.ts
  optimizer_stub.ts
  adapters/
    strategy_runner_adapter.ts
    chop_grid_adapter.ts
  schemas/
    security_schema.ts
    instrument_schema.ts
    basis_schema.ts
    portfolio_state_schema.ts
```

This directory should remain pure-computation-oriented.

---

## 14. Migration Path

V1 should be implemented in three milestones, each independently deployable.

## 14.1 M1: Registry + Exposure Compiler

Target duration:

- `1-2 weeks`

### What to build

- `src/portfolio/security_spec.ts`
- `src/portfolio/instrument_spec.ts`
- `src/portfolio/exposure.ts`
- unit tests for exposure correctness

### Initial registry contents

Securities:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`

Instrument:

- `OKX:BTC-USDT-SWAP`

### Functional scope

- pure registry lookup
- compute exposure from contract position
- compute notional from exposure and mark
- no trade-path changes

### What not to touch

- do not change `strategy_runner.ts` trade logic
- do not change order placement code
- do not change controller lifecycle

### Acceptance criteria

1. `computeExposure()` maps 1 BTC swap contract to `0.01 BTC_DELTA`.
2. `computeExposure()` maps 1 BTC swap contract to placeholder `0.01 BTC_PERP_FUNDING_OKX`.
3. exposure times mark price matches current USD notional calculation.
4. delta-PnL implied by exposure matches current hand-written logic for the same price move.

## 14.2 M2: Strategy Basis + Residual Ledger

Target duration:

- `1-2 weeks`

### What to build

- `src/portfolio/basis.ts`
- `src/portfolio/residual.ts`
- `src/portfolio/portfolio_state.ts`
- adapters from current execution state to canonical portfolio state
- new persistence for `portfolio_snapshots`

### Initial basis set

- `b1 = +1 * OKX:BTC-USDT-SWAP`

### Functional scope

- compute `dq`
- decompose into `B w + r`
- persist residual with reason code
- snapshot canonical portfolio state after each loop

### Design constraint

Residual is recorded but not constrained in M2.

### Acceptance criteria

1. every trade delta can be logged as `dq = B w + r`
2. `B` has one column, `w` is scalar, `r` is scalar in instrument space
3. residual reasons are persisted
4. snapshot generation does not change live execution behavior

## 14.3 M3: Optimization Input Builder + Shadow Loop

Target duration:

- `2-3 weeks`

### What to build

- `src/portfolio/optimizer_request.ts`
- `src/portfolio/optimizer_stub.ts`
- `portfolio_shadow_log` persistence
- shadow comparison against existing `strategy_runner`

### Stub behavior

The optimizer stub should mimic the current runner logic, not improve it.

Examples:

- if signal direction matches current position, do nothing
- if signal flips, produce flatten or reverse intent
- if regime is CHOP, emit a grid-oriented execution intent
- if no basis route exists, emit residual

### Important rule

The stub does not call controllers.

It returns a pure output such as:

- `proposedTrade`
- `basisDecomposition`
- `executionRoute`

The outer runtime decides what to do with that output.

### Acceptance criteria

1. optimizer stub output is structurally valid against schema
2. shadow pipeline runs in parallel without affecting live trading
3. trade sequence from shadow output matches current runner behavior with diff `< 1%`
4. execution-path replacement is still disabled

---

## 15. Shadow Validation Strategy

The migration should not begin by replacing the current trading path.

Recommended sequence:

1. keep current `strategy_runner` as the source of live execution
2. run the portfolio algebra pipeline in parallel
3. let `optimizer_stub` compute shadow decisions only
4. compare:
   - actual `dq`
   - basis decomposition
   - residual
   - route classification
5. persist all diffs to `portfolio_shadow_log`

This preserves a running baseline while the new framework proves itself.

---

## 16. One-Instrument Example

V1 should document only the actual active case.

### 16.1 Instrument

- `i1 = OKX:BTC-USDT-SWAP`

### 16.2 Securities

- `s1 = BTC_DELTA`
- `s2 = USDT_CASH`
- `s3 = BTC_PERP_FUNDING_OKX`

### 16.3 Exposure matrix

| Security \\ Instrument | `i1` |
|---|---:|
| `BTC_DELTA` | `0.01` |
| `USDT_CASH` | `0` |
| `BTC_PERP_FUNDING_OKX` | `0.01` |

### 16.4 Basis matrix

With one basis:

- `b1 = +1 * i1`

then:

- `B = [[1]]`

If we buy `3` contracts through standard basis:

- `w = 3`
- `r = 0`
- `dq = 3`

If the actual trade delta is `2.5` contracts due to reconciliation:

- `w = 2`
- `r = 0.5`
- `dq = 2.5`

This is the simplest useful proof of the framework.

### 16.5 Extension note

Multi-instrument examples such as:

- spot/perp basis
- BTC/ETH spread
- XAUT overlay

should be deferred until the second instrument is actually introduced.

---

## 17. Storage Plan

V1 does not need a large schema expansion.

Recommended additions:

- `portfolio_snapshots`
- `portfolio_residuals`
- `portfolio_shadow_log`

`security_exposure_snapshots` can wait until there is more than one active security worth tracking independently.

---

## 18. Deliverables by Milestone

### 18.1 M1 deliverables

- canonical security registry
- canonical instrument registry
- exposure compiler
- unit tests for exposure / notional / delta-PnL consistency

### 18.2 M2 deliverables

- strategy basis registry
- residual ledger
- canonical portfolio state
- adapters from current execution state
- portfolio snapshot persistence

### 18.3 M3 deliverables

- optimization request compiler
- optimizer stub
- shadow execution comparison
- regression acceptance report

---

## 19. Acceptance Criteria for V1

Before any solver-backed execution path is considered, the following must hold:

1. every supported instrument has deterministic exposure mapping
2. exposure units are explicit and testable
3. notional and delta-PnL implied by exposure match current logic
4. every standard trade can be represented by `B w`
5. every non-standard part is booked into residual `r`
6. portfolio snapshots can be produced without changing live execution behavior
7. optimizer stub shadow output differs from current `strategy_runner` by less than `1%`

If these are not true, adding LP/MIP would only formalize weak bookkeeping.

---

## 20. Critical Risks

### 20.1 Security definitions too coarse

If `Security` becomes just an asset name, hidden risk will accumulate.

### 20.2 Unit inconsistency

If contracts, BTC quantity, and USD notional are mixed without explicit conversions, PnL logic will silently drift.

### 20.3 Execution-state leakage

If canonical portfolio state directly mutates or replaces execution state structs, the algebra layer will become unstable.

### 20.4 Residual invisibility

If residual is recorded nowhere visible, the standard-first model becomes meaningless.

### 20.5 Solver-first temptation

If the team introduces optimization before exposure and residual bookkeeping are trusted, the framework will be mathematically neat but operationally unsafe.

---

## 21. What Comes After V1

Only after V1 passes should the project consider:

- a second instrument
- multi-column `B`
- composite expansion
- residual constraints
- LP / MIP solver
- execution-path replacement

That order matters.

---

## 22. Bottom Line

The best next step is not a solver.

The best next step is a deployable TypeScript portfolio algebra V1 that:

- models one real instrument correctly
- proves exposure consistency
- logs `dq = B w + r`
- runs in shadow beside the current bot
- gives the system a safe base for future expansion
