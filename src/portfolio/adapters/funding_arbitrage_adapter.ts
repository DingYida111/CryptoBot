import { OKX_BTC_USDT_SPOT, OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildPortfolioState } from "../portfolio_state.js";
import type {
  FundingArbPortfolioMetadata,
  InstrumentPosition,
  PortfolioState,
  SecurityExposure,
} from "../portfolio_types.js";

export interface BuildFundingArbPortfolioStateInput {
  readonly asOfMs: number;
  readonly instrumentPositions: readonly InstrumentPosition[];
  readonly securityExposures: readonly SecurityExposure[];
  readonly cashBalances?: Readonly<Record<string, number>>;
  readonly metadata: FundingArbPortfolioMetadata;
}

export function fundingArbPositionsToInstrumentPositions(input: {
  readonly spotBtc: number;
  readonly shortContracts: number;
}): InstrumentPosition[] {
  const rows: InstrumentPosition[] = [];
  if (Math.abs(input.spotBtc) > 1e-12) {
    rows.push({
      instrumentId: OKX_BTC_USDT_SPOT,
      quantity: input.spotBtc,
    });
  }
  if (Math.abs(input.shortContracts) > 1e-12) {
    rows.push({
      instrumentId: OKX_BTC_USDT_SWAP,
      quantity: -input.shortContracts,
    });
  }
  return rows;
}

export function buildPortfolioStateFromFundingArb(
  input: BuildFundingArbPortfolioStateInput
): PortfolioState {
  const portfolioState = buildPortfolioState({
    asOfMs: input.asOfMs,
    instrumentPositions: input.instrumentPositions,
    securityExposures: input.securityExposures,
    cashBalances: input.cashBalances,
    metadata: input.metadata,
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
