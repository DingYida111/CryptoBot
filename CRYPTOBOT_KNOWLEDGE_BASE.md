# CryptoBot Knowledge Base

This document is the canonical high-level map of the `CryptoBot` codebase.

It is written for both:

- humans who need a compact architecture overview
- Agents that need stable concept definitions before making code changes

It does not replace the strategy-specific or math-specific documents. It sits above them and tells the reader how the pieces fit together.

## 1. What CryptoBot Is

`CryptoBot` is a TypeScript trading system with three overlapping responsibilities:

1. collect market and signal data
2. run local or exchange-managed strategies
3. maintain an increasingly structured portfolio algebra layer so all trades can be explained in a common mathematical language

Today, the project is not a single-strategy bot anymore. It is a strategy runtime plus a portfolio accounting foundation.

## 2. Core Design Principle

The project is moving toward one unifying rule:

> all standard trades should be explainable as strategy basis exposure, and all non-standard leftovers should be recorded explicitly as controlled residuals

In practice this means:

- execution logic may differ by strategy
- storage and accounting should converge
- every important action should eventually produce a comparable decision trace

## 3. Canonical Ontology

These terms are the most important shared vocabulary in the repo.

### 3.1 Instrument

An `instrument` is a tradable object.

Examples:

- `OKX:BTC-USDT`
- `OKX:BTC-USDT-SWAP`

Properties:

- venue-specific
- directly tradable
- has lot size, step size, and quantity unit
- maps to one or more `security` exposures

Code:

- `src/portfolio/instrument_spec.ts`
- `InstrumentSpec`

### 3.2 Security

A `security` is the smallest exposure unit that the portfolio algebra wants to track.

