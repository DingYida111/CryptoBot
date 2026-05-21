import type { OptimizationRequest, PortfolioState, StrategyBasisSpec } from "./portfolio_types.js";
import type { SecurityId, StrategyBasisId, StrategyId, InstrumentId } from "./ids.js";

export function buildOptimizationRequest(input: {
  portfolioState: PortfolioState;
  enabledStrategies?: readonly StrategyId[];
  basisSpecs?: readonly StrategyBasisSpec[];
  objectiveScores?: Readonly<Record<string, number>>;
  instrumentBounds?: Readonly<Record<InstrumentId, readonly [number, number]>>;
  securityBounds?: Readonly<Record<SecurityId, readonly [number, number]>>;
}): OptimizationRequest {
  return {
    portfolioState: input.portfolioState,
    enabledStrategies: input.enabledStrategies ?? [],
    basisIds: (input.basisSpecs ?? []).map((spec) => spec.basisId) as readonly StrategyBasisId[],
    objectiveScores: input.objectiveScores ?? {},
    instrumentBounds: input.instrumentBounds ?? {},
    securityBounds: input.securityBounds ?? {},
  };
}
