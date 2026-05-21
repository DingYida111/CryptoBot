import { asStrategyBasisId } from "./ids.js";
import type {
  BasisDecomposition,
  DecisionRoute,
  ResidualPosition,
  StrategyBasisSpec,
  TradeLedgerEntry,
} from "./portfolio_types.js";
import { asResidualReasonCode } from "./ids.js";
import { OKX_BTC_USDT_SWAP } from "./instrument_spec.js";

export const BASIS_LONG_BTC_SWAP = asStrategyBasisId("basis:long_btc_swap");

export const STRATEGY_BASIS_SPECS: readonly StrategyBasisSpec[] = Object.freeze([
  {
    basisId: BASIS_LONG_BTC_SWAP,
    instrumentWeights: {
      [OKX_BTC_USDT_SWAP]: 1,
    },
    description: "One standard BTC-USDT-SWAP contract as the canonical V1 basis direction",
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
  route: DecisionRoute,
  dqContracts: number,
  decomposition: BasisDecomposition,
): TradeLedgerEntry {
  return {
    route,
    dqContracts,
    basisId: decomposition.basisId,
    strategyWeight: decomposition.strategyWeight,
    basisDqContracts: decomposition.basisDqContracts,
    residualDqContracts: decomposition.residualDqContracts,
    residualReasonCode: decomposition.residualReasonCode,
    explainsDqExactly: basisExplainsTradeExactly(dqContracts, decomposition),
  };
}
