# Portfolio Carry Model Note

> Scope: define how CryptoBot should model funding, borrow interest, and related carry flows
> Status: implementation-oriented design note
> Audience: human reviewers and coding agents extending the portfolio algebra framework

---

## 1. Purpose

The current V1 portfolio algebra layer gives us:

- instrument positions
- stock-like security exposures
- basis decomposition
- residual bookkeeping

That is necessary but not sufficient for carry strategies.

Carry strategies such as:

- perp funding capture
- spot/perp basis carry
- margin borrow arbitrage
- staking-enhanced delta-neutral packages

need a second model family:

- not only what position is held
- but what cashflow accrues while it is held

This note defines that model.

---

## 2. Core Design Principle

The most important modeling rule is:

- do not collapse stock exposures and carry flows into one object

The correct separation is:

- `q_t`
  - instrument positions
- `s_t = E q_t`
  - stock-like risk exposures
- `c_t`
  - carry state and carry cashflow state

This is not optional.

If carry is stuffed into the same bucket as delta exposure, future models will confuse:

- mark-to-market PnL
- funding settlement
- borrow interest
- fees
- inventory drift

and the system will become much harder to extend safely.

---

## 3. Economic Decomposition

For a short-horizon strategy, the total economic result should be read as:

```text
TotalPnL
  ≈ MarkToMarketPnL
  + CarryPnL
  - TradingFees
  - Slippage
  - OtherExecutionCosts
```

Where:

- `MarkToMarketPnL`
  - comes from price moves and basis moves
- `CarryPnL`
  - comes from holding the package across time
- `TradingFees`
  - come from entering and exiting
- `Slippage`
  - comes from imperfect execution

Carry is therefore a time-based cashflow component, not just another mark risk.

---

## 4. Stock vs Flow

This distinction should remain explicit in all later code.

### 4.1 Stock-like objects

Examples:

- BTC delta exposure
- USDT cash balance
- current perp position
- current spot inventory

These are state variables at time `t`.

### 4.2 Flow-like objects

Examples:

- perp funding paid or received at settlement
- borrow interest accruing over time
- staking yield accruing over time
- fee rebates

These are cashflow variables over an interval `[t0, t1]`.

The model should not pretend these are the same kind of quantity.

---

## 5. Carry Categories

The carry model should treat the following as first-class categories.

### 5.1 Funding

Examples:

- BTC perpetual funding on OKX
- ETH perpetual funding on OKX

Properties:

- event-based or interval-based
- usually settles at discrete times
- sign depends on long/short direction and exchange rule

### 5.2 Borrow interest

Examples:

- BTC spot borrow
- USDT margin borrow

Properties:

- generally accrues over time
- may be quoted as hourly or daily or annualized rate
- depends on borrowed asset and borrow notional

### 5.3 Lending / staking yield

Examples:

- Simple Earn style passive yield
- staking reward embedded in a carry package

Properties:

- usually accrues over time
- may have lockup or delayed credit rules

### 5.4 Fee rebate

Examples:

- maker rebate
- incentive credit

Properties:

- transaction-linked
- not inventory-linked in the same way as funding/interest

---

## 6. Continuous vs Discrete Carry

Carry should be separated by accrual mechanics.

### 6.1 Continuous or near-continuous accrual

Typical examples:

- borrow interest
- lending yield
- staking yield

First-order model:

```text
Carry ≈ Notional * Rate * YearFraction
```

If the rate is annualized:

```text
Carry ≈ Notional * r_annual * DeltaT / YearLength
```

This is the right first approximation for borrow/lend style flows.

### 6.2 Discrete settlement accrual

Typical example:

- perp funding

First-order model:

```text
FundingCashflow_k = PositionNotional_k * FundingRate_k
```

If the horizon includes multiple settlement times:

```text
TotalFunding = sum over settlement events k of FundingCashflow_k
```

This is not well modeled as a smooth continuous drift.

It is fundamentally event-driven.

---

## 7. Suggested State Objects

The carry model should not be packed into `PortfolioState` immediately.

For clarity, treat it as a parallel model family first.

### 7.1 CarryLeg

This is the atomic unit of carry semantics.

Suggested shape:

