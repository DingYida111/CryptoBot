import test from "node:test";
import assert from "node:assert/strict";

import { buildFundingCarryPackageLedger, buildTradeLedgerEntry, decomposeTradeIncrement } from "../basis.js";
import { OKX_BTC_USDT_SPOT, OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildPortfolioState } from "../portfolio_state.js";
import { buildResidualPositionFromCode, collapseResidualPositions, summarizeResidualLedger } from "../residual.js";

function assertApprox(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("trade ledger entry proves dq = Bw + r identity", () => {
  const decomposition = decomposeTradeIncrement(-3);
  const ledger = buildTradeLedgerEntry(OKX_BTC_USDT_SWAP, "close_long", -3, decomposition);

  assert.equal(ledger.explainsDqExactly, true);
  assert.equal(ledger.basisDq + ledger.residualDq, -3);
});

test("collapsed residual ledger preserves totals by instrument and reason", () => {
  const rows = collapseResidualPositions([
    buildResidualPositionFromCode(OKX_BTC_USDT_SWAP, 2, "PARTIAL_FILL"),
    buildResidualPositionFromCode(OKX_BTC_USDT_SWAP, -0.5, "PARTIAL_FILL"),
    buildResidualPositionFromCode(OKX_BTC_USDT_SWAP, 1, "FEE_DRIFT"),
  ]);

  assert.equal(rows.length, 2);
  const partial = rows.find((row) => row.reasonCode === "PARTIAL_FILL");
  const fee = rows.find((row) => row.reasonCode === "FEE_DRIFT");
  assert.equal(partial?.quantity, 1.5);
  assert.equal(fee?.quantity, 1);
});

test("portfolio state keeps residual ledger and summary together", () => {
  const residualRows = [
    buildResidualPositionFromCode(OKX_BTC_USDT_SWAP, 1.5, "PARTIAL_FILL"),
    buildResidualPositionFromCode(OKX_BTC_USDT_SWAP, -0.25, "FEE_DRIFT"),
  ];
  const summary = summarizeResidualLedger(residualRows);
  const state = buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    residualPositions: residualRows,
    metadata: {},
  });

  assert.equal(state.residualLedger.length, 2);
  assert.equal(state.residualSummary.rowCount, summary.rowCount);
  assert.equal(state.residualSummary.grossQuantity, 1.75);
  assert.equal(state.residualSummary.netQuantity, 1.25);
  assert.equal(state.residualPositions[OKX_BTC_USDT_SWAP], 1.25);
});

test("funding carry package ledger explains aligned two-leg trades exactly", () => {
  const ledger = buildFundingCarryPackageLedger({
    spotDqBtc: 0.03,
    swapDqContracts: -3,
    contractMultiplier: 0.01,
    spotRoute: "open_long",
    swapRoute: "open_short",
  });

  assert.equal(ledger.basisId, "basis:btc_funding_carry_package");
  assertApprox(ledger.strategyWeight, 3);
  assert.equal(ledger.explainsPackageExactly, true);
  assert.equal(ledger.residualSummary.rowCount, 0);
  assert.deepEqual(ledger.legs.map((leg) => leg.instrumentId), [OKX_BTC_USDT_SPOT, OKX_BTC_USDT_SWAP]);
});

test("funding carry package ledger isolates spot rounding residual", () => {
  const ledger = buildFundingCarryPackageLedger({
    spotDqBtc: 0.0295,
    swapDqContracts: -3,
    contractMultiplier: 0.01,
    spotRoute: "open_long",
    swapRoute: "open_short",
  });

  assertApprox(ledger.strategyWeight, 2.95);
  assert.equal(ledger.explainsPackageExactly, true);
  assert.equal(ledger.residualSummary.rowCount, 1);
  assertApprox(ledger.residualSummary.byInstrument[OKX_BTC_USDT_SWAP] ?? 0, -0.05);
});
