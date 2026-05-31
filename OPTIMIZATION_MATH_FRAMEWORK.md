# CryptoBot Optimization Math Framework

> Canonical math reference for the next portfolio optimizer layer.
> Scope: direction-driven optimization, marketlet execution, risk/cost/expected-value setup, and execution residuals.
> Status: design contract for implementation. This extends the existing portfolio algebra notes without replacing them.

---

## 1. Purpose

CryptoBot now has three related but different concepts:

- `instrument`
  - concrete tradable venue product, e.g. `OKX:BTC-USDT-SWAP`
- `security`
  - risk atom / underlying exposure, e.g. `BTC_DELTA`, `ETH_DELTA`, `BTC_PERP_FUNDING_OKX`
- `basis`
  - approved strategy bookkeeping column, e.g. long one BTC swap contract or a carry package

The optimizer layer adds two more concepts:

- `direction`
  - a signal-bearing exposure vector in security space
- `marketlet`
  - a directly executable market component, usually one instrument leg or a small approved package

This note fixes how these objects relate so future optimizer, risk, execution, and residual code do not drift.

---

## 2. Vector Spaces

### 2.1 Security Space

Security exposure is the canonical risk state.

```text
s in R^n
```

Examples:

```text
BTC_DELTA
ETH_DELTA
USDT_CASH
BTC_PERP_FUNDING_OKX
```

All risk limits ultimately apply to security exposure.

### 2.2 Marketlet Space

Marketlets are executable increments.

```text
x in R^m
```

Examples:

```text
x1 = buy BTC spot
x2 = sell BTC spot
x3 = buy BTC swap contracts
x4 = sell BTC swap contracts
```

The marketlet-to-security exposure matrix is:

```text
M in R^(n x m)
```

So an executable marketlet increment changes security exposure by:

```text
ds_exec = M x
```

Marketlet execution should use bid/offer side variables when computing cost:

```text
x = x_bid - x_ofr
x_bid >= 0
x_ofr >= 0
```

Side-specific trading cost is then:

```text
TC(x) = c_bid^T x_bid + c_ofr^T x_ofr
```

This is preferable to `cost * |x|` once bid and offer prices differ.

### 2.3 Direction Space

Directions are signal-bearing exposures.

```text
z in R^k
```

Each direction column is a security-space vector.

```text
D in R^(n x k)
```

So a direction position changes security exposure by:

```text
ds_direction = D z
```

Example:

```text
d1 = +1 * BTC_DELTA - 40 * ETH_DELTA
```

The numeric coefficients must be explicitly normalized. Raw asset quantities are not automatically comparable.

For pricing and PnL, use bid/offer side variables instead of relying only on a
single signed direction variable:

```text
z = z_bid - z_ofr
z_bid >= 0
z_ofr >= 0
```

`z_bid` expresses buying / bidding for the direction. `z_ofr` expresses selling /
offering the direction. This keeps side-specific expected value linear:

```text
EV(z) = v_bid^T z_bid + v_ofr^T z_ofr
```

where `v_bid` and `v_ofr` can come from different bid/ofr prices.

---

## 3. Core Invariant

Every standard trade must be explainable by an approved direction.

The core constraint is:

```text
M x = D z
```

Equivalently, with current security exposure `s0`:

```text
s_next = s0 + M x
s_target = s0 + D z
require s_next = s_target
```

If no direction is active:

```text
z = 0
```

then the standard optimizer should not create new security exposure:

```text
M x = 0
```

In practice:

- if `z = 0`, normal directional trading returns hold
- any nonzero marketlet that cannot be explained by active directions must become residual or be rejected

---

## 4. Objective

The direction layer owns expected value.

The execution layer owns cost.

Risk is measured on resulting security exposure.

Canonical objective:

```text
maximize over z_bid, z_ofr, x_bid, x_ofr:

    v_bid^T z_bid
  + v_ofr^T z_ofr
  - c_bid^T x_bid
  - c_ofr^T x_ofr
  - lambda * Risk(s0 + D (z_bid - z_ofr))
```

subject to:

