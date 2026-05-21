import { asResidualReasonCode } from "./ids.js";
import type { InstrumentId } from "./ids.js";
import type { ResidualLedgerSummary, ResidualPosition } from "./portfolio_types.js";

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

export function buildResidualPositionFromCode(
  instrumentId: InstrumentId,
  quantity: number,
  reasonCode: string,
): ResidualPosition {
  return {
    instrumentId,
    quantity,
    reasonCode: asResidualReasonCode(reasonCode),
  };
}

export function residualGross(positions: readonly ResidualPosition[]): number {
  return positions.reduce((sum, row) => sum + Math.abs(row.quantity), 0);
}

function collapseByInstrument(positions: readonly ResidualPosition[]): Readonly<Record<InstrumentId, number>> {
  const out = {} as Record<InstrumentId, number>;
  for (const position of positions) {
    out[position.instrumentId] = (out[position.instrumentId] ?? 0) + position.quantity;
  }
  return out;
}

function collapseByReasonCode(
  positions: readonly ResidualPosition[],
): Readonly<Record<(typeof positions)[number]["reasonCode"], number>> {
  const out = {} as Record<(typeof positions)[number]["reasonCode"], number>;
  for (const position of positions) {
    out[position.reasonCode] = (out[position.reasonCode] ?? 0) + position.quantity;
  }
  return out;
}

export function collapseResidualPositions(positions: readonly ResidualPosition[]): readonly ResidualPosition[] {
  const collapsed = new Map<string, ResidualPosition>();
  for (const position of positions) {
    const key = `${position.instrumentId}::${position.reasonCode}`;
    const existing = collapsed.get(key);
    collapsed.set(key, {
      instrumentId: position.instrumentId,
      reasonCode: position.reasonCode,
      quantity: (existing?.quantity ?? 0) + position.quantity,
    });
  }
  return Array.from(collapsed.values()).filter((row) => Math.abs(row.quantity) > 1e-12);
}

export function residualNet(positions: readonly ResidualPosition[]): number {
  return positions.reduce((sum, row) => sum + row.quantity, 0);
}

export function summarizeResidualLedger(positions: readonly ResidualPosition[]): ResidualLedgerSummary {
  const collapsed = collapseResidualPositions(positions);
  return {
    rowCount: collapsed.length,
    grossQuantity: residualGross(collapsed),
    netQuantity: residualNet(collapsed),
    byInstrument: collapseByInstrument(collapsed),
    byReasonCode: collapseByReasonCode(collapsed),
  };
}