```ts
export interface CarryLeg {
  readonly carryLegId: string;
  readonly instrumentId: InstrumentId;
  readonly carryType: "funding" | "borrow_interest" | "lending_yield" | "staking_yield" | "fee_rebate";
  readonly accrualType: "continuous" | "discrete";
  readonly settlementAsset: string;
  readonly rateSource: string;
  readonly quantityReference: "instrument_contracts" | "btc_notional" | "usd_notional" | "cash_balance";
  readonly signRule:
    | "long_pays_positive_rate"
    | "short_pays_positive_rate"
    | "borrower_pays_positive_rate"
    | "holder_receives_positive_rate";
  readonly eventFrequency?: string;
  readonly active: boolean;
}
```

Interpretation:

- a carry leg says how one tradable instrument produces one type of carry flow

### 7.2 CarrySnapshot

This is current observed carry-relevant state.

Suggested shape:

```ts
export interface CarrySnapshot {
  readonly asOfMs: number;
  readonly carryLegId: string;
  readonly currentRate: number | null;
  readonly nextSettlementMs: number | null;
  readonly lastSettlementMs: number | null;
  readonly accruedRealizedAmount: number | null;
  readonly settlementAsset: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
```

Interpretation:

- snapshot answers what the market/exchange is currently telling us about one carry source

### 7.3 CarryForecast

This is decision-oriented, not accounting truth.

Suggested shape:

```ts
export interface CarryForecast {
  readonly asOfMs: number;
  readonly horizonMs: number;
  readonly carryLegId: string;
  readonly expectedAmount: number;
  readonly pessimisticAmount?: number | null;
  readonly optimisticAmount?: number | null;
  readonly settlementAsset: string;
  readonly assumptions: Readonly<Record<string, string | number | boolean>>;
}
```

Interpretation:

- forecast is used for entry/exit logic
- forecast is not a replacement for realized accounting

---

## 8. Realized vs Expected Carry

This separation must be explicit.

### 8.1 Realized carry

Meaning:

- exchange-accounted cashflow that already happened

Examples:

- funding credited at 04:00
- borrow interest debited over the last hour
- staking reward credited yesterday

This belongs in:

- ledger
- reconciliation
- PnL attribution

### 8.2 Expected carry

Meaning:

- strategy-side estimate over a future horizon

Examples:

- expected BTC perp funding over the next settlement event
- expected borrow cost if a short spot hedge is opened for 20 minutes

This belongs in:

- opportunity ranking
- trade gating
- sizing

These two should never be merged into one field.

---

## 9. Funding Model Setup

This is the most important special case for near-term work.

### 9.1 Funding event model

Each funding-capable instrument should have:

- current estimated funding rate
- next settlement timestamp
- settlement cadence
- sign convention

For example:

- `BTC-USDT-SWAP`
- funding every fixed interval
- if rate is positive, longs pay shorts

### 9.2 Funding horizon rule

For a forecast horizon `H`, the model should determine:

- whether the package is likely to cross zero, one, or multiple funding events

If the horizon misses settlement, expected funding should be zero or near zero.

This seems obvious, but it is exactly where many naive models go wrong.

### 9.3 Funding forecast first-order formula

For one settlement event:

```text
ExpectedFunding
  ≈ EligibleNotional * ExpectedFundingRate * EligibilityFactor
```

Where:

- `EligibleNotional`
  - the notional that actually participates in funding settlement
- `ExpectedFundingRate`
  - current best estimate of the rate applied at settlement
- `EligibilityFactor`
  - probability or deterministic factor reflecting whether the package will still qualify

The first implementation can simplify this to:

```text
EligibilityFactor = 1
```

if the strategy logic ensures the position is held cleanly across settlement.

---

## 10. Borrow Interest Model Setup

Borrow cost should be forecast separately from funding.

### 10.1 First-order formula

For a borrowed notional over a horizon `H`:

```text
ExpectedBorrowCost
  ≈ BorrowNotional * BorrowRate * YearFraction(H)
```

Depending on venue conventions, `BorrowNotional` may be:

- BTC quantity
- USDT cash value
- margin loan principal

### 10.2 Why this matters

This is especially important for reverse funding trades such as:

- long perp
- short spot via margin borrow

Without explicit borrow cost, the strategy may appear profitable when it is not.

---

## 11. Recommended Carry Objective

