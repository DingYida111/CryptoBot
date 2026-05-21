# Portfolio Carry and OKX Arbitrage Report

> Scope: compare OKX's official arbitrage stack with the direction of CryptoBot's portfolio algebra framework
> Status: design report, not implementation
> Audience: human reviewers and coding agents preparing the next phase of strategy design

---

## 1. Executive Summary

The most important conclusion from reviewing OKX's current official arbitrage products is:

- OKX does not treat arbitrage as a single "funding bot"
- OKX treats arbitrage as a product stack with multiple layers:
  - opportunity packaging
  - multi-leg execution
  - spread-native trading rails
  - account-level delta-neutral risk management

This is highly relevant for CryptoBot.

It means the right goal for us is not:

- imitate one OKX bot

The right goal is:

- build a transparent and extensible portfolio algebra framework that can support the same class of strategies while keeping strategy logic, execution logic, and risk logic separate

That direction remains correct.

---

## 2. What We Reviewed in OKX's Official Stack

As of this report, the most relevant official OKX materials fall into four buckets:

1. `Arbitrage bot / Arbitrage order`
2. `Smart Arbitrage`
3. `Nitro Spreads`
4. `Delta-Neutral Strategy`

These should not be confused with one another.

They serve different roles in the stack.

---

## 3. OKX Product-by-Product Comparison

### 3.1 Arbitrage bot / Arbitrage order

Official positioning:

- a user-facing arbitrage workflow inside Trading Bots
- supports at least:
  - `Funding rates`
  - `Spreads`

What it implies structurally:

- OKX recognizes funding capture and spread capture as separate arbitrage families
- the platform already exposes a two-leg execution workflow for these strategies

Relevant execution features described by OKX:

- users choose `Funding rates` or `Spreads`
- users set parameters for both legs
- users place `Both legs`
- spread workflows support queueing / surpassed style parameters
- margin mode can be selected

Interpretation for us:

- this layer is best thought of as a multi-leg execution shell
- it is closer to an execution controller than to a research framework

What is useful to borrow:

- explicit two-leg workflow
- parameterization of both legs
- queueing vs crossing style execution controls
- margin-mode awareness

What not to copy directly:

- product-first UX assumptions
- opaque route selection
- account-coupled execution semantics hidden behind UI terms

---

### 3.2 Smart Arbitrage

Official positioning:

- a delta-neutral strategy
- spot long + perpetual short
- intended to profit primarily from funding fees

The important official signals are:

- delta-neutral is the conceptual core
- funding capture is the primary yield source
- expected APY, funding rate, and basis rate are exposed to the user
- OKX now combines staking rewards with smart arbitrage for selected assets
- there is a `Custom Mode` and a `Smart Mode`

Interpretation for us:

- OKX is no longer describing this as "just funding"
- OKX is implicitly describing a broader carry package:
  - funding
  - basis
  - optional staking yield

This aligns strongly with the direction we discussed:

- interest and funding should be modeled as `carry`
- carry should not be treated as a miscellaneous residual

What is useful to borrow:

- clear delta-neutral framing
- carry as a bundled economic concept
- display of APY, current funding, basis

What not to copy directly:

- `Smart Mode` black-box decisioning
- product-level automation without transparent decomposition

---

### 3.3 Nitro Spreads

Official positioning:

- spread trading as a dedicated venue/workflow
- spread tiles and spread orderbooks
- order types such as:
  - `limit`
  - `IOC`
  - `post-only`

The most important structural point is:

- spread is treated as a tradable object, not just two manually synchronized legs

Post-trade behavior also matters:

- futures legs appear as positions
- spot legs appear as assets
- positions can later be unwound through Nitro Spreads or regular books

Interpretation for us:

- this is the cleanest exchange-native analogue to our future `strategy basis` idea
- it shows that one spread package can be represented separately from its settlement legs

What is useful to borrow:

- spread as first-class object
- dedicated price and quantity semantics
- spread-native order types

What not to copy directly:

- venue-specific spread presentation assumptions
- dependence on exchange-owned spread marketplace semantics

---

### 3.4 Delta-Neutral Strategy

Official positioning:

- account-level strategy mode for delta-neutral index arbitrage
- intended for funding-fee and basis capture
- includes specific risk-control rules

The most important features are:

- higher borrowing support for eligible accounts
- hedged positions deprioritized in the ADL queue
- delta-to-equity based restrictions
- account-level strategy type switchable via API