Examples in current V1:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`

Properties:

- not necessarily directly tradable
- used for algebra, constraints, and risk accounting
- one instrument can load multiple securities

Code:

- `src/portfolio/security_spec.ts`
- `SecuritySpec`

### 3.3 Basis

A `basis` is a standard strategy direction expressed as a fixed linear combination of instruments.

Current active examples:

- `basis:long_btc_swap`
- `basis:btc_funding_carry_package`

Interpretation:

- basis is not a trading signal
- basis is a canonical executable direction
- it is the bridge between raw instrument trades and structured strategy algebra

Code:

- `src/portfolio/basis.ts`
- `StrategyBasisSpec`

### 3.4 Strategy

A `strategy` is a runtime policy that decides when and why to trade.

Examples:

- local directional strategy in `strategy_runner`
- local CHOP grid
- local funding arbitrage
- OKX contract grid

Important distinction:

- basis answers: “what standard position direction is this?”
- strategy answers: “when do we choose to enter, hold, or exit?”

### 3.5 Residual

A `residual` is any position increment that cannot be fully explained by the chosen standard basis representation.

Examples:

- partial fills
- rounding mismatch
- fee drift
- temporary execution asymmetry

Residuals are not noise to ignore. They are first-class accounting rows.

Code:

- `src/portfolio/residual.ts`
- `ResidualPosition`
- `ResidualLedgerSummary`

### 3.6 Portfolio State

`PortfolioState` is the canonical structured snapshot of the bot’s portfolio at a timestamp.

It includes:

- instrument positions
- security exposures
- cash balances
- residual ledger
- residual summary
- strategy/runtime metadata

Code:

- `src/portfolio/portfolio_state.ts`
- `PortfolioState`

### 3.7 Decision Intent

`DecisionIntent` is the single-leg action object used by the existing optimizer stub and directional runtime.

Examples:

- `open_long`
- `close_short`
- `grid_seed`
- `grid_hold`

It is currently most natural for single-instrument strategies.

Code:

- `src/portfolio/decision_intent.ts`
- `src/portfolio/optimizer_stub.ts`

### 3.8 Trade Ledger

`TradeLedgerEntry` explains one instrument trade as:

- basis component
- residual component

This is the single-leg identity:

`dq = basis_dq + residual_dq`

### 3.9 Trade Package Ledger

`TradePackageLedger` explains a multi-leg package trade.

This is the natural accounting object for funding arbitrage and, later, spread or stat-arb packages.

Current use:

- funding carry entry
- funding carry unwind

### 3.10 Runtime Decision Trace

`RuntimeDecisionTrace` is the newest common comparison artifact.

It packages:

- `portfolioState`
- `optimizationRequest`
- actual decision
- shadow decision
- diff summary

Its purpose is to compare runtime behavior without yet replacing the live execution path.

Code:

- `src/portfolio/decision_trace.ts`

### 3.11 Runtime Message

`RuntimeTraceMessage` is the operational message derived from trace alerts or normal trace health.

Message categories:

- `major_error`: future global halt / flatten-all class
- `instrument_error`: future per-instrument pause / flatten class
- `warning`: abnormal but non-blocking condition
- `info`: normal operational event

Current behavior:

- `warning`, `instrument_error`, and `major_error` messages can be persisted to `runtime_messages`
- `info` persistence is opt-in to avoid turning normal trace health into database noise
- `notify=true` messages can be sent to console or webhook
- no category currently pauses trading or flattens positions automatically

Code:

- `src/portfolio/decision_trace_report.ts`
- `src/runtime/runtime_trace_observer.ts`
- `src/runtime/runtime_notifications.ts`

## 4. Current Architectural Layers

### 4.1 Data Collection Layer

Purpose:

- ingest market data and signal data
- write raw observations into SQLite

Main area:

- `src/monitor`

Examples:

- Polymarket signal collection
- OKX ticker, funding, and instrument metadata queries

### 4.2 Signal / Strategy Logic Layer

Purpose:

- compute trade opportunities
- decide regime or carry eligibility

Main areas:

- `src/strategy`
- `src/carry`
- parts of `src/trade/strategy_runner.ts`

### 4.3 Execution Layer

Purpose:

- place, close, and manage orders
- synchronize with exchange positions

Main area:

- `src/trade`

Examples:

- OKX trade helpers
- directional execution
- CHOP grid control

### 4.4 Managed Runtime Layer

Purpose:

- expose a uniform control plane for heterogeneous strategies

Main area:

- `src/runtime`

Core abstractions:

- `ManagedStrategyDefinition`
- `ManagedStrategyController`
- `start / sync / stop`

This layer is the strategy lifecycle surface.

### 4.5 Portfolio Algebra Layer

Purpose:

- turn strategy behavior into structured exposures and comparable accounting artifacts

Main area:

- `src/portfolio`

This layer should remain mostly pure and side-effect-light.

It should not own exchange connectivity or order placement.

### 4.6 Observe-Only Runtime Trace Observer

Purpose:

- scan persisted decision traces
- summarize trace health
- persist classified runtime messages
- optionally notify `notify=true` messages

Main area:

- `src/runtime/runtime_trace_observer.ts`
- `src/runtime/runtime_notifications.ts`

Important boundary:

- this layer is observe-only today
- it does not pause strategies
- it does not flatten positions
- it does not change execution paths

## 5. Current Strategy Families

### 5.1 Local Directional + CHOP Grid

Primary file:

- `src/trade/strategy_runner.ts`

Behavior:

- consumes Polymarket-derived regime and directional signals
- opens BTC perp directional trades
- runs inventory-style CHOP grid behavior in range/chop regimes
- writes shadow comparison artifacts

Current accounting style:

- single-instrument intent
- single-leg trade ledger
- actual vs shadow decision trace

### 5.2 Local Funding Arbitrage

Primary file:

- `src/runtime/local_funding_arbitrage_controller.ts`

Behavior:

- detects near-settlement funding capture opportunities
- enters long BTC spot + short BTC perp carry package
- exits after settlement, max hold, or hedge break

Current accounting style:

- package ledger
- residual logging for asymmetric execution
- snapshot-level actual vs shadow decision trace

### 5.3 OKX Managed Strategies

Examples:

- contract grid
- future martingale/DCA family

These are runtime-managed but exchange-executed.

Important distinction:

- local strategies own execution logic
- OKX managed strategies own lifecycle orchestration and normalization

## 6. Canonical Data Surfaces

These are the most important persistence surfaces.

### 6.1 Strategy Runtime Tables

- `managed_strategy_runs`
- `managed_strategy_snapshots`
- `managed_strategy_sub_orders`
- `managed_strategy_positions`

Use:

- lifecycle and dashboard state
- normalized view over local and managed strategies

### 6.2 Portfolio Algebra Tables

- `portfolio_snapshots`
- `portfolio_shadow_log`
- `portfolio_residuals`
- `runtime_messages`

Use:

- exposure snapshots
- actual vs shadow comparison
- residual accounting
- classified runtime messages and notify decisions

### 6.3 Funding Arbitrage Tables

- `funding_arb_opportunities`
- `funding_arb_events`

Use:

- pre-trade carry evaluation
- package lifecycle audit trail

## 7. Canonical Reports and Diagnostics

### 7.1 Portfolio Shadow

Command:

```bash
npm run report:portfolio-shadow -- 50
```

Use:

- compare `strategy_runner` actual vs shadow decisions
- inspect route mismatches and residual behavior

### 7.2 Funding Arbitrage Report

Command:

```bash
npm run report:funding-arb -- 20
```

Use:

- inspect recent carry opportunities
- inspect entry/unwind events
- inspect package consistency and decision trace diff

### 7.3 Runtime Trace Report

Command:

```bash
npm run report:runtime-traces -- 50
```

Use:

- read `RuntimeDecisionTrace` from `portfolio_shadow_log` and `portfolio_snapshots`
- produce trace summary, health, verdicts, messages, and notify candidates
- optionally persist runtime messages:

```bash
npm run report:runtime-traces -- 50 --persist-messages
```

- include normal `info` messages only when explicitly requested:

```bash
npm run report:runtime-traces -- 50 --persist-messages --persist-info
```

- optionally dry-run notification:

```bash
npm run report:runtime-traces -- 50 --notify-dry-run
```

### 7.4 Runtime Message Self Tests

Commands:

```bash
npm run run:runtime-message-self-test -- --persist-messages --notify-dry-run
npm run run:runtime-trace-fixture
```

Use:

- validate runtime message persistence
- validate notification dry-run behavior
- validate observe-only trace report path without placing orders

## 8. Current Algebra Scope

The current algebra scope is intentionally narrow.

Active instrument set:

- `OKX:BTC-USDT`
- `OKX:BTC-USDT-SWAP`

Active security set:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`

