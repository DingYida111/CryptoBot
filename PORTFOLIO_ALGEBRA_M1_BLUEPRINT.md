# Portfolio Algebra M1 Blueprint

> Concrete build sheet for `M1: Registry + Exposure Compiler`
> Scope: single instrument `OKX:BTC-USDT-SWAP`, read-only integration, no trading-path changes
> Language: TypeScript only

---

## 1. Purpose

This document translates [PORTFOLIO_ALGEBRA_FOUNDATION.md](/Users/yidading/CryptoBot/PORTFOLIO_ALGEBRA_FOUNDATION.md) into a file-by-file M1 implementation plan.

M1 should deliver one thing reliably:

- given current instrument positions, compute deterministic security exposure with correct units

This milestone is intentionally low risk:

- no order logic changes
- no controller changes
- no optimizer
- no shadow execution yet

It is a pure read-only modeling layer.

---

## 2. Current Code Anchors

These existing files are the main anchors for M1.

### 2.1 Position source

- [src/trade/okx_trade.ts](/Users/yidading/CryptoBot/src/trade/okx_trade.ts)

Current source of truth for live position polling:

- `getPositions(instId)`

### 2.2 Current contract-size logic

- [src/trade/strategy_runner.ts](/Users/yidading/CryptoBot/src/trade/strategy_runner.ts)
- [src/trade/chop_grid.ts](/Users/yidading/CryptoBot/src/trade/chop_grid.ts)
- [src/monitor/okx.ts](/Users/yidading/CryptoBot/src/monitor/okx.ts)

Important current facts:

- `strategy_runner.ts` still hardcodes `CONTRACT_SIZE = 0.01`
- `chop_grid.ts` already has `fetchBtcSwapMeta()` and `ctVal` fallback logic
- `monitor/okx.ts` already exposes public instrument metadata including `ctVal`

M1 should not duplicate this logic blindly.

The right direction is:

- centralize contract value lookup in the new portfolio registry layer
- preserve current behavior by keeping `0.01` as fallback

### 2.3 Persistence anchor

- [src/monitor/storage.ts](/Users/yidading/CryptoBot/src/monitor/storage.ts)

M1 itself does not require schema changes, but this is where any future snapshot tables will eventually live.

---

## 3. M1 Non-Goals

M1 must not do any of the following:

- change `strategy_runner.ts` trading decisions
- change `chop_grid.ts` execution behavior
- change `ManagedStrategyController`
- add basis decomposition
- add residual tracking
- add optimizer request generation
- add new live trading logic

If a change affects execution semantics, it is not M1.

---

## 4. New Source Tree

M1 should introduce the initial `src/portfolio/` directory.

```text
src/portfolio/
  ids.ts
  security_spec.ts
  instrument_spec.ts
  exposure.ts
  portfolio_types.ts
  schemas/
    ids_schema.ts
    security_schema.ts
    instrument_schema.ts
    exposure_schema.ts
  __tests__/
    exposure.test.ts
```

No other files should be added in M1 unless they are test helpers.

---

## 5. File-by-File Plan

## 5.1 `src/portfolio/ids.ts`

Purpose:

- define branded identifiers shared by the portfolio layer

Exports:

- `Brand<T, B>`
- `SecurityId`
- `InstrumentId`
- `PortfolioUnit`

Recommended shape:

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SecurityId = Brand<string, "SecurityId">;
export type InstrumentId = Brand<string, "InstrumentId">;
```

Notes:

- do not over-brand every string in M1
- only brand stable identity fields

## 5.2 `src/portfolio/portfolio_types.ts`

Purpose:

- hold common readonly interfaces used across registry and exposure code

Exports:

- `SecurityCategory`
- `SecuritySpec`
- `InstrumentKind`
- `InstrumentSpec`
- `InstrumentPosition`
- `SecurityExposure`

Recommended shapes:

```ts
export type SecurityCategory = "delta" | "cash" | "funding" | "basis" | "issuer" | "borrow" | "other";

export interface SecuritySpec {
  readonly securityId: SecurityId;
  readonly category: SecurityCategory;
  readonly unit: string;
  readonly markSource: string;
  readonly description: string;
  readonly active: boolean;
}

