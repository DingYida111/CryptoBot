import type { Position } from "../../trade/okx_trade.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import type { DecisionIntent, InstrumentPosition, PortfolioState, ResidualPosition, SecurityExposure } from "../portfolio_types.js";
import { buildPortfolioState } from "../portfolio_state.js";

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

export interface BuildRunnerPortfolioStateInput {
  readonly asOfMs: number;
  readonly instrumentPositions: readonly InstrumentPosition[];
  readonly securityExposures: readonly SecurityExposure[];
  readonly cashBalances?: Readonly<Record<string, number>>;
  readonly residualPositions?: readonly ResidualPosition[];
  readonly signalDirection: string;
  readonly signalRegime: string;
  readonly btcPrice: number;
  readonly actualIntent: DecisionIntent;
  readonly shadowIntent: DecisionIntent;
  readonly positionSnapshot: StrategyRunnerPositionSnapshot;
  readonly gridMetadata?: Readonly<Record<string, string | number | boolean>>;
}

export function buildPortfolioStateFromRunner(input: BuildRunnerPortfolioStateInput): PortfolioState {
  const portfolioState = buildPortfolioState({
    asOfMs: input.asOfMs,
    instrumentPositions: input.instrumentPositions,
    securityExposures: input.securityExposures,
    cashBalances: input.cashBalances,
    residualPositions: input.residualPositions,
    metadata: {
      signalDirection: input.signalDirection,
      signalRegime: input.signalRegime,
      actualRoute: input.actualIntent.route,
      shadowRoute: input.shadowIntent.route,
      actualDqContracts: input.actualIntent.proposedDqContracts,
      shadowDqContracts: input.shadowIntent.proposedDqContracts,
      btcPrice: input.btcPrice,
      positionSide: input.positionSnapshot.side ?? "flat",
      positionIsGrid: input.positionSnapshot.isGrid,
      entryPrice: input.positionSnapshot.entryPrice ?? 0,
      windowEndTimestamp: input.positionSnapshot.windowEndTimestamp ?? 0,
      ...(input.gridMetadata ?? {}),
    },
  });
  return {
    ...portfolioState,
    metadata: {
      ...portfolioState.metadata,
      residualRowCount: portfolioState.residualSummary.rowCount,
      residualGrossQuantity: portfolioState.residualSummary.grossQuantity,
      residualNetQuantity: portfolioState.residualSummary.netQuantity,
    },
  };
}
