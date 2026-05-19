# CHOP Grid Implementation

## Goal

Use `CHOP` / `RANGE` as a dedicated long-inventory grid regime.

## Behavior

- Seed a larger long position when the regime enters `CHOP` / `RANGE`
- Use maker-only ladder orders above and below the anchor price
- Keep the grid wide enough to clear round-trip fees
- Keep re-centering while price stays inside the band
- Exit fully on breakout, regime flip, window end, or max holding
- Persist grid snapshot, open lots, and round-trip audit stats in SQLite
- Deduplicate fills by a stable fill key so restarts do not replay old history

## Parameters

- `CHOP_GRID_LAYERS`
- `CHOP_GRID_SPACING_PCT`
- `CHOP_GRID_ORDER_SIZE`
- `CHOP_GRID_SEED_MULTIPLIER`
- `CHOP_GRID_MAX_INVENTORY`
- `CHOP_GRID_RECENTER_PCT`
- `CHOP_GRID_BREAKOUT_PCT`
- `CHOP_GRID_COOLDOWN_MS`

## Execution Flow

1. `strategy_runner.ts` evaluates regime.
2. If regime is `TREND_UP` / `TREND_DOWN`, keep the existing directional logic.
3. If regime is `CHOP` / `RANGE`, hand control to `chop_grid.ts`.
4. `chop_grid.ts` maintains one long seed plus ladder orders.
5. Any breakout closes inventory and cancels pending grid orders.

## Risk Rules

- Grid only runs in `CHOP` / `RANGE`
- Breakout is a hard exit, not a re-center
- Grid is flattened before regime switch or window end
- Inventory is capped by `CHOP_GRID_MAX_INVENTORY`
- Grid spacing should satisfy `round_trip_fee <= gross_grid_profit / 4`
- Round-trip stats are logged with gross, fee, net, and fee/profit ratio

## Agent Notes

- Keep the grid module separate from trend logic
- Do not reuse the directional stop-loss logic on grid inventory
- Prefer config-driven changes over code changes for tuning
- Audit each completed buy/sell round-trip with gross PnL, fee, net PnL, and fee/profit ratio