Interpretation for us:

- OKX treats delta-neutral arbitrage as an account-class problem, not only a bot
- this is a separate layer from signal generation and execution

This is very important for our architecture.

It suggests a future separation:

- strategy layer
- execution layer
- portfolio algebra layer
- account risk envelope

What is useful to borrow:

- account-level delta aggregation
- delta-to-equity constraints
- reduce-delta-only safety mode

What not to copy directly:

- venue-specific account restrictions as if they were universal portfolio rules
- hard-coding OKX account semantics into the core algebra layer

---

## 4. What This Means for CryptoBot

The official OKX stack suggests that our own architecture should distinguish at least four layers.

### 4.1 Opportunity scanner

Purpose:

- rank funding or spread opportunities
- estimate expected net carry

Inputs:

- current funding rate
- basis level
- time to settlement
- borrow rates
- depth / fee estimates

Outputs:

- expected carry
- expected costs
- candidate size range
- net edge score

### 4.2 Carry package definition

Purpose:

- define a delta-neutral or near-delta-neutral package in transparent algebraic terms

Example:

- `long BTC spot + short BTC perp`

This should live in the portfolio framework as:

- instruments
- security exposures
- strategy basis weights
- carry model

### 4.3 Multi-leg execution controller

Purpose:

- turn a package decision into actual orders
- minimize legging risk

Features worth supporting later:

- same amount vs same total
- one-leg fallback rules
- maker-first vs taker-first modes
- bounded reprice
- timeout and forced flatten logic

### 4.4 Delta-neutral risk envelope

Purpose:

- supervise aggregate exposure at account level

Future examples:

- net delta
- delta-to-equity
- residual inventory ratio
- carry concentration by asset
- reduce-delta-only restrictions

The important design rule is:

- this risk layer should consume algebra outputs
- it should not replace the algebra layer

---

## 5. Funding Arbitrage Worked Example

This is the most useful concrete example for the next phase.

### 5.1 Trade idea

Suppose the next perp funding settlement is at `04:00`.

At `03:59`, the observed funding rate for BTC perpetual is significantly positive.

If positive funding means longs pay shorts, then the basic funding-capture package is:

- long BTC spot
- short BTC perpetual

The intended economics are:

- collect funding on the short perp leg
- use long spot to offset most BTC directional risk
- exit soon after settlement

This is not pure free carry.

It is better described as:

- a short-horizon carry trade on a delta-hedged basis package

---

### 5.2 Instruments and state

For this example, future extensions would add at least:

- `i1 = BTC spot`
- `i2 = BTC perp`

Position vector:

```text
      [ q_spot ]
q  =  [        ]
      [ q_perp ]
```

with notional scaling chosen so that both are expressed in BTC-equivalent units.

Security set could include:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`
- `BTC_SPOT_BORROW_OKX` or `USDT_MARGIN_BORROW_OKX` later if margin borrowing is needed

---

### 5.3 Delta-neutral basis package

The canonical carry basis for positive funding capture is:

```text
                [ +1 ]
b_funding  =    [    ]
                [ -1 ]
```

Interpretation:

- buy one BTC-equivalent of spot
- sell one BTC-equivalent of perpetual

This is the first example where `basis` becomes economically richer than the current 1D V1 basis.

---

### 5.4 PnL decomposition

Let:

- `S_t`
  - spot price
- `F_t`
  - perp price
- `B_t = F_t - S_t`
  - perp-spot basis
- `q`
  - BTC-equivalent package size
- `f`
  - funding rate applied at settlement
- `P_ref`
  - funding notional reference price

If we hold:

- `+q` spot
- `-q` perp

then price-related PnL from entry `t0` to exit `t2` is:

```text
Pi_hedge = q (S_t2 - S_t0) - q (F_t2 - F_t0)
         = -q [(F_t2 - S_t2) - (F_t0 - S_t0)]
         = -q (B_t2 - B_t0)
```

So the economic result is approximately:

```text
Pi_total
  = FundingCashflow
  + HedgePnL
  - EntryCost
  - ExitCost
  - BorrowCost
  - Slippage
```

or:

```text
Pi_total
  ≈ q * P_ref * f
  - q * (B_t2 - B_t0)
  - C_entry
  - C_exit
  - C_borrow
  - C_slippage
