import { asResidualReasonCode } from "./ids.js";
import type { InstrumentId } from "./ids.js";
import type { ResidualPosition } from "./portfolio_types.js";

export const RESIDUAL_REASON_CODES = Object.freeze({
  MANUAL_OVERRIDE: asResidualReasonCode("MANUAL_OVERRIDE"),
  EMERGENCY_FLATTEN: asResidualReasonCode("EMERGENCY_FLATTEN"),
  LOT_ROUNDING: asResidualReasonCode("LOT_ROUNDING"),
  PARTIAL_FILL: asResidualReasonCode("PARTIAL_FILL"),
  FEE_DRIFT: asResidualReasonCode("FEE_DRIFT"),
  FUNDING_DRIFT: asResidualReasonCode("FUNDING_DRIFT"),
  STATE_RECONCILIATION: asResidualReasonCode("STATE_RECONCILIATION"),
  UNROUTED_DECISION: asResidualReasonCode("UNROUTED_DECISION"),
});

export function buildResidualPosition(
  instrumentId: InstrumentId,
  quantity: number,
  reasonCode: keyof typeof RESIDUAL_REASON_CODES
): ResidualPosition {
  return {
    instrumentId,
    quantity,
    reasonCode: RESIDUAL_REASON_CODES[reasonCode],
  };
}

export function residualGross(positions: readonly ResidualPosition[]): number {
  return positions.reduce((sum, row) => sum + Math.abs(row.quantity), 0);
}
