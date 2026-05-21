import type { Position } from "../../trade/okx_trade.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import type { InstrumentPosition } from "../portfolio_types.js";

export interface StrategyRunnerPositionSnapshot {
  readonly side: "long" | "short" | null;
  readonly isGrid: boolean;
  readonly entryPrice: number | null;
  readonly windowEndTimestamp: number | null;
}

export function okxPositionsToInstrumentPositions(
  positions: readonly Position[],
  instId = "BTC-USDT-SWAP"
): InstrumentPosition[] {
  const active = positions.filter((row) => row.instId === instId && parseFloat(row.pos) !== 0);
  if (active.length === 0) {
    return [];
  }
  const first = active[0];
  const quantity = parseFloat(first.pos) * (first.posSide === "short" ? -1 : 1);
  return [
    {
      instrumentId: OKX_BTC_USDT_SWAP,
      quantity,
    },
  ];
}
