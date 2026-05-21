import test from "node:test";
import assert from "node:assert/strict";

import { buildTradeLedgerEntry, decomposeTradeIncrement } from "../basis.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildPortfolioState } from "../portfolio_state.js";
import { buildResidualPositionFromCode, collapseResidualPositions, summarizeResidualLedger } from "../residual.js";

test("trade ledger entry proves dq = Bw + r identity", () => {
  const decomposition = decomposeTradeIncrement(-3);
  const ledger = buildTradeLedgerEntry("close_long", -3, decomposition);

  assert.equal(ledger.explainsDqExactly, true);
  assert.equal(ledger.basisDqContracts + ledger.residualDqContracts, -3);
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
