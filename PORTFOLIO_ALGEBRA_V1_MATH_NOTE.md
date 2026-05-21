# Portfolio Algebra V1 Math Note

> Companion note for `PORTFOLIO_ALGEBRA_FOUNDATION.md`
> Scope: the exact mathematical model currently implemented in V1
> Audience: human reviewers and coding agents that need a precise, non-drifting reference

---

## 1. Why This Note Exists

The foundation document explains the migration path and architecture.

This note is narrower:

- define the actual V1 mathematical objects
- make unit conventions explicit
- show one worked example from position to exposure to trade decomposition
- state clearly what is real economics and what is V1 bookkeeping approximation

This matters because the current V1 is:

- already useful as a canonical accounting layer
- not yet a full optimizer
- easy to misunderstand if someone assumes `basis`, `strategy`, and `execution route` are already the same object

---

## 2. Scope of V1

V1 is intentionally small.

- One tradable instrument:
  - `OKX:BTC-USDT-SWAP`
- One active strategy basis:
  - `b1 = +1 * OKX:BTC-USDT-SWAP`
- Three active securities:
  - `BTC_DELTA`
  - `USDT_CASH`
  - `BTC_PERP_FUNDING_OKX`
- No LP or MIP solver
- No execution-path replacement
- Residual is record-first, not constraint-driven

So V1 is best understood as a portfolio algebra and bookkeeping layer, not as a portfolio optimizer.

---

## 3. Symbol Table

### 3.1 Position and trade symbols

- `q`
  - current instrument position vector
- `dq`
  - proposed instrument trade increment
- `q_next = q + dq`
  - next position after the trade

### 3.2 Exposure symbols

- `E`
  - instrument-to-security exposure matrix
- `s = E q`
  - current security exposure vector
- `ds = E dq`
  - incremental security exposure from a new trade

### 3.3 Strategy decomposition symbols

- `B`
  - strategy basis matrix
- `w`
  - standard strategy weights
- `r`
  - residual instrument increment

The core decomposition is:

```text
dq = B w + r
```

Interpretation:

- `B w`
  - the part of the trade that is expressible using approved standard basis
- `r`
  - the part of the trade that is outside standard routing and must be explicitly justified

---

## 4. Unit Conventions

Unit discipline is the most important non-negotiable rule in this framework.

### 4.1 Instrument unit

For `OKX:BTC-USDT-SWAP`:

- instrument quantity unit = contracts

### 4.2 Security units

- `BTC_DELTA`
  - unit = BTC
- `USDT_CASH`
  - unit = USDT
- `BTC_PERP_FUNDING_OKX`
  - unit = placeholder BTC-equivalent sensitivity in V1

### 4.3 Contract multiplier

V1 uses the real contract multiplier:

```text
ctVal = 0.01 BTC per contract
```

This means:

- 1 contract = `0.01 BTC_DELTA`
- 1 contract = placeholder `0.01 BTC_PERP_FUNDING_OKX`

Do not normalize this to `1`.

If this normalization is lost, the system will start mixing:

- contracts
- BTC quantity
- USD notional
- delta PnL

and future multi-instrument extensions will drift silently.

---

## 5. The Exact V1 Exposure Matrix

With one instrument and three active securities, the exposure matrix is:

| Security \\ Instrument | `OKX:BTC-USDT-SWAP` |
|---|---:|
| `BTC_DELTA` | `0.01` |
| `USDT_CASH` | `0` |
| `BTC_PERP_FUNDING_OKX` | `0.01` |

Equivalently:

```text
      [ 0.01 ]
E  =  [ 0    ]
      [ 0.01 ]
```

Important interpretation:

- row 1 is economically meaningful delta exposure
- row 2 is a placeholder zero cash exposure in the current V1 perp-only implementation
- row 3 is not a finished funding model, only a tracked placeholder sensitivity

So V1 gives us a correct structural exposure map, but not yet a complete economic state model.

---

## 6. The Exact V1 Basis Matrix

There is only one approved standard basis in V1:

```text
b1 = +1 * OKX:BTC-USDT-SWAP
```

So:

```text
B = [ 1 ]
```

This has two consequences:

1. Any standard long or short contract trade is represented by the sign of `w`
2. In pure linear algebra terms, the 1D instrument space is fully spanned by the single basis column

That second point is subtle and important.

Because the instrument space is one-dimensional, every numeric `dq` can be written as:

```text
dq = 1 * dq + 0
```

So in V1, residual is not primarily a geometric necessity.

Instead, residual is currently a governance and bookkeeping category:

- manual override
- emergency flatten
- partial fill reconciliation
- fee drift
- funding drift
- state reconciliation
- unrouted decision

That means:

- a trade can be numerically representable by basis
- but still be intentionally booked into residual because the system does not want to treat it as standard strategy behavior

This distinction must remain explicit.

---

## 7. Standard Trade vs Residual in V1

### 7.1 Standard trade

A standard trade is one that the system is willing to interpret as:

```text
dq = B w
```

with:

```text
r = 0
```

Examples:

- open long 6 contracts
- open short 4 contracts
- close long 3 contracts
- reduce short 2 contracts

All of these are standard because they are ordinary contract changes on the canonical instrument.

### 7.2 Residual trade

A residual trade is one that V1 intentionally records as:

```text
dq = r
```

with:

```text
w = 0
```

because the system wants an explicit reason code.

Examples:

- exchange state reconciliation
- partial-fill cleanup
- emergency flatten
- manual intervention

This is why residual in V1 should be read as:

- "not standard for governance purposes"

not as:

- "not linearly representable"

---

## 8. Worked Example

This is the reference example future contributors should use when checking whether they still understand the V1 model.

### 8.1 Market and registry setup

Assume:

- instrument:
  - `i1 = OKX:BTC-USDT-SWAP`
