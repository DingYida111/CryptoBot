import { getDb } from "../monitor/storage.js";
import {
  maybeCorrectLegacyRoundTrip,
  summarizeReconciledRoundTrips,
  type ChopGridRoundTripCorrection,
  type ChopGridRoundTripForReconcile,
} from "./chop_grid_pnl_reconcile.js";

const DEFAULT_CONTRACT_VALUE = 0.01;
const INST_ID = "BTC-USDT-SWAP";

interface CliOptions {
  readonly apply: boolean;
  readonly instId: string;
  readonly contractValue: number;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let apply = false;
  let instId = process.env.CHOP_GRID_RECONCILE_INST_ID ?? INST_ID;
  let contractValue = positiveNumber(process.env.CHOP_GRID_RECONCILE_CT_VAL, DEFAULT_CONTRACT_VALUE);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--inst-id" && argv[index + 1]) {
      instId = argv[index + 1] ?? instId;
      index += 1;
      continue;
    }
    if (arg === "--ct-val" && argv[index + 1]) {
      contractValue = positiveNumber(argv[index + 1], contractValue);
      index += 1;
    }
  }

  return { apply, instId, contractValue };
}

function loadRoundTrips(instId: string): ChopGridRoundTripForReconcile[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, matched_qty, buy_vwap, sell_px, gross_pnl, fee, net_pnl, fee_ratio
    FROM chop_grid_roundtrips
    WHERE inst_id = ?
    ORDER BY id ASC
  `).all(instId) as ChopGridRoundTripForReconcile[];
}

function applyCorrections(
  instId: string,
  corrections: readonly ChopGridRoundTripCorrection[],
  totals: ReturnType<typeof summarizeReconciledRoundTrips>,
): void {
  const db = getDb();
  const updateRoundTrip = db.prepare(`
    UPDATE chop_grid_roundtrips
    SET gross_pnl = ?, net_pnl = ?, fee_ratio = ?
    WHERE id = ?
  `);
  const updateState = db.prepare(`
    UPDATE chop_grid_state
    SET
      round_trip_count = ?,
      win_count = ?,
      loss_count = ?,
      gross_pnl = ?,
      fee_total = ?,
      net_pnl = ?,
      fee_ratio_total = ?,
      updated_at = ?
    WHERE inst_id = ?
  `);

  const transaction = db.transaction(() => {
    for (const correction of corrections) {
      updateRoundTrip.run(
        correction.correctedGrossPnl,
        correction.correctedNetPnl,
        correction.correctedFeeRatio,
        correction.id,
      );
    }
    updateState.run(
      totals.roundTripCount,
      totals.winCount,
      totals.lossCount,
      totals.grossPnl,
      totals.fee,
      totals.netPnl,
      totals.feeRatioTotal,
      Date.now(),
      instId,
    );
  });
  transaction();
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const rows = loadRoundTrips(options.instId);
  const corrections = rows
    .map((row) => maybeCorrectLegacyRoundTrip(row, options.contractValue))
    .filter((row): row is ChopGridRoundTripCorrection => row !== null);
  const correctionMap = new Map(corrections.map((row) => [row.id, row]));
  const before = summarizeReconciledRoundTrips(rows, new Map());
  const after = summarizeReconciledRoundTrips(rows, correctionMap);

  if (options.apply && corrections.length > 0) {
    applyCorrections(options.instId, corrections, after);
  }

  console.log(JSON.stringify({
    phase: "chop_grid_pnl_reconcile",
    mode: options.apply ? "apply" : "dry_run",
    instId: options.instId,
    contractValue: options.contractValue,
    rowCount: rows.length,
    correctionCount: corrections.length,
    before,
    after,
    delta: {
      grossPnl: after.grossPnl - before.grossPnl,
      netPnl: after.netPnl - before.netPnl,
      winCount: after.winCount - before.winCount,
      lossCount: after.lossCount - before.lossCount,
    },
    sampleCorrections: corrections.slice(0, 10),
  }, null, 2));
}

main();
