# Funding Arbitrage V1 Runbook

## Scope

This document describes the first deliverable funding-arbitrage path in `CryptoBot`.

V1 is intentionally narrow:

- market: `BTC-USDT` spot + `BTC-USDT-SWAP` perp on OKX
- execution mode: `shadow` first, then `paper` validation
- purpose: validate the full computation and execution chain before a generalized optimizer replaces the rule path

## What Is Implemented

### Pure carry model

File:

- `src/carry/funding_arbitrage.ts`

The model computes:

- spot / perp mid
- basis in USD and bps
- depth-limited package size
- expected funding revenue
- expected fees
- expected slippage
- basis-risk buffer
- final `netCarryEdgeUsd`

The carry gate is conservative by default. Standard entry requires:

- the funding entry window to be open
- positive funding
- package size above minimum
- `netCarryEdgeUsd > safetyBufferUsd`

### Local managed strategy

Files:

- `src/runtime/local_funding_arbitrage_controller.ts`
- `src/runtime/run_funding_arbitrage_validation.ts`

The controller is registered as:

- `local_funding_arbitrage`

State machine:

- `idle`
- `await_entry_window`
- `evaluating_entry`
- `entering`
- `holding_for_funding`
- `unwinding`
- `completed`
- `aborted`

### Official OKX comparison path

File:

- `src/trade/run_okx_batch_funding_pair_validation.ts`

This script places the same two-leg package through OKX official batch order APIs:

- buy spot
- sell short perp
- hold briefly
- sell spot using actual live available BTC
- buy back short perp

## Runtime Integration

### Managed strategy registry

The strategy is wired into the generic runtime:

- `src/runtime/managed_strategies.ts`
- `src/runtime/strategy_registry.ts`
- `src/runtime/strategy_supervisor.ts`

This means the funding arbitrage path is not a one-off script. It can be supervised like other local or OKX-managed strategies.

### Portfolio algebra integration

The strategy now emits portfolio-style views as well:

- `src/portfolio/instrument_spec.ts`
- `src/portfolio/adapters/funding_arbitrage_adapter.ts`

Active instruments used in V1:

- `OKX:BTC-USDT`
- `OKX:BTC-USDT-SWAP`

The portfolio snapshot records:

- spot BTC inventory
- short perp contracts
- net BTC delta
- funding exposure
- carry metadata such as basis, funding rate, and net edge

## Persistence

### Funding arbitrage tables

Stored in SQLite:

- `funding_arb_opportunities`
- `funding_arb_events`

### Generic runtime tables

Also persisted through the standard managed-strategy plane:

- `managed_strategy_runs`
- `managed_strategy_snapshots`
- `managed_strategy_sub_orders`
- `managed_strategy_positions`

### Portfolio view table

The strategy also writes to:

- `portfolio_snapshots`

with:

- `source = local_funding_arbitrage`
- `shadow_version = funding-arb-v1`

## How To Run

### 1. Shadow-only validation

```bash
FUNDING_ARB_PAPER_EXECUTE=false \
FUNDING_ARB_FORCE_VALIDATION_ENTRY=false \
FUNDING_ARB_LOOP_COUNT=1 \
npm run run:funding-arb:validate
```

Expected behavior:

- no orders placed
- one opportunity row inserted
- `shouldEnter=false` if not in the funding window or edge is negative

### 2. Local paper execution validation

```bash
FUNDING_ARB_PAPER_EXECUTE=true \
FUNDING_ARB_FORCE_VALIDATION_ENTRY=true \
FUNDING_ARB_MAX_HOLD_MS=4000 \
FUNDING_ARB_LOOP_COUNT=3 \
FUNDING_ARB_LOOP_SLEEP_MS=3000 \
npm run run:funding-arb:validate
```

Expected behavior:

- one paper spot buy
- one paper perp short
- one unwind cycle
- no residual short position
- only BTC dust remains after fees

### 3. Official OKX batch-order comparison

```bash
BATCH_FUNDING_ARB_CONTRACTS=1 \
BATCH_FUNDING_ARB_HOLD_MS=3000 \
npm run run:okx-batch-funding-validate
```

Expected behavior:

- `openAck` should contain 2 successful orders
- `closeAck` should contain 2 successful orders
- spot close size should use live available BTC, not theoretical `0.01`

### 4. Report recent funding-arb activity

```bash
npm run report:funding-arb -- 20
```

Optional instance filter:

```bash
npm run report:funding-arb -- 20 --instance funding_arb_btc_demo
```

## Supervisor Configuration

The cleanest way to enable this strategy in the generic supervisor is `MANAGED_STRATEGY_INSTANCES_JSON`.

Example:

```json
[
  {
    "instanceId": "funding_arb_btc_demo",
    "type": "local_funding_arbitrage",
    "instrument": "BTC funding package",
    "enabled": true,
    "autoStart": true,
    "syncIntervalMs": 5000,
    "parameters": {
      "spotInstId": "BTC-USDT",
      "perpInstId": "BTC-USDT-SWAP",
      "entryLeadMs": 120000,
      "maxPackageSizeBtc": 0.01,
      "minUsefulPackageSizeBtc": 0.01,
      "spotFeeRate": 0.001,
      "perpFeeRate": 0.0005,
      "spotSlippageBps": 5,
      "perpSlippageBps": 5,
      "basisRiskBufferBps": 8,
      "safetyBufferUsd": 1,
      "paperExecute": false,
      "forceValidationEntry": false,
      "maxHoldMs": 300000,
      "maxNetDeltaToleranceBtc": 0.002
    }
  }
]
```

## Important Safeguards

Two details are critical:

### Close spot using live available BTC

A spot buy paid in base currency leaves less than the theoretical bought quantity available for sale. The strategy therefore closes spot using:

- current `availBal`
- minus a small epsilon

This avoids repeated close failures.

### Only close incremental strategy inventory

The strategy stores pre-entry balances and short-contract counts. On unwind it only closes:

- the BTC added by this package
- the short contracts added by this package

This prevents accidental liquidation of unrelated account inventory.

## Known V1 Limits

- only BTC spot + BTC perp is modeled
- funding edge is still rule-gated, not optimizer-driven
- no borrow-interest leg is modeled yet
- no best-execution scheduler beyond immediate market orders
- no isolated demo account orchestration; if other bots share the same paper account, validation noise will appear

## Recommended Next Steps

1. Add borrow / funding carry decomposition into the broader `interest` model family.
2. Move from rule gating to an optimizer request builder once multiple carry packages exist.
3. Add isolated-account or isolated-subaccount validation to prevent shared paper-account interference.
4. Extend the same pattern to:
   - spread arbitrage
   - martingale / DCA wrappers
   - cross-instrument residual accounting