Active basis set:

- one-direction BTC swap basis
- one funding carry package basis

This is deliberate. The project is choosing correctness of units and accounting semantics before expanding breadth.

## 9. What Is Already True Today

These statements should now be treated as true in the codebase.

1. `PortfolioState` is the canonical structured portfolio snapshot.
2. Residuals are explicit, summarized, and persisted.
3. Funding carry is no longer an unstructured special case; it has a package ledger.
4. `strategy_runner` and funding arbitrage now both produce runtime decision traces.
5. The system is moving toward shadow-first replacement, not a big-bang refactor.
6. Runtime trace summaries, health verdicts, classified messages, and observe-only notifications exist.
7. Supervisor can run the runtime trace observer after sync when explicitly enabled.

## 10. What Is Not True Yet

These statements should not be assumed by humans or Agents.

1. There is not yet a real LP/MIP solver in the execution path.
2. There is not yet one universal optimizer serving every strategy.
3. `portfolio_shadow_log` is still mainly single-leg oriented.
4. Multi-asset and synthetic spread algebra are not fully implemented.
5. Runtime trace alerting exists, but automatic execution gating is not active.
6. `major_error` and `instrument_error` do not yet trigger automatic flattening or pausing.
7. Real funding-arbitrage shadow trace validation currently depends on OKX connectivity and credentials; local fixture validation is available when OKX is unreachable.

## 11. Safe Extension Rules

When extending the project, prefer these rules.

1. Add a new `instrument` before inventing strategy-specific ad hoc fields.
2. Add a new `security` only when it has stable semantic meaning across strategies.
3. Add a new `basis` when a trade pattern is standard and reusable.
4. Record unexplained increments as residuals instead of silently forcing them into a basis.
5. Keep portfolio algebra pure; keep side effects in runtime or trade modules.
6. Add shadow comparison before replacing production behavior.

## 12. Recommended Reading Order

For a new human or Agent, this is the shortest path to correct context.

1. `CRYPTOBOT_KNOWLEDGE_BASE.md`
2. `README.md`
3. `STRATEGY_RUNTIME_ARCHITECTURE.md`
4. `PORTFOLIO_ALGEBRA_FOUNDATION.md`
5. `PORTFOLIO_ALGEBRA_V1_MATH_NOTE.md`
6. `FUNDING_ARBITRAGE_STRATEGY_SPEC.md`
7. `FUNDING_ARBITRAGE_V1_RUNBOOK.md`

## 13. Current Code Landmarks

If an Agent needs to modify behavior, these are the first places to inspect.

- `src/trade/strategy_runner.ts`
- `src/runtime/local_funding_arbitrage_controller.ts`
- `src/runtime/managed_strategies.ts`
- `src/monitor/storage.ts`
- `src/portfolio/portfolio_types.ts`
- `src/portfolio/basis.ts`
- `src/portfolio/decision_trace.ts`
- `src/portfolio/decision_trace_report.ts`
- `src/runtime/runtime_trace_observer.ts`
- `src/runtime/runtime_notifications.ts`
- `src/portfolio/optimizer_stub.ts`

## 14. Purpose of This Knowledge Base

This document exists to reduce two common failure modes:

1. local code changes that ignore the algebra direction of the project
2. Agent edits that touch runtime behavior without understanding the ontology

If a new feature does not clearly fit this map, the feature proposal should first answer:

- what is the instrument?
- what are the security exposures?
- is there a reusable basis?
- what is standard and what is residual?
- which runtime layer owns the side effects?
