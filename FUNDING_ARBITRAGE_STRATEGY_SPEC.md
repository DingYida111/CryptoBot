# Funding Arbitrage Strategy Spec

> Scope: first implementable specification for a BTC spot + BTC perpetual funding-capture strategy
> Status: strategy specification for phased implementation
> Audience: human reviewers and coding agents implementing the next strategy family

---

## 1. Strategy Goal

The first carry strategy should target one narrow opportunity:

- capture positive perp funding by holding a delta-neutral or near-delta-neutral package across the next settlement event

The initial package is:

- long BTC spot
- short BTC perpetual

The strategy is intentionally narrow.

It is not trying to solve:

- all funding regimes
- all carry packages
- all execution edge cases
- all assets

The goal is to produce one clean, shadow-testable first implementation that fits the portfolio algebra direction already established.

---

## 2. First-Version Scope

### 2.1 In scope

- one asset:
  - `BTC`
- one venue:
  - `OKX`
- one strategy direction:
  - `long spot + short perp`
- one primary event:
  - next funding settlement
- one simple execution policy:
  - enter before settlement
  - hold across settlement
  - exit quickly after settlement
- shadow-first validation

### 2.2 Explicitly out of scope

- reverse package:
  - `long perp + short spot via borrow`
- multi-asset carry ranking
- smart routing across venues
- full LP/MIP optimization
- dynamic APY term-structure modeling
- complex best execution
- cross-exchange arbitrage

This scope discipline is important.

---

## 3. Economic Thesis

If positive funding means longs pay shorts, then:

- short perp receives funding
- long spot offsets most BTC delta

The expected economic result over one strategy cycle is approximately:

```text
Pi_total
  ≈ FundingReceived
  - BasisMoveLoss
  - EntryFees
  - ExitFees
  - Slippage
  - ExecutionMismatchCost
```

The strategy is therefore:

- not a directional BTC bet
- not a pure risk-free arbitrage
- a short-horizon carry trade on a hedged basis package

---

## 4. Package Definition

### 4.1 Instruments

The first implementation should assume two future portfolio instruments:

- `OKX:BTC-USDT-SPOT`
- `OKX:BTC-USDT-SWAP`

### 4.2 Canonical package basis

In BTC-equivalent units:

```text
                [ +1 ]
b_funding  =    [    ]
                [ -1 ]
```

Interpretation:

- buy one BTC-equivalent spot
- sell one BTC-equivalent perpetual

### 4.3 Canonical decomposition

Package trades should eventually fit the standard algebra:

```text
dq = B w + r
```

Where:

- `B w`
  - standard funding package size
- `r`
  - residual mismatch from:
    - lot-size mismatch
    - partial fill
    - emergency unwind
    - reconciliation drift

---

## 5. Strategy Lifecycle

The strategy should be modeled as a finite-state workflow, not an always-on generic signal loop.

### 5.1 States

Suggested high-level states:

- `idle`
  - no package open
- `await_entry_window`
  - next eligible funding event is known, but entry window has not opened
- `evaluating_entry`
  - entry window opened, compute edge and size
- `entering`
  - placing the two legs
- `holding_for_funding`
  - both legs materially established, waiting for settlement
- `unwinding`
  - funding event passed, closing both legs
- `completed`
  - cycle finished cleanly
- `aborted`
  - strategy skipped or exited because safety conditions failed

### 5.2 Why explicit states matter

This strategy is event-driven.

The operational questions are:

- is the next settlement close enough to matter
- have both legs been established
- has funding settlement passed
- are we still hedged enough to keep holding
- when must we force exit

These are better expressed as states than as scattered boolean flags.

---

## 6. Entry Logic

### 6.1 Entry window

The first implementation should use a configurable entry lead:

```text
t_entry_target = t_funding - entryLeadMs
```

Suggested first range:

- `entryLeadMs` on the order of tens of seconds to a few minutes

The system should not hard-code "enter at 03:59:59".

### 6.2 Entry gate

Only consider entry when all of the following hold:

1. funding event is within entry window
2. expected funding sign matches the package direction
3. order books on both legs have sufficient depth
4. estimated fees and slippage remain below configured limits
5. delta-neutral package size can be formed above minimum useful notional
6. no conflicting package is already open
7. account risk envelope allows the trade

