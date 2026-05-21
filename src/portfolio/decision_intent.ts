import { decomposeTradeIncrement } from "./basis.js";
import { DecisionIntentSchema } from "./schemas/exposure_schema.js";
import type { DecisionIntent, DecisionRoute } from "./portfolio_types.js";

export function buildDecisionIntent(
  mode: DecisionIntent["mode"],
  route: DecisionRoute,
  proposedDqContracts: number,
  reason: string,
  metadata: Readonly<Record<string, string | number | boolean>> = {}
): DecisionIntent {
  return DecisionIntentSchema.parse({
    mode,
    route,
    proposedDqContracts,
    basis: decomposeTradeIncrement(proposedDqContracts),
    reason,
    metadata,
  });
}