- securities:
  - `s1 = BTC_DELTA`
  - `s2 = USDT_CASH`
  - `s3 = BTC_PERP_FUNDING_OKX`
- contract multiplier:
  - `0.01 BTC / contract`
- BTC mark price:
  - `P = 78,000 USDT`

Matrices:

```text
      [ 0.01 ]
E  =  [ 0    ]
      [ 0.01 ]

B  =  [ 1 ]
```

### 8.2 Current position

Suppose the runner currently holds:

```text
q = [ 9 ]
```

meaning:

- long 9 contracts of `BTC-USDT-SWAP`

### 8.3 Current security exposure

Compute:

```text
s = E q
```

So:

```text
      [ 0.01 ]       [ 9 ]       [ 0.09 ]
s  =  [ 0    ]   *   [   ]   =   [ 0    ]
      [ 0.01 ]                   [ 0.09 ]
```

Interpretation:

- `BTC_DELTA = 0.09 BTC`
- `USDT_CASH = 0`
- `BTC_PERP_FUNDING_OKX = 0.09` placeholder sensitivity

### 8.4 USD notional implied by exposure

Using the BTC mark:

```text
USD notional = BTC_DELTA exposure * BTC price
             = 0.09 * 78,000
             = 7,020 USDT
```

This is exactly why the real `0.01 BTC` multiplier must be preserved.

The notional comes out directly from exposure arithmetic.

### 8.5 Delta PnL implied by exposure

If BTC rises from `78,000` to `78,500`, then:

```text
dP = +500 USDT / BTC
```

Approximate delta PnL:

```text
Delta PnL = BTC_DELTA exposure * dP
          = 0.09 * 500
          = 45 USDT
```

This matches the usual contract arithmetic:

```text
9 contracts * 0.01 BTC * 500 USDT/BTC = 45 USDT
```

This equivalence is one of the most important invariants in the whole framework.

### 8.6 Standard close example

Suppose the strategy wants to reduce the long from 9 contracts to 6 contracts.

Then:

```text
dq = [ -3 ]
```

Since this is a standard trade:

```text
dq = B w + r
```

with:

```text
B = [1]
w = [-3]
r = [0]
```

So:

```text
[-3] = [1] * [-3] + [0]
```

The next position is:

```text
q_next = q + dq = 9 + (-3) = 6
```

New exposure:

```text
s_next = E q_next
       = E [6]
       = [0.06, 0, 0.06]^T
```

### 8.7 Residual reconciliation example

Now assume the bot expected a standard close of 3 contracts, but after exchange sync it detects an extra `-0.4` contract discrepancy that it does not want to treat as standard strategy behavior.

The observed total trade delta is:

```text
dq = -3.4
```

V1 has two mathematically valid ways to describe this:

### Pure geometric description

Because `B = [1]`, one could write:

```text
w = -3.4
r = 0
```

### V1 governance description

But if the system wants to isolate the non-standard piece, it should book:

```text
w = -3
r = -0.4
reason = STATE_RECONCILIATION
```

This is the correct V1 operational interpretation.

The point of residual here is not that `-0.4` is mathematically unspanned.

The point is that the system wants future observers to know:

- `-3` contracts came from normal strategy routing
- `-0.4` contracts came from reconciliation logic

That is exactly the kind of drift information the framework is supposed to preserve.

---

## 9. What V1 Is Not Yet Modeling

This section is as important as the example.

### 9.1 It is not yet a full cash model

`USDT_CASH = 0` in the exposure matrix does not mean cash does not matter.

It means V1 has not yet encoded:

- margin consumption
- realized cash movements
- fee drag
- collateral transfers

inside the canonical exposure matrix.

### 9.2 It is not yet a real funding model

`BTC_PERP_FUNDING_OKX = 0.01` is a placeholder sensitivity, not a fully correct funding exposure model.

### 9.3 It is not yet a multi-strategy geometric basis system

Current execution styles such as:

- trend
- contrarian
- chop grid

are not yet separate basis columns.

They are still:

- execution routes
- decision modes
- metadata categories

while the instrument algebra remains one-dimensional.

### 9.4 It is not yet an optimizer

`OptimizationRequest` exists, but V1 does not yet solve:

- LP
- QP
- MIP

It only prepares clean inputs and runs a shadow stub.

---

## 10. The Correct Mental Model

If someone asks what V1 really is, the best short answer is:

```text
V1 is a canonical position/exposure/basis/residual bookkeeping layer for one real tradable instrument.
```

It is not yet:

```text
a mathematically rich multi-asset optimizer
```

That broader optimizer is a later phase.

---

## 11. What Must Stay True in Future Iterations

Any future extension should preserve these invariants:

1. Instrument units, security units, and USD notional conversions remain explicit
2. `s = E q` remains deterministic and testable
3. `dq = B w + r` remains the canonical trade decomposition
4. Standard strategy intent is represented through basis before residual is used
5. Residual remains visible, reason-coded, and reviewable
6. Shadow validation stays in place before execution-path replacement

If an implementation breaks any of these, it is not an extension of the V1 framework. It is a different framework.

---

## 12. Recommended Next Extension

The next mathematically meaningful step is not "add a solver immediately".

The next step is:

- introduce a second instrument
- expand `E` to multiple columns
- define whether the new instrument shares existing securities or introduces new ones
- then decide whether a second basis column is warranted

Only after that will residual begin to have stronger geometric meaning, instead of being mostly governance-oriented.

---

## 13. Bottom Line

The V1 model is correct if read in the right way:

- it is narrow
- it is explicit
- it is unit-consistent
- it is intentionally shadow-first
- it separates standard intent from non-standard drift

That is enough to make future optimization safer.

It is not supposed to solve the whole portfolio problem yet.
