import test from "node:test";
import assert from "node:assert/strict";
import { computeBasisBps, computeFundingArbitrageOpportunity } from "../funding_arbitrage.js";

test("computeBasisBps measures perp premium over spot", () => {
  const bps = computeBasisBps(100, 100.5);
  assert.equal(Number(bps.toFixed(2)), 50);
});

test("funding opportunity uses ctVal and depth to build candidate package", () => {
  const result = computeFundingArbitrageOpportunity({
    asOfMs: 1_000,
    spotInstId: "BTC-USDT",
    perpInstId: "BTC-USDT-SWAP",
    spotBidPx: 100_000,
    spotAskPx: 100_010,
    spotBidSz: 1,
    spotAskSz: 1,
    perpBidPx: 100_020,
    perpAskPx: 100_030,
    perpBidSzContracts: 2,
    perpAskSzContracts: 2,
    fundingRate: 0.0008,
    nextFundingTimeMs: 60_000,
    swapCtValBtc: 0.01,
    swapLotSzContracts: 1,
    spotLotSzBtc: 0.0001,
  }, {
    entryLeadMs: 120_000,
    maxPackageSizeBtc: 0.05,
    minUsefulPackageSizeBtc: 0.01,
    spotFeeRate: 0.001,
    perpFeeRate: 0.0005,
    spotSlippageBps: 5,
    perpSlippageBps: 5,
    basisRiskBufferBps: 8,
    safetyBufferUsd: 0.1,
    requirePositiveFunding: true,
    forceValidationEntry: false,
  });

  assert.equal(result.entryWindowOpen, true);
  assert.equal(result.candidateSwapContracts, 2);
  assert.equal(result.candidateBtcSize, 0.02);
  assert.equal(result.shouldEnter, false);
  assert.match(result.reason, /net_edge_below_buffer/);
});

test("force validation entry can bypass normal gate for paper validation", () => {
  const result = computeFundingArbitrageOpportunity({
    asOfMs: 1_000,
    spotInstId: "BTC-USDT",
    perpInstId: "BTC-USDT-SWAP",
    spotBidPx: 100_000,
    spotAskPx: 100_010,
    spotBidSz: 1,
    spotAskSz: 1,
    perpBidPx: 100_020,
    perpAskPx: 100_030,
    perpBidSzContracts: 2,
    perpAskSzContracts: 2,
    fundingRate: 0.0002,
    nextFundingTimeMs: 10_000_000,
    swapCtValBtc: 0.01,
    swapLotSzContracts: 1,
    spotLotSzBtc: 0.0001,
  }, {
    entryLeadMs: 120_000,
    maxPackageSizeBtc: 0.02,
    minUsefulPackageSizeBtc: 0.01,
    spotFeeRate: 0.001,
    perpFeeRate: 0.0005,
    spotSlippageBps: 5,
    perpSlippageBps: 5,
    basisRiskBufferBps: 8,
    safetyBufferUsd: 100,
    requirePositiveFunding: true,
    forceValidationEntry: true,
  });

  assert.equal(result.shouldEnter, true);
  assert.match(result.reason, /validation_override/);
});