The first useful decision metric is not a full optimizer.

It is a net-carry edge filter.

Suggested first-order form:

```text
NetCarryEdge(q, H)
  = ExpectedFunding(q, H)
  + ExpectedLendingYield(q, H)
  + ExpectedStakingYield(q, H)
  - ExpectedBorrowCost(q, H)
  - ExpectedFees(q)
  - ExpectedSlippage(q)
  - ExpectedBasisRiskBuffer(q, H)
```

Only enter when:

```text
NetCarryEdge(q, H) > SafetyBuffer
```

This should be treated as:

- simple
- transparent
- easy to shadow-test

before any solver-backed generalization.

---

## 12. Funding Arbitrage: First Recommended Direction

The first implementation should favor the cleaner side of the trade.

### 12.1 Preferred first direction

When funding is significantly positive and longs are expected to pay shorts:

- long spot
- short perp

Reasons:

- easier economic interpretation
- no need to short spot through borrowed BTC in the basic form
- lower modeling complexity than the reverse direction

### 12.2 Defer the reverse side

The reverse package:

- long perp
- short spot via borrow

should be deferred until the carry model already handles:

- borrow availability
- borrow rate forecasting
- margin accounting

This is the correct order of implementation.

---

## 13. Strategy Basis Extension

The carry model should plug into the existing portfolio algebra, not replace it.

Once spot and perp are both introduced, a carry package basis can be represented as:

```text
                [ +1 ]
b_funding  =    [    ]
                [ -1 ]
```

in BTC-equivalent notional units.

Then a package trade can still be written in the canonical form:

```text
dq = B w + r
```

Where:

- `B w`
  - standard funding-carry package size
- `r`
  - residual mismatch, such as:
    - minimum lot mismatch
    - one-leg partial fill
    - emergency unwind drift
    - reconciliation drift

This is the right place for carry to meet algebra.

---

## 14. Suggested Implementation Phases

Do not try to land all carry features at once.

### Phase C1: Carry registry and snapshot semantics

Build:

- carry leg definitions
- carry snapshot contracts
- persistence for observed funding and borrow state

Do not:

- change trade execution logic yet

### Phase C2: Forecast compiler

Build:

- `forecastFunding()`
- `forecastBorrowCost()`
- simple `NetCarryEdge()`

Do not:

- add automatic execution yet

### Phase C3: Funding arbitrage package spec

Build:

- one delta-neutral funding package
- one decision gate
- one bounded exit policy

Do this first in:

- shadow mode

### Phase C4: Portfolio integration

Add:

- second instrument registry entries
- second basis column for funding package
- carry-aware dashboard/reporting

Only later:

- execution replacement
- generalized carry optimizer

---

## 15. Reporting Requirements

Carry strategies will be impossible to trust without clear attribution.

At minimum, later reporting should separate:

- realized funding
- realized borrow interest
- realized trading fees
- realized slippage estimate
- mark-to-market PnL
- carry forecast at entry
- actual carry captured

This is mandatory for strategy review.

---

## 16. What Must Not Happen

The following are design failures:

1. Funding is stored only as an unstructured metadata string
2. Borrow interest is hidden inside generic PnL
3. Carry forecast and realized carry share the same field
4. Funding strategy is implemented before borrow/funding sign semantics are explicit
5. Delta-neutral strategy logic is hard-coded directly into the account adapter
6. Exchange-specific quirks are baked into the core algebra instead of the carry/execution layer

If any of these happen, the model will become brittle very quickly.

---

## 17. Recommended Immediate Next Step

The next code-oriented deliverable should be a funding strategy specification that assumes:

- two instruments:
  - BTC spot
  - BTC perp
- one carry basis package
- one carry forecast model
- one simple execution policy
- one shadow-first validation plan

That should be the first strategy-level use of the broader framework.

---

## 18. Bottom Line

Carry should become a first-class model beside exposure, not a patch on top of exposure.

The correct structure is:

- algebra for positions and exposures
- carry model for time-based cashflows
- execution controller for multi-leg order handling
- account risk envelope for aggregate delta supervision

That gives CryptoBot the right foundation for:

- funding arbitrage
- basis carry
- borrow-driven spread trades
- later multi-asset carry packages

without losing transparency.
