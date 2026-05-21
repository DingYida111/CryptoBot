import { asStrategyBasisId } from "./ids.js";
import type { InstrumentId } from "./ids.js";
import type {
  BasisDecomposition,
  DecisionRoute,
  ResidualPosition,
  StrategyBasisSpec,
  TradeLedgerEntry,
  TradePackageLedger,
} from "./portfolio_types.js";
import { asResidualReasonCode } from "./ids.js";
import {
  DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER,
  OKX_BTC_USDT_SPOT,
  OKX_BTC_USDT_SWAP,
} from "./instrument_spec.js";
import { collapseResidualPositions, summarizeResidualLedger } from "./residual.js";

export const BASIS_LONG_BTC_SWAP = asStrategyBasisId("basis:long_btc_swap");
export const BASIS_BTC_FUNDING_CARRY_PACKAGE = asStrategyBasisId("basis:btc_funding_carry_package");

export const STRATEGY_BASIS_SPECS: readonly StrategyBasisSpec[] = Object.freeze([
  {
    basisId: BASIS_LONG_BTC_SWAP,
    instrumentWeights: {
      [OKX_BTC_USDT_SWAP]: 1,
    },
    description: "One standard BTC-USDT-SWAP contract as the canonical V1 basis direction",
    active: true,
  },
  {
    basisId: BASIS_BTC_FUNDING_CARRY_PACKAGE,
    instrumentWeights: {
      [OKX_BTC_USDT_SPOT]: DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER,
      [OKX_BTC_USDT_SWAP]: -1,
    },
    description: "One BTC funding carry package: long ctVal BTC spot and short one BTC-USDT-SWAP contract",
    active: true,
  },
]);

export function decomposeTradeIncrement(
  dqContracts: number,
  residualReason: string | null = null
): BasisDecomposition {
  if (residualReason) {
    return {
      basisId: null,
      strategyWeight: 0,
      basisDqContracts: 0,
      residualDqContracts: dqContracts,
      residualReasonCode: asResidualReasonCode(residualReason),
    };
  }
  if (Math.abs(dqContracts) <= 1e-12) {
    return {
      basisId: null,
      strategyWeight: 0,
      basisDqContracts: 0,
      residualDqContracts: 0,
      residualReasonCode: null,
    };
  }
  return {
    basisId: BASIS_LONG_BTC_SWAP,
    strategyWeight: dqContracts,
    basisDqContracts: dqContracts,
    residualDqContracts: 0,
    residualReasonCode: null,
  };
}

export function toResidualPosition(dqContracts: number, reasonCode: string): ResidualPosition {
  return {
    instrumentId: OKX_BTC_USDT_SWAP,
    quantity: dqContracts,
    reasonCode: asResidualReasonCode(reasonCode),
  };
}

export function basisExplainsTradeExactly(
  dqContracts: number,
  decomposition: BasisDecomposition,
  tolerance = 1e-9,
): boolean {
  return Math.abs(dqContracts - decomposition.basisDqContracts - decomposition.residualDqContracts) <= tolerance;
}

export function buildTradeLedgerEntry(
  instrumentId: InstrumentId,
  route: DecisionRoute,
  dq: number,
  decomposition: BasisDecomposition,
): TradeLedgerEntry {
  return {
    instrumentId,
    route,
    dq,
    basisId: decomposition.basisId,
    strategyWeight: decomposition.strategyWeight,
    basisDq: decomposition.basisDqContracts,
    residualDq: decomposition.residualDqContracts,
    residualReasonCode: decomposition.residualReasonCode,
    explainsDqExactly: basisExplainsTradeExactly(dq, decomposition),
  };
}

export function buildInstrumentTradeLedgerEntry(input: {
  readonly instrumentId: InstrumentId;
  readonly route: DecisionRoute;
  readonly dq: number;
  readonly basisId: typeof BASIS_BTC_FUNDING_CARRY_PACKAGE | typeof BASIS_LONG_BTC_SWAP | null;
  readonly strategyWeight: number;
  readonly basisDq: number;
  readonly residualDq: number;
  readonly residualReasonCode: string | null;
}): TradeLedgerEntry {
  return {
    instrumentId: input.instrumentId,
    route: input.route,
    dq: input.dq,
    basisId: input.basisId,
    strategyWeight: input.strategyWeight,
    basisDq: input.basisDq,
    residualDq: input.residualDq,
    residualReasonCode: input.residualReasonCode === null ? null : asResidualReasonCode(input.residualReasonCode),
    explainsDqExactly: Math.abs(input.dq - input.basisDq - input.residualDq) <= 1e-9,
  };
}

