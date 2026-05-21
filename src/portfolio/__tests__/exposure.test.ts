import test from "node:test";
import assert from "node:assert/strict";
import { computeDeltaPnl, computeExposure, computeUsdNotional, toInstrumentSpecMap } from "../exposure.js";
import { buildBtcSwapInstrumentSpec } from "../instrument_spec.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { runOptimizerStub } from "../optimizer_stub.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX, USDT_CASH } from "../security_spec.js";
import { listActiveSecuritySpecs } from "../security_spec.js";
import { InstrumentSpecSchema } from "../schemas/instrument_schema.js";
import { SecuritySpecSchema } from "../schemas/security_schema.js";

test("one contract exposure equals 0.01 BTC delta and funding placeholder", () => {
  const specs = [buildBtcSwapInstrumentSpec()];
  const rows = computeExposure(
    [{ instrumentId: OKX_BTC_USDT_SWAP, quantity: 1 }],
    toInstrumentSpecMap(specs)
  );
  const byId = Object.fromEntries(rows.map((row) => [row.securityId, row.quantity]));
  assert.equal(byId[BTC_DELTA], 0.01);
  assert.equal(byId[BTC_PERP_FUNDING_OKX], 0.01);
  assert.equal(byId[USDT_CASH] ?? 0, 0);
});

test("signed exposure tracks short positions", () => {
  const specs = [buildBtcSwapInstrumentSpec()];
  const rows = computeExposure(
    [{ instrumentId: OKX_BTC_USDT_SWAP, quantity: -4 }],
    toInstrumentSpecMap(specs)
  );
  const byId = Object.fromEntries(rows.map((row) => [row.securityId, row.quantity]));
  assert.equal(byId[BTC_DELTA], -0.04);
  assert.equal(byId[BTC_PERP_FUNDING_OKX], -0.04);
});

test("usd notional matches contract arithmetic", () => {
  const rows = computeExposure(
    [{ instrumentId: OKX_BTC_USDT_SWAP, quantity: 3 }],
    toInstrumentSpecMap([buildBtcSwapInstrumentSpec()])
  );
  const notional = computeUsdNotional(rows, {
    [BTC_DELTA]: 100000,
  });
  assert.equal(notional, 3000);
});

test("delta pnl matches manual contract arithmetic", () => {
  const rows = computeExposure(
    [{ instrumentId: OKX_BTC_USDT_SWAP, quantity: 5 }],
    toInstrumentSpecMap([buildBtcSwapInstrumentSpec()])
  );
  const pnl = computeDeltaPnl(rows, {
    [BTC_DELTA]: 1000,
  });
  assert.equal(pnl, 50);
});

test("registry schemas validate active specs", () => {
  for (const spec of listActiveSecuritySpecs()) {
    assert.doesNotThrow(() => SecuritySpecSchema.parse(spec));
  }
  assert.doesNotThrow(() => InstrumentSpecSchema.parse(buildBtcSwapInstrumentSpec()));
});

test("optimizer stub prioritizes full close over partial close", () => {
  const intent = runOptimizerStub({
    currentContracts: 5,
    currentSide: "long",
    hasPosition: true,
    isGridPosition: false,
    signalDirection: "none",
    signalRegime: "TREND_DOWN",
    recommendedOpenContracts: 0,
    shouldCloseForExit: true,
    shouldPartialClose: true,
    partialCloseContracts: 1,
    shouldEnterGrid: false,
    shouldExitGrid: false,
    reason: "test_close_priority",
  });
  assert.equal(intent.route, "close_long");
  assert.equal(intent.proposedDqContracts, -5);
});

test("optimizer stub seeds grid in chop regime", () => {
  const intent = runOptimizerStub({
    currentContracts: 0,
    currentSide: null,
    hasPosition: false,
    isGridPosition: false,
    signalDirection: "none",
    signalRegime: "CHOP",
    recommendedOpenContracts: 6,
    shouldCloseForExit: false,
    shouldPartialClose: false,
    partialCloseContracts: 0,
    shouldEnterGrid: true,
    shouldExitGrid: false,
    reason: "test_grid_seed",
  });
  assert.equal(intent.route, "grid_seed");
  assert.equal(intent.proposedDqContracts, 6);
});
