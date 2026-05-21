import { decomposeTradeIncrement } from "./basis.js";
import { DecisionIntentSchema } from "./schemas/exposure_schema.js";
import type { BasisDecomposition, DecisionIntent } from "./portfolio_types.js";

export interface OptimizerStubInput {
  readonly currentContracts: number;
  readonly currentSide: "long" | "short" | null;
  readonly hasPosition: boolean;
  readonly isGridPosition: boolean;
  readonly signalDirection: "up" | "down" | "none";
  readonly signalRegime: "TREND_UP" | "TREND_DOWN" | "RANGE" | "CHOP" | "NONE";
  readonly recommendedOpenContracts: number;
  readonly shouldCloseForExit: boolean;
  readonly shouldPartialClose: boolean;
  readonly partialCloseContracts: number;
  readonly shouldEnterGrid: boolean;
  readonly shouldExitGrid: boolean;
  readonly reason: string;
}

function makeDecisionIntent(
  mode: DecisionIntent["mode"],
  route: DecisionIntent["route"],
  proposedDqContracts: number,
  basis: BasisDecomposition,
  reason: string,
  metadata: Readonly<Record<string, string | number | boolean>> = {}
): DecisionIntent {
  return DecisionIntentSchema.parse({
    mode,
    route,
    proposedDqContracts,
    basis,
    reason,
    metadata,
  });
}

export function runOptimizerStub(input: OptimizerStubInput): DecisionIntent {
  if (input.shouldExitGrid && input.currentContracts > 0) {
    const dq = -Math.abs(input.currentContracts);
    return makeDecisionIntent("grid", "grid_exit", dq, decomposeTradeIncrement(dq), input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.shouldEnterGrid && !input.hasPosition) {
    const dq = Math.max(0, input.recommendedOpenContracts);
    return makeDecisionIntent("grid", dq > 0 ? "grid_seed" : "grid_hold", dq, decomposeTradeIncrement(dq), input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.isGridPosition) {
    return makeDecisionIntent("grid", "grid_hold", 0, decomposeTradeIncrement(0), input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.shouldCloseForExit && input.currentContracts !== 0 && input.currentSide !== null) {
    const dq = -input.currentContracts;
    return makeDecisionIntent(
      "trade",
      input.currentSide === "long" ? "close_long" : "close_short",
      dq,
      decomposeTradeIncrement(dq),
      input.reason
    );
  }

  if (input.shouldPartialClose && input.partialCloseContracts > 0 && input.currentSide !== null) {
    const dq = input.currentSide === "long" ? -input.partialCloseContracts : input.partialCloseContracts;
    return makeDecisionIntent(
      "trade",
      input.currentSide === "long" ? "partial_close_long" : "partial_close_short",
      dq,
      decomposeTradeIncrement(dq),
      input.reason
    );
  }

  if (!input.hasPosition && !input.isGridPosition) {
    if (input.signalDirection === "up" && input.recommendedOpenContracts > 0) {
      const dq = input.recommendedOpenContracts;
      return makeDecisionIntent("trade", "open_long", dq, decomposeTradeIncrement(dq), input.reason);
    }
    if (input.signalDirection === "down" && input.recommendedOpenContracts > 0) {
      const dq = -input.recommendedOpenContracts;
      return makeDecisionIntent("trade", "open_short", dq, decomposeTradeIncrement(dq), input.reason);
    }
  }

  return makeDecisionIntent("hold", "noop", 0, decomposeTradeIncrement(0), input.reason, {
    regime: input.signalRegime,
  });
}