export function buildFundingCarryPackageLedger(input: {
  readonly spotDqBtc: number;
  readonly swapDqContracts: number;
  readonly contractMultiplier?: number;
  readonly spotRoute: DecisionRoute;
  readonly swapRoute: DecisionRoute;
  readonly spotResidualReasonCode?: string;
  readonly swapResidualReasonCode?: string;
}): TradePackageLedger {
  const contractMultiplier =
    input.contractMultiplier && Number.isFinite(input.contractMultiplier) && input.contractMultiplier > 0
      ? input.contractMultiplier
      : DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER;

  const longCarryWeight = Math.min(
    Math.max(0, input.spotDqBtc / contractMultiplier),
    Math.max(0, -input.swapDqContracts),
  );
  const shortCarryWeight = Math.min(
    Math.max(0, -input.spotDqBtc / contractMultiplier),
    Math.max(0, input.swapDqContracts),
  );
  const strategyWeight = longCarryWeight >= shortCarryWeight ? longCarryWeight : -shortCarryWeight;

  const spotBasisDq = strategyWeight * contractMultiplier;
  const swapBasisDq = -strategyWeight;
  const spotResidualDq = input.spotDqBtc - spotBasisDq;
  const swapResidualDq = input.swapDqContracts - swapBasisDq;

  const residualLedger = collapseResidualPositions([
    Math.abs(spotResidualDq) <= 1e-12
      ? null
      : {
          instrumentId: OKX_BTC_USDT_SPOT,
          quantity: spotResidualDq,
          reasonCode: asResidualReasonCode(input.spotResidualReasonCode ?? "FUNDING_ARB_SPOT_RESIDUAL"),
        },
    Math.abs(swapResidualDq) <= 1e-12
      ? null
      : {
          instrumentId: OKX_BTC_USDT_SWAP,
          quantity: swapResidualDq,
          reasonCode: asResidualReasonCode(input.swapResidualReasonCode ?? "FUNDING_ARB_SWAP_RESIDUAL"),
        },
  ].filter((row): row is ResidualPosition => row !== null));

  const legs = [
    buildInstrumentTradeLedgerEntry({
      instrumentId: OKX_BTC_USDT_SPOT,
      route: input.spotRoute,
      dq: input.spotDqBtc,
      basisId: Math.abs(strategyWeight) > 1e-12 ? BASIS_BTC_FUNDING_CARRY_PACKAGE : null,
      strategyWeight,
      basisDq: spotBasisDq,
      residualDq: spotResidualDq,
      residualReasonCode: Math.abs(spotResidualDq) <= 1e-12
        ? null
        : (input.spotResidualReasonCode ?? "FUNDING_ARB_SPOT_RESIDUAL"),
    }),
    buildInstrumentTradeLedgerEntry({
      instrumentId: OKX_BTC_USDT_SWAP,
      route: input.swapRoute,
      dq: input.swapDqContracts,
      basisId: Math.abs(strategyWeight) > 1e-12 ? BASIS_BTC_FUNDING_CARRY_PACKAGE : null,
      strategyWeight,
      basisDq: swapBasisDq,
      residualDq: swapResidualDq,
      residualReasonCode: Math.abs(swapResidualDq) <= 1e-12
        ? null
        : (input.swapResidualReasonCode ?? "FUNDING_ARB_SWAP_RESIDUAL"),
    }),
  ] as const;

  return {
    basisId: Math.abs(strategyWeight) > 1e-12 ? BASIS_BTC_FUNDING_CARRY_PACKAGE : null,
    strategyWeight,
    legs,
    residualLedger,
    residualSummary: summarizeResidualLedger(residualLedger),
    explainsPackageExactly: legs.every((leg) => leg.explainsDqExactly),
  };
}