```

This is the right first-order model.

It makes the strategy's true economics explicit:

- you want funding
- you still carry basis risk
- you must beat fees and execution cost

---

### 5.5 Net-edge filter

A simple deterministic trade gate can be written as:

```text
NetEdge(q, H)
  = ExpectedFunding(q, H)
  - ExpectedBasisRisk(q, H)
  - ExpectedFees(q)
  - ExpectedSlippage(q)
  - ExpectedBorrowCost(q, H)
```

Only enter when:

```text
NetEdge(q, H) > SafetyBuffer
```

This is intentionally simple.

It is enough for a first deployable strategy design.

---

### 5.6 Exit policy

The first version should not over-engineer best execution.

A practical exit policy is:

- enter before settlement with a configurable lead time
- hold across the funding event
- exit as soon as practical after settlement using bounded execution logic

Useful parameters:

- `entryLeadMs`
- `maxPostFundingHoldMs`
- `maxRepriceCount`
- `maxLegMismatchMs`
- `forceFlattenAfterMs`

This keeps the package operationally manageable.

---

## 6. Carry Should Be Its Own Model

The strongest design recommendation from this review is:

- do not treat borrow interest and perp funding as miscellaneous metadata
- do not hide them in residual
- do not force them into a static stock-exposure matrix and call the problem solved

The correct distinction is:

- delta and inventory are stock-like state
- funding and borrow interest are flow-like cash accrual
- fees and slippage are transaction flows

So the next conceptual model should separate:

- `q_t`
  - instrument positions
- `s_t = E q_t`
  - stock exposures
- `c_t`
  - carry state and carry cashflow estimates

This will make the framework much cleaner when:

- spot borrow is introduced
- reverse funding trades are introduced
- multi-asset carry packages are introduced

---

## 7. Recommended Data/Model Direction

The next stage should add a carry sub-model beside the current exposure model.

### 7.1 Suggested concepts

- `CarryLeg`
  - a flow source such as perp funding, spot borrow, margin interest, staking reward
- `CarrySnapshot`
  - realized and current carry-relevant state
- `CarryForecast`
  - expected carry over a decision horizon

### 7.2 Suggested separation

- `realizedCarry`
  - accounting truth
- `expectedCarry`
  - decision input

These must not be mixed.

### 7.3 Suggested carry categories

- funding
- borrow interest
- lending yield
- staking yield
- fee rebate

---

## 8. How This Fits the Portfolio Algebra Framework

The framework should continue to use:

```text
dq = B w + r
```

but with a richer basis matrix once multiple instruments are active.

For example, after adding spot and perp:

- one basis column could represent directional perp
- another could represent spot-perp carry package
- residual would capture partial fills, unit mismatch, reconciliation drift, or emergency liquidation

This is exactly the kind of extension the current framework was designed to support.

The portfolio algebra remains the transparent core.

Carry strategy logic becomes a structured client of that core.

---

## 9. What We Should Borrow from OKX

We should borrow:

- the multi-layer view of arbitrage
- the delta-neutral framing
- the explicit presentation of APY, funding, basis
- the emphasis on two-leg execution control
- the account-level delta risk envelope

We should not borrow:

- black-box `Smart Mode` decisioning
- venue-specific product semantics as if they were universal
- UI-first abstractions in place of explicit math

The right synthesis is:

- transparent portfolio algebra from our side
- disciplined multi-leg execution inspired by OKX
- account-level delta controls inspired by OKX

---

## 10. Recommended Next Deliverables

The next useful documents should be:

1. `PORTFOLIO_CARRY_MODEL_NOTE.md`
   - precise carry definitions
   - borrow vs funding vs staking
   - stock vs flow separation

2. `FUNDING_ARBITRAGE_STRATEGY_SPEC.md`
   - first implementation spec for BTC spot + perp funding capture
   - decision thresholds
   - execution rules
   - risk limits

3. a later implementation milestone that adds:
   - second instrument registry entries
   - carry snapshot/forecast compiler
   - new basis column for delta-neutral funding package

---

## 11. Bottom Line

The review confirms that our current direction is still the right one.

OKX's official stack shows that serious arbitrage support naturally decomposes into:

- opportunity discovery
- carry package definition
- multi-leg execution
- account-level risk control

CryptoBot should adopt the same layered view.

But unlike OKX's product stack, our implementation should remain:

- transparent
- algebra-first
- unit-consistent
- shadow-testable

That is the right foundation for future funding, basis, and carry strategies.
