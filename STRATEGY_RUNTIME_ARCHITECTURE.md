# Strategy Runtime Architecture

## Goal

Provide one control plane for:

- Local strategies managed by CryptoBot code
- Exchange-managed strategies such as OKX grid or DCA
- Future strategy families such as martingale, spread arbitrage, and signal bots

The runtime should support:

- Parameter management
- Strategy start/sync/stop lifecycle
- Benchmarking between local and external strategies
- Persistent snapshots for reporting and backtesting

## Design Patterns

### 1. Strategy Pattern

Each strategy family exposes a controller with the same lifecycle:

- `start(config)`
- `sync(config)`
- `stop(config)`

This keeps the orchestration layer independent of concrete strategy logic.

### 2. Adapter Pattern

Local strategies and OKX-managed strategies do not look the same operationally.

- Local strategy adapter wraps internal execution state and local logs
- OKX adapter wraps remote strategy APIs and converts exchange payloads into a common snapshot format

The runtime only consumes the normalized adapter output.

### 3. Registry / Factory

`ManagedStrategyRegistry` maps strategy type to:

- definition metadata
- parameter schema
- controller factory

Adding a new strategy should only require:

1. a new definition
2. a new controller implementation
3. a registry binding

### 4. Snapshot Repository

SQLite stores:

- current run metadata
- time-series snapshots
- sub-order state
- position state

This separates execution from analysis and enables later dashboards and agent review.

## Layers

### Layer 1: Definition Catalog

File: `src/runtime/managed_strategies.ts`

Owns:

- strategy type names
- backend classification (`local`, `okx_managed`)
- venue classification (`cryptobot`, `okx`)
- parameter specs for UI/agent use

This is the contract layer for future agent-driven parameter tuning.

### Layer 2: Controllers

Example:

- `src/runtime/okx_contract_grid_controller.ts`

Owns:

- strategy-specific start/sync/stop logic
- conversion of venue-native payloads into normalized snapshots

Future examples:

- `okx_martingale_controller.ts`
- `local_spread_arbitrage_controller.ts`

### Layer 3: Registry

File: `src/runtime/strategy_registry.ts`

Owns:

- controller construction
- strategy discovery

This is the right place for feature flags or environment-based strategy availability later.

### Layer 4: Persistence

File: `src/monitor/storage.ts`

Owns:

- `managed_strategy_runs`
- `managed_strategy_snapshots`
- `managed_strategy_sub_orders`
- `managed_strategy_positions`

This makes strategy benchmarking queryable without depending on logs.

### Layer 5: Runners

Example:

- `src/runtime/run_okx_grid_benchmark.ts`

Owns:

- environment parsing
- strategy instance config construction
- optional auto-create behavior
- persistence calls

Future runners can orchestrate multiple strategies in one polling loop.

## Supervisor

Files:

- `src/runtime/strategy_supervisor.ts`
- `src/runtime/run_strategy_supervisor.ts`
- `src/runtime/supervisor_config.ts`

Responsibilities:

- load strategy instances from `MANAGED_STRATEGY_INSTANCES_JSON`
- fall back to the OKX benchmark instance when no explicit list is provided
- reuse one controller per strategy instance
- optionally auto-start idle strategies
- persist normalized snapshots on each sync cycle
- emit compact status logs for agent review and production debugging

Example `MANAGED_STRATEGY_INSTANCES_JSON`:

```json
[
  {
    "instanceId": "okx_grid_btc_demo",
    "type": "okx_contract_grid",
    "instrument": "BTC-USDT-SWAP",
    "enabled": true,
    "autoStart": false,
    "syncIntervalMs": 60000,
    "parameters": {
      "algoId": "",
      "direction": "neutral",
      "margin": 200,
      "leverage": 2,
      "gridNum": 7,
      "runType": 1,
      "minPriceRatio": 0.97,
      "maxPriceRatio": 1.03
    },
    "metadata": {
      "role": "benchmark"
    }
  }
]
```

## Why This Scales

This structure prevents three common failures:

1. Venue-specific API code leaking into high-level orchestration
2. Parameter logic being hard-coded inside runners
3. Benchmark/reporting logic depending on fragile text logs

With the current separation, adding OKX martingale later is mostly an adapter task, not a refactor of the whole bot.
