import test from "node:test";
import assert from "node:assert/strict";

import { OKX_BTC_USDT_SPOT, OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import {
  buildPortfolioStateFromFundingArb,
  fundingArbPositionsToInstrumentPositions,
} from "../adapters/funding_arbitrage_adapter.js";

test("funding arb positions map spot long and perp short into instrument rows", () => {
  const rows = fundingArbPositionsToInstrumentPositions({
    spotBtc: 0.01,
    shortContracts: 3,
  });

  assert.deepEqual(rows, [
    {
      instrumentId: OKX_BTC_USDT_SPOT,
      quantity: 0.01,
    },
    {
      instrumentId: OKX_BTC_USDT_SWAP,
      quantity: -3,
    },
  ]);
});

test("funding arb portfolio state carries zero residual summary metadata by default", () => {
  const state = buildPortfolioStateFromFundingArb({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    cashBalances: { USDT: 1000 },
    metadata: {
      phase: "idle",
      lastReason: "test",
      paperExecute: false,
      spotInstId: "BTC-USDT",
      perpInstId: "BTC-USDT-SWAP",
      currentSpotBtc: 0,
      currentShortContracts: 0,
      currentShortBtc: 0,
      netDeltaBtc: 0,
      fundingRate: 0,
      nextFundingTimeMs: 0,
      basisBps: 0,
      basisUsd: 0,
      netCarryEdgeUsd: 0,
      expectedFundingUsd: 0,
      expectedFeesUsd: 0,
      expectedSlippageUsd: 0,
      expectedBasisRiskBufferUsd: 0,
      entryWindowOpen: false,
      shouldEnter: false,
      forceValidationEntry: false,
    },
  });

  assert.equal(state.residualLedger.length, 0);
  assert.equal(state.residualSummary.rowCount, 0);
  assert.equal(state.metadata.residualRowCount, 0);
  assert.equal(state.metadata.residualGrossQuantity, 0);
  assert.equal(state.metadata.residualNetQuantity, 0);
});