### 6.3 Net-edge rule

Use a transparent deterministic gate:

```text
NetCarryEdge(q, H)
  = ExpectedFunding(q, H)
  - ExpectedFees(q)
  - ExpectedSlippage(q)
  - ExpectedBasisRiskBuffer(q, H)
```

For V1 of this strategy, spot borrow cost is not required because the preferred direction is:

- long spot
- short perp

Only enter if:

```text
NetCarryEdge(q, H) > SafetyBuffer
```

### 6.4 Initial size rule

The first version should not optimize size with a solver.

Use:

```text
q = min(
  maxPackageSize,
  spotDepthLimitedSize,
  perpDepthLimitedSize,
  riskLimitedSize
)
```

Then reject if:

```text
q < minUsefulPackageSize
```

This is enough for V1.

---

## 7. Execution Logic

### 7.1 Execution philosophy

The strategy should use bounded, explicit multi-leg logic.

It should not try to be a universal best-execution engine.

### 7.2 Leg roles

For the first implementation, the spot and perp legs should be tracked separately:

- spot leg
- perp leg

but the strategy should reason about them as one package.

### 7.3 Allowed execution modes

The first version should support only one simple mode:

- taker-biased bounded execution

Meaning:

- we prefer fast package establishment over maker optimization
- but we still impose maximum allowed slippage

This is the right tradeoff for an event-driven carry strategy.

### 7.4 Execution parameters

Suggested first parameters:

- `maxSpotSlippageBps`
- `maxPerpSlippageBps`
- `maxLegMismatchMs`
- `maxEntryDurationMs`
- `maxExitDurationMs`
- `maxRepriceCount`
- `forceFlattenAfterMs`

### 7.5 Leg mismatch handling

If one leg fills and the other does not, the strategy must not quietly continue.

Possible handling:

1. retry missing leg within `maxLegMismatchMs`
2. if still not balanced, reduce or flatten the filled leg
3. mark the event as residual / execution mismatch

This should feed directly into residual bookkeeping later.

---

## 8. Hold Logic

### 8.1 Hold condition

Once both legs are materially in place and the package is sufficiently hedged:

- hold through the targeted funding settlement

### 8.2 Early abort conditions

Abort or force unwind if any of the following occur:

- net delta exceeds configured tolerance
- one leg disappears or is materially reduced unexpectedly
- funding event no longer appears valid
- execution mismatch remains unresolved
- account risk envelope signals reduce-delta-only behavior

### 8.3 Holding horizon

The intended holding horizon is short.

This is not a long-duration basis carry book in V1.

---

## 9. Exit Logic

### 9.1 Exit trigger

After the funding event passes, the base rule is:

- unwind as soon as practical

### 9.2 Exit policy

The first implementation should use:

- bounded taker-biased or aggressively-priced limit exit

It should not attempt sophisticated post-funding alpha capture.

### 9.3 Exit safety

If one leg exits and the other does not:

- retry within a bounded window
- then force flatten if required

The system should prefer:

- small realized slippage

over:

- lingering accidental exposure

---

## 10. Risk Controls

### 10.1 Package-level risk

Suggested first controls:

- `maxPackageSize`
- `minUsefulPackageSize`
- `maxNetDeltaToleranceBtc`
- `maxEntrySlippageBps`
- `maxExitSlippageBps`
- `maxBasisMoveBpsWhileHolding`
- `maxHoldMs`

### 10.2 Account-level risk

Suggested first controls:

- `maxDeltaToEquity`
- `maxCarryExposurePct`
- `maxConcurrentCarryPackages`

These should be enforced outside the pure algebra layer, but based on algebra outputs.

### 10.3 Operational risk

Suggested first controls:

- do not enter if order book snapshots are stale
- do not enter if funding timestamp is ambiguous
- do not enter if either leg cannot be priced confidently
- do not enter if balance or margin fetch fails

---

## 11. Data Requirements

The strategy needs more than price alone.

### 11.1 Market data

- spot bid/ask
- perp bid/ask
- spot depth summary
- perp depth summary
- current basis

### 11.2 Carry data

- current estimated funding rate
- next funding settlement timestamp
- last observed funding rate