```text
M (x_bid - x_ofr) = D (z_bid - z_ofr)
securityLower <= s0 + D (z_bid - z_ofr) <= securityUpper
directionLower <= z_bid - z_ofr <= directionUpper
marketletLower <= x_bid - x_ofr <= marketletUpper
turnover(x_bid + x_ofr) <= maxTurnover
z_bid, z_ofr, x_bid, x_ofr >= 0
```

### 4.1 Expected Value

`EV(z)` must be calibrated into economic units.

Preferred unit:

```text
expected USDT PnL per direction unit over horizon H
```

Raw signals are not expected value.

Correct pipeline:

```text
raw signal
  -> ExpectedValueEstimate
  -> direction alpha
  -> optimizer
```

If expected value is not available:

```text
alpha = 0
```

and the optimizer should not create new directional exposure.

### 4.2 Transaction Cost

`TC(x)` depends on marketlet increments, not final direction exposure.

Common approximation:

```text
TC(x) = fee^T |x| + slippage^T |x| + impact^T (x o x)
```

When bid/ofr prices are available, prefer the side-split linear form:

```text
TC(x) = c_bid^T x_bid + c_ofr^T x_ofr
```

For the first implementation:

- fees and slippage can be estimated from current bid/ask and exchange fee config
- market impact can be zero or conservative buffer
- all values should be in the same PnL unit as `EV`

### 4.3 Risk

Risk belongs in security or direction space, not raw marketlet space.

Classic form:

```text
Risk(s) = s^T A s
```

where:

- `A` is symmetric positive semidefinite
- entries can come from covariance, correlation, or a conservative diagonal proxy
- horizon must match expected-value horizon

If `A` is noisy:

```text
A = (A + A^T) / 2
A = A + epsilon * I
```

---

## 5. Direction Example

Suppose we define:

```text
d1 = +1 * BTC_DELTA - 40 * ETH_DELTA
```

and a signal says:

```text
bid threshold = -20
offer threshold = 30
```

Then direction logic can produce:

```text
z1 > 0
```

when the spread is cheap, or:

```text
z1 < 0
```

when the spread is rich.

The optimizer does not directly buy BTC or sell ETH because "BTC moved".

It trades marketlets only to express `d1`.

---

## 6. Marketlet Execution

The optimizer first solves a continuous problem:

```text
x*
```

The execution layer then quantizes:

```text
x_exec = quantize(x*, lotSize, minTradeSize, tickSize)
```

The difference is execution residual:

```text
r_exec = x* - x_exec
```

Current policy:

- round quantities toward zero by default
- do not overtrade a target just to satisfy lot size
- store residual in the portfolio residual ledger

### 6.1 Package-Aware Rounding

For single-leg trades, instrument-wise rounding is acceptable.

For multi-leg directions/packages, independent rounding can break the direction ratio.

Example:

```text
continuous target:
  spot = +0.038 BTC
  swap = -3.8 contracts

independent quantization:
  spot = +0.038 BTC
  swap = -3 contracts
```

This no longer expresses the exact intended carry package.

Therefore multi-leg execution needs package-aware quantization:

```text
round direction/package weight first
then expand to marketlet legs
```

This is a required next step before live optimizer execution.

---

## 7. Residual Policy

Residual is not a mathematical failure by itself.

Residual means:

- the system understands a mismatch exists
- the mismatch is explicitly labeled
- later health checks can decide whether it is acceptable

Residual categories include:

- `LOT_ROUNDING`
- `PARTIAL_FILL`
- `FEE_DRIFT`
- `FUNDING_DRIFT`
- `STATE_RECONCILIATION`
- `UNROUTED_DECISION`

Rules:

1. Standard optimizer output must prefer direction-explainable trades.
2. Execution quantization may create residual.
3. Residual must never silently become new intended exposure.
4. Residual budgets should be monitored before live execution.

---

## 8. Constraints

Constraints live at different layers.

### 8.1 Direction Constraints

```text
directionLower <= z <= directionUpper
```

Examples:

- maximum spread size
- confidence-scaled maximum direction weight
- no trade unless expected value clears cost

