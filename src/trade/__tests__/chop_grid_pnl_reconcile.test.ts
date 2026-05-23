import test from "node:test";
import assert from "node:assert/strict";

import {
  expectedGridGrossPnl,
  impliedContractValue,
  maybeCorrectLegacyRoundTrip,
  summarizeReconciledRoundTrips,
} from "../chop_grid_pnl_reconcile.js";

test("grid gross PnL uses swap ctVal", () => {
  assert.equal(expectedGridGrossPnl(1, 77_274.5, 78_439.4, 0.01), 11.648999999999942);
});

test("legacy unscaled roundtrip is corrected while preserving actual fee", () => {
  const row = {
    id: 46,
    matched_qty: 1,
    buy_vwap: 77_274.5,
    sell_px: 78_439.4,
    gross_pnl: 1_164.8999999999942,
    fee: 0.3114278,
    net_pnl: 1_164.5885721999941,
    fee_ratio: 0.0002673464,
  };

  assert.equal(impliedContractValue(row), 1);
  const correction = maybeCorrectLegacyRoundTrip(row, 0.01);

  assert.ok(correction);
  assert.equal(correction.id, 46);
  assert.equal(Number(correction.correctedGrossPnl.toFixed(6)), 11.649);
  assert.equal(Number(correction.correctedNetPnl.toFixed(6)), 11.337572);
  assert.equal(Number((correction.correctedFeeRatio ?? 0).toFixed(6)), 0.026734);
});

test("already scaled roundtrip is left unchanged", () => {
  const row = {
    id: 177,
    matched_qty: 12,
    buy_vwap: 74_700.29733333334,
    sell_px: 74_720.3,
    gross_pnl: 2.400320000000033,
    fee: 6.72422692,
    net_pnl: -4.323906919999967,
    fee_ratio: 2.8013876983068537,
  };

  assert.equal(Number((impliedContractValue(row) ?? 0).toFixed(2)), 0.01);
  assert.equal(maybeCorrectLegacyRoundTrip(row, 0.01), null);
});

test("reconciled totals use corrected gross and unchanged fees", () => {
  const legacy = {
    id: 1,
    matched_qty: 1,
    buy_vwap: 100,
    sell_px: 200,
    gross_pnl: 100,
    fee: 1,
    net_pnl: 99,
    fee_ratio: 0.01,
  };
  const current = {
    id: 2,
    matched_qty: 1,
    buy_vwap: 100,
    sell_px: 110,
    gross_pnl: 0.1,
    fee: 0.2,
    net_pnl: -0.1,
    fee_ratio: 2,
  };
  const correction = maybeCorrectLegacyRoundTrip(legacy, 0.01);
  assert.ok(correction);
  const totals = summarizeReconciledRoundTrips(
    [legacy, current],
    new Map([[correction.id, correction]]),
  );

  assert.equal(totals.roundTripCount, 2);
  assert.equal(totals.winCount, 1);
  assert.equal(totals.lossCount, 1);
  assert.equal(Number(totals.grossPnl.toFixed(6)), 1.1);
  assert.equal(Number(totals.fee.toFixed(6)), 1.2);
  assert.equal(Number(totals.netPnl.toFixed(6)), -0.1);
});