### 11.3 Account / execution data

- available cash / margin
- existing spot and perp position
- order fill state per leg
- fee schedule or configured fee assumptions

---

## 12. Runtime Integration

### 12.1 Runtime family

This strategy should eventually live under the existing runtime control plane as a local strategy family.

The current closest placeholder is:

- `local_spread_arbitrage`

The first implementation can either:

1. temporarily use that placeholder type
2. or introduce a more specific type such as:
   - `local_funding_arbitrage`

I recommend the second option once actual implementation begins.

### 12.2 Controller direction

Eventually this should have its own local controller, conceptually similar to:

- `local_funding_arbitrage_controller.ts`

Responsibilities:

- lifecycle state machine
- data polling orchestration
- entry/exit decisioning
- normalized snapshots for persistence

### 12.3 Portfolio-algebra boundary

The controller should:

- read market/account state
- call portfolio/carry computation helpers
- decide whether to enter or exit
- place orders through execution helpers

The controller should not:

- embed portfolio algebra logic inline
- redefine carry formulas ad hoc

---

## 13. Persistence and Observability

This strategy will not be trustworthy without explicit logging and snapshots.

### 13.1 Required logs

- funding rate at decision time
- next settlement timestamp
- expected net carry edge
- chosen package size
- spot leg intended price and fill
- perp leg intended price and fill
- realized timing of entry and exit
- residual mismatch if any

### 13.2 Required snapshots

Over time, later storage should preserve:

- package state
- carry forecast at entry
- realized carry captured
- realized fees
- realized basis move
- realized residual mismatch

---

## 14. Shadow Validation Plan

This strategy should not go live immediately.

### 14.1 Shadow mode first

First run:

- scan funding events
- compute hypothetical entry decision
- compute hypothetical size
- simulate package timing
- estimate expected carry
- record all hypothetical actions

without placing orders

### 14.2 Shadow acceptance criteria

The strategy is ready for controlled paper execution only after:

1. funding event detection is reliable
2. entry-window timing is stable
3. edge filter does not trigger on obviously unprofitable events
4. hypothetical package sizes are operationally realistic
5. logging clearly explains every skipped vs entered event

### 14.3 Paper execution phase

Then move to:

- bounded-size paper trading

Only later:

- larger paper size
- possible production deployment

---

## 15. Suggested Implementation Milestones

### F1: Event scanner

Build:

- funding event tracker
- basis snapshot
- package opportunity evaluator

Output:

- structured opportunity rows

No orders yet.

### F2: Carry forecast integration

Build:

- `ExpectedFunding()`
- `ExpectedFees()`
- `ExpectedSlippage()`
- `NetCarryEdge()`

No orders yet.

### F3: Shadow strategy runner

Build:

- lifecycle state machine
- shadow entry/exit events
- residual-style mismatch logging for hypothetical legging issues

Still no orders.

### F4: Small-size paper execution

Build:

- real two-leg execution
- bounded mismatch handling
- force-flatten rules

### F5: Portfolio integration upgrade

Build:

- spot instrument registry
- funding package basis column
- carry-aware reporting

This should happen in parallel or just before serious scaling.

---

## 16. What Must Not Happen

The following are design mistakes:

1. The strategy enters purely on funding sign, with no cost filter
2. The strategy ignores whether settlement is actually near
3. The strategy ignores package-level delta mismatch after partial fills
4. The strategy keeps holding after settlement waiting for "better exit alpha"
5. Funding and basis PnL are not separated in reporting
6. The implementation bypasses the runtime layer and becomes a one-off script
7. Borrow-dependent reverse trades are enabled before borrow modeling exists

These are exactly the failure modes this spec is trying to prevent.

---

## 17. Recommended Immediate Next Step

The next code-level work should begin with:

- F1 event scanner
- F2 carry forecast integration

not with live order placement.

That preserves the shadow-first discipline already established in the portfolio algebra work.

---

## 18. Bottom Line

The first funding arbitrage strategy should be:

- narrow
- transparent
- two-leg
- event-driven
- carry-aware
- shadow-first

If implemented in that order, it will become the first real strategy family that validates the broader:

- instrument / security / strategy / residual

framework under a genuinely multi-leg use case.