Every `DirectionSpec` must carry finite default `lowerBound` and `upperBound`.
Direction compilers clamp requested weights to these bounds before producing
security exposure. If a direction is genuinely profitable and the operator wants
to keep trading, the correct action is to explicitly raise the configured bound
or add a more specific constraint, not to let the optimizer infer unlimited size.

### 8.2 Security Constraints

```text
securityLower <= s0 + D z <= securityUpper
```

Examples:

- max BTC delta
- max ETH delta
- max funding sensitivity
- max cash or margin usage

### 8.3 Marketlet Constraints

```text
marketletLower <= x <= marketletUpper
```

Examples:

- max order size
- max position per instrument
- reduce-only mode
- venue-specific tradability

Every `MarketletSpec` must also carry finite default `lowerBound` and
`upperBound`. Marketlet compilers clamp requested execution weights before
producing security exposure. If marketlet clamping breaks `M x = D z`, the
compiled route must show a nonzero residual rather than silently expanding
another leg.

### 8.4 Margin / Liquidation Constraints

These should be evaluated as portfolio safety checks, not embedded too early as exact QP constraints.

Recommended first pass:

```text
equity_after_scenario - maintenance_margin_after_scenario >= buffer
```

or:

```text
liquidationDistance >= minDistance
```

---

## 9. Implementation Layers

Recommended file concepts:

```text
src/portfolio/direction.ts
  DirectionSpec
  DirectionState
  DirectionExposure

src/portfolio/marketlet.ts
  MarketletSpec
  compileMarketletExposureMatrix()

src/portfolio/optimizer_v1.ts
  continuous basis/direction target selection

src/portfolio/execution.ts
  quantization
  residual ledger generation
```

The existing `basis.ts` remains valid.

Relationship:

- `basis`
  - bookkeeping / approved standard strategy column
- `direction`
  - signal-bearing risk expression
- `marketlet`
  - executable leg

Do not collapse these too early.

---

## 10. Required Invariants

Unit tests should enforce:

### 10.1 No Direction, No Exposure Drift

```text
z = 0 => M x = 0
```

unless the trade is explicitly booked as residual / reconciliation.

### 10.2 Direction Explainability

For standard trades:

```text
M x - D z = 0
```

within tolerance.

### 10.3 Residual Visibility

If:

```text
M x_exec != D z
```

then:

```text
residualLedger.rowCount > 0
```

or execution must be rejected.

### 10.4 Cost Gate

If expected value does not clear cost:

```text
EV(z) <= TC(x) + buffer
```

then no new direction should be opened.

### 10.5 Horizon Match

Expected value horizon and risk horizon must match.

Examples:

- 15-minute directional signal should not use daily covariance without scaling
- funding carry EV should match next funding horizon

---

## 11. Current M1/M2 Direction

Current implementation state:

- continuous optimizer exists in `src/portfolio/optimizer_v1.ts`
- optimizer objective is now written through bid/ofr side quantities internally
- optimizer request can carry optional basis bid/ofr scores and instrument bid/ofr costs
- execution quantization exists in `src/portfolio/execution.ts`
- chain tests expose that independent rounding breaks multi-leg carry package ratios
- package-aware basis-weight quantization exists in `src/portfolio/execution.ts`
- direction / marketlet exposure compilers exist in `src/portfolio/direction.ts` and `src/portfolio/marketlet.ts`
- approved direction-to-marketlet route compilation exists in `src/portfolio/marketlet.ts`
- finite default bounds are required on every `DirectionSpec` and `MarketletSpec`
- direction and marketlet compilers clamp requested weights to bounds before exposure compilation
- marketlet-bound clamping that breaks `M x = D z` is surfaced as explicit residual
- bid/ofr side quantity helpers exist in `src/portfolio/side.ts`
- direction and marketlet exposure can compile from bid/ofr quantities using `net = bid - offer`

Next design step:

1. Map routed marketlet weights into package-aware instrument execution plans
2. Add expected-value estimates for active directions
3. Add package residual budgets and health checks
4. Add shadow-mode runtime reporting for optimizer vs existing strategy decisions

Do not wire this to live execution until these invariants pass in shadow mode.
