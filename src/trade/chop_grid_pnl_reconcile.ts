export interface ChopGridRoundTripForReconcile {
  readonly id: number;
  readonly matched_qty: number;
  readonly buy_vwap: number;
  readonly sell_px: number;
  readonly gross_pnl: number;
  readonly fee: number;
  readonly net_pnl: number;
  readonly fee_ratio: number | null;
}

export interface ChopGridRoundTripCorrection {
  readonly id: number;
  readonly impliedCtVal: number | null;
  readonly correctedGrossPnl: number;
  readonly correctedNetPnl: number;
  readonly correctedFeeRatio: number | null;
}

export interface ChopGridReconciledTotals {
  readonly roundTripCount: number;
  readonly winCount: number;
  readonly lossCount: number;
  readonly grossPnl: number;
  readonly fee: number;
  readonly netPnl: number;
  readonly feeRatioTotal: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function expectedGridGrossPnl(
  matchedQty: number,
  buyVwap: number,
  sellPx: number,
  contractValue: number,
): number {
  return (sellPx - buyVwap) * matchedQty * contractValue;
}

export function impliedContractValue(row: ChopGridRoundTripForReconcile): number | null {
  const matchedQty = finiteNumber(row.matched_qty);
  const buyVwap = finiteNumber(row.buy_vwap);
  const sellPx = finiteNumber(row.sell_px);
  const grossPnl = finiteNumber(row.gross_pnl);
  if (matchedQty === null || buyVwap === null || sellPx === null || grossPnl === null) return null;
  const priceDelta = Math.abs(sellPx - buyVwap);
  if (!(matchedQty > 0) || !(priceDelta > 0)) return null;
  return Math.abs(grossPnl) / (matchedQty * priceDelta);
}

export function maybeCorrectLegacyRoundTrip(
  row: ChopGridRoundTripForReconcile,
  contractValue: number,
): ChopGridRoundTripCorrection | null {
  const impliedCtVal = impliedContractValue(row);
  if (impliedCtVal === null) return null;

  const legacyLooksUnscaled = impliedCtVal > contractValue * 10;
  if (!legacyLooksUnscaled) return null;

  const correctedGrossPnl = expectedGridGrossPnl(
    row.matched_qty,
    row.buy_vwap,
    row.sell_px,
    contractValue,
  );
  const correctedNetPnl = correctedGrossPnl - row.fee;
  const correctedFeeRatio = correctedGrossPnl > 0 ? row.fee / correctedGrossPnl : null;

  return {
    id: row.id,
    impliedCtVal,
    correctedGrossPnl,
    correctedNetPnl,
    correctedFeeRatio,
  };
}

export function summarizeReconciledRoundTrips(
  rows: readonly ChopGridRoundTripForReconcile[],
  corrections: ReadonlyMap<number, ChopGridRoundTripCorrection>,
): ChopGridReconciledTotals {
  let roundTripCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let grossPnl = 0;
  let fee = 0;
  let netPnl = 0;
  let feeRatioTotal = 0;

  for (const row of rows) {
    const correction = corrections.get(row.id);
    const rowGrossPnl = correction?.correctedGrossPnl ?? row.gross_pnl;
    const rowNetPnl = correction?.correctedNetPnl ?? row.net_pnl;
    const rowFeeRatio = correction ? correction.correctedFeeRatio : row.fee_ratio;

    roundTripCount += 1;
    grossPnl += rowGrossPnl;
    fee += row.fee;
    netPnl += rowNetPnl;
    if (rowNetPnl >= 0) {
      winCount += 1;
    } else {
      lossCount += 1;
    }
    if (rowFeeRatio !== null && Number.isFinite(rowFeeRatio)) {
      feeRatioTotal += rowFeeRatio;
    }
  }

  return {
    roundTripCount,
    winCount,
    lossCount,
    grossPnl,
    fee,
    netPnl,
    feeRatioTotal,
  };
}