export interface InstrumentSpec {
  readonly instrumentId: InstrumentId;
  readonly kind: "perp";
  readonly venue: "OKX";
  readonly baseAsset: "BTC";
  readonly quoteAsset: "USDT";
  readonly quantityUnit: "contract";
  readonly priceUnit: "USDT";
  readonly minTradeSize: number;
  readonly stepSize: number;
  readonly contractMultiplier: number;
  readonly allowedSides: readonly ["buy", "sell"];
  readonly exposurePerContract: Readonly<Record<SecurityId, number>>;
  readonly tags: readonly string[];
}

export interface InstrumentPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: number;
}

export interface SecurityExposure {
  readonly securityId: SecurityId;
  readonly quantity: number;
  readonly unit: string;
}
```

Notes:

- `exposurePerContract` is the key field for M1
- do not add `cashflowRules` yet
- do not add composite instrument support yet

## 5.3 `src/portfolio/security_spec.ts`

Purpose:

- define the static V1 security registry

Exports:

- security constants
- `SECURITY_SPECS`
- `getSecuritySpec()`
- `listActiveSecuritySpecs()`

Required active entries:

- `BTC_DELTA`
- `USDT_CASH`
- `BTC_PERP_FUNDING_OKX`

Required reserved entries are optional in M1.

If included, mark them `active: false`.

Implementation rule:

- one stable object literal
- frozen or readonly by construction

## 5.4 `src/portfolio/instrument_spec.ts`

Purpose:

- define the static V1 instrument registry

Exports:

- instrument constants
- `INSTRUMENT_SPECS`
- `getInstrumentSpec()`
- `listActiveInstrumentSpecs()`
- optional helper `buildBtcSwapInstrumentSpec(meta?)`

Required active entry:

- `OKX:BTC-USDT-SWAP`

Critical semantic rule:

- `contractMultiplier` must default to `0.01`
- `exposurePerContract` must map:
  - `BTC_DELTA -> 0.01`
  - `USDT_CASH -> 0`
  - `BTC_PERP_FUNDING_OKX -> 0.01`

Recommended implementation split:

1. static fallback spec with `0.01`
2. optional enrichment helper that can ingest `ctVal` from `fetchBtcSwapMeta()`

This avoids making M1 async by default, while still preparing the path away from magic constants.

## 5.5 `src/portfolio/exposure.ts`

Purpose:

- pure functions for exposure computation

Exports:

- `computeExposure(positions, registry)`
- `aggregateExposure(rows)`
- `computeUsdNotional(exposures, marks)`
- `computeDeltaPnl(exposures, priceChangeMap)`

Recommended behavior:

### `computeExposure`

Input:

- instrument positions
- instrument registry
- security registry

Output:

- flat array of `SecurityExposure`

Logic:

- for each instrument position
- look up `exposurePerContract`
- multiply each security coefficient by contract quantity
- aggregate by `securityId`

Example:

- 3 contracts `BTC-USDT-SWAP`

Output:

- `BTC_DELTA = 0.03`
- `USDT_CASH = 0`
- `BTC_PERP_FUNDING_OKX = 0.03`

### `computeUsdNotional`

Purpose:

- convert delta-like security exposures into marked USD notional

For M1:

- `BTC_DELTA * BTC mark price`

This helper is important because M1 acceptance is not only “exposure exists”, but “exposure implies the same notional the current bot assumes”.

### `computeDeltaPnl`

Purpose:

- estimate delta-PnL implied by exposure and price move

For M1:

- `BTC_DELTA * dPrice`

This is how M1 can be compared against current hand-written contract-size math.

Implementation constraints:

- all functions pure
- no DB access
- no network access
- no global state

## 5.6 `src/portfolio/schemas/*.ts`

Purpose:

- runtime validation for registry and exposure objects

Required files:

- `ids_schema.ts`
- `security_schema.ts`
- `instrument_schema.ts`
- `exposure_schema.ts`

These schemas should validate:

- registry literals
- computed exposure rows
- any future persisted portfolio records

Key rule:

- do not delay schemas to M2
- runtime data safety starts in M1

---

## 6. Test Plan

M1 must add dedicated tests.

File:

- `src/portfolio/__tests__/exposure.test.ts`

Recommended test cases:

### 6.1 One contract exposure

Given:

- position = `1` contract of `OKX:BTC-USDT-SWAP`

Expect:

- `BTC_DELTA = 0.01`
- `USDT_CASH = 0`
- `BTC_PERP_FUNDING_OKX = 0.01`

### 6.2 Multiple contract exposure

Given:

- position = `7` contracts

Expect:

- `BTC_DELTA = 0.07`
- `BTC_PERP_FUNDING_OKX = 0.07`

### 6.3 Signed quantity exposure

Given:

- position = `-4` contracts

Expect:

- `BTC_DELTA = -0.04`
- `BTC_PERP_FUNDING_OKX = -0.04`

### 6.4 USD notional consistency

Given:

- `BTC_DELTA = 0.03`
- mark = `100000`

Expect:

- notional = `3000`

### 6.5 Delta-PnL consistency

Given:

- position = `5` contracts
- exposure = `0.05 BTC`
- price move = `+1000`

Expect:

- delta-PnL = `50 USDT`

This should match:

- `5 * 0.01 * 1000`

### 6.6 Schema validation

Expect:

- active registry entries pass `zod` schema
- malformed registry entry throws validation error

---

## 7. Integration Plan

M1 should integrate in the smallest possible way.

## 7.1 Immediate integration

Add zero or one optional call site:

- a diagnostic-only call from a local script or debug path

Example:

- build instrument positions from `getPositions("BTC-USDT-SWAP")`
- run `computeExposure()`
- log result

This integration must not affect live decisions.

## 7.2 Recommended first consumer

Best first real consumer:

- a standalone verification script under `src/portfolio/` or `scripts/`

Not:

- direct replacement of `strategy_runner` internal sizing math

## 7.3 Integration to avoid in M1

Avoid:

- changing `calcKellySize()`
- changing stop-loss math
- changing CHOP grid sizing
- changing order quantity generation

Those become easier after M1 is trusted.

---

## 8. Validation Against Current Logic

M1 needs a very explicit validation story against current code.

## 8.1 Current live formula reference

Current code effectively assumes:

- `1 contract = 0.01 BTC`

Examples already present:

- Kelly sizing in `strategy_runner.ts`
- risk per contract in `strategy_runner.ts`
- gross grid PnL in `chop_grid.ts`

## 8.2 Required checks

For the same test case, all of these must agree:

1. portfolio algebra exposure result
2. current contract-size arithmetic
3. implied USD notional
4. implied delta-PnL for a price move

If any of these disagree, M1 is not ready.

---

## 9. Open Design Decisions

These should be explicitly decided, not drift implicitly.

### 9.1 Registry source

Decision for M1:

- static TS literals in source control

Not yet:

- DB-backed registry
- remote config

### 9.2 Contract multiplier source

Decision for M1:

- source-of-truth fallback is `0.01`
- optional enrichment path via `fetchBtcSwapMeta()`

This mirrors current system reality while removing future ambiguity.

### 9.3 Exposure output shape

Decision for M1:

- array of `SecurityExposure`

Why:

- easy to test
- easy to serialize
- easy to aggregate

Internal helper maps are fine, but final public output should be stable.

---

## 10. Acceptance Criteria

M1 is done when all of the following are true:

1. `src/portfolio/` exists with the planned registry and exposure files.
2. `computeExposure()` is pure and deterministic.
3. one-contract exposure equals `0.01 BTC` delta.
4. notional derived from exposure matches current contract arithmetic.
5. delta-PnL derived from exposure matches current hand-written logic.
6. all public portfolio objects are protected by `zod` schemas.
7. no live trading behavior changes.

If live trading behavior changes, M1 has exceeded scope.

---

## 11. Recommended Next Step After M1

If M1 passes, the next step should be M2:

- add `basis.ts`
- add `residual.ts`
- add canonical `PortfolioState`
- build adapters from:
  - `PositionState`
  - `ChopGridSnapshot`

That is the right point to begin logging `dq = B w + r`.
