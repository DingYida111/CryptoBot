import { buildDecisionIntent } from "./decision_intent.js";
import type { DecisionIntent } from "./portfolio_types.js";

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

export function runOptimizerStub(input: OptimizerStubInput): DecisionIntent {
  if (input.shouldExitGrid && input.currentContracts > 0) {
    const dq = -Math.abs(input.currentContracts);
    return buildDecisionIntent("grid", "grid_exit", dq, input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.shouldEnterGrid && !input.hasPosition) {
    const dq = Math.max(0, input.recommendedOpenContracts);
    return buildDecisionIntent("grid", dq > 0 ? "grid_seed" : "grid_hold", dq, input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.isGridPosition) {
    return buildDecisionIntent("grid", "grid_hold", 0, input.reason, {
      regime: input.signalRegime,
    });
  }

  if (input.shouldCloseForExit && input.currentContracts !== 0 && input.currentSide !== null) {
    const dq = -input.currentContracts;
    return buildDecisionIntent(
      "trade",
      input.currentSide === "long" ? "close_long" : "close_short",
      dq,
      input.reason
    );
  }

  if (input.shouldPartialClose && input.partialCloseContracts > 0 && input.currentSide !== null) {
    const dq = input.currentSide === "long" ? -input.partialCloseContracts : input.partialCloseContracts;
    return buildDecisionIntent(
      "trade",
      input.currentSide === "long" ? "partial_close_long" : "partial_close_short",
      dq,
      input.reason
    );
  }

  if (!input.hasPosition && !input.isGridPosition) {
    if (input.signalDirection === "up" && input.recommendedOpenContracts > 0) {
      const dq = input.recommendedOpenContracts;
      return buildDecisionIntent("trade", "open_long", dq, input.reason);
    }
    if (input.signalDirection === "down" && input.recommendedOpenContracts > 0) {
      const dq = -input.recommendedOpenContracts;
      return buildDecisionIntent("trade", "open_short", dq, input.reason);
    }
  }

  return buildDecisionIntent("hold", "noop", 0, input.reason, {
    regime: input.signalRegime,
  });
}
