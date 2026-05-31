import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioState } from "../portfolio_state.js";
import { buildOptimizationRequest } from "../optimizer_request.js";
import { buildExecutionPlan } from "../execution.js";
import { runOptimizationV1 } from "../optimizer_v1.js";
import { STRATEGY_BASIS_SPECS } from "../basis.js";
import { OKX_BTC_USDT_SPOT, OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX, USDT_CASH } from "../security_spec.js";

function buildEmptyState() {
  return buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    metadata: {},
  });
}

function assertApprox(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("optimizer v1 selects the long BTC swap basis for directional signal", () => {
  const portfolioState = buildEmptyState();
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      signalEdge: 0.8,
      confidence: 1,
      carryEdge: 0.05,
    },
    instrumentBounds: {
      [OKX_BTC_USDT_SWAP]: [-10, 10],
    },
    securityBounds: {
      [BTC_DELTA]: [-10, 10],
      [BTC_PERP_FUNDING_OKX]: [-10, 10],
      [USDT_CASH]: [-1_000_000, 1_000_000],
    },
  });

  const result = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    scoreScale: 1,
    riskAversion: 0.01,
    tradeCostPerUnit: 0,
  });

  assert.equal(result.selectedBasisId, "basis:long_btc_swap");
  assert.ok((result.targetInstrumentPositions[OKX_BTC_USDT_SWAP] ?? 0) > 0);
  assert.equal(result.targetInstrumentPositions[OKX_BTC_USDT_SPOT] ?? 0, 0);
  assert.ok(result.objectiveValue > 0);
});

test("optimizer v1 can use bid and offer side quotes directly", () => {
  const portfolioState = buildEmptyState();
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      confidence: 1,
    },
    basisBidOfferScores: {
      "basis:long_btc_swap": {
        bid: 1.2,
        offer: 0.2,
      },
    },
    instrumentBidOfferCosts: {
      [OKX_BTC_USDT_SWAP]: {
        bid: 0.05,
        offer: 0.08,
      },
    },
    instrumentBounds: {
      [OKX_BTC_USDT_SWAP]: [-10, 10],
    },
    securityBounds: {
      [BTC_DELTA]: [-10, 10],
      [BTC_PERP_FUNDING_OKX]: [-10, 10],
      [USDT_CASH]: [-1_000_000, 1_000_000],
    },
  });

  const result = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    scoreScale: 1,
    riskAversion: 0.01,
    tradeCostPerUnit: 0,
  });

  assert.equal(result.selectedBasisId, "basis:long_btc_swap");
  assert.ok(result.objectiveBreakdown.efficiency > 0);
  assert.ok(result.objectiveBreakdown.cost >= 0);
});

test("execution plan rounds swap quantity toward zero and records residual", () => {
  const portfolioState = buildEmptyState();
  const plan = buildExecutionPlan({
    asOfMs: 2,
    source: "unit-test",
    portfolioState,
    targetInstrumentPositions: {
      [OKX_BTC_USDT_SWAP]: 2.4,
    },
  });

  assert.equal(plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP], 2);
  assert.equal(plan.quantizedDeltas.length, 1);
  assert.equal(plan.quantizedDeltas[0]?.roundedDelta, 2);
  assertApprox(plan.quantizedDeltas[0]?.residualDelta ?? 0, 0.4);
  assert.equal(plan.residualLedger.length, 1);
  assert.equal(plan.residualLedger[0]?.reasonCode, "LOT_ROUNDING");
  assert.equal(plan.executable, true);
});

test("execution plan marks sub-lot requests as non-executable and fully residual", () => {
  const portfolioState = buildEmptyState();
  const plan = buildExecutionPlan({
    asOfMs: 3,
    source: "unit-test",
    portfolioState,
    targetInstrumentPositions: {
      [OKX_BTC_USDT_SWAP]: 0.4,
    },
  });

  assert.equal(plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP], 0);
  assert.equal(plan.quantizedDeltas[0]?.roundedDelta, 0);
  assertApprox(plan.quantizedDeltas[0]?.residualDelta ?? 0, 0.4);
  assert.equal(plan.residualLedger.length, 1);
  assert.equal(plan.executable, false);
});

test("execution plan rejects residuals that exceed budget", () => {
  const portfolioState = buildEmptyState();
  const plan = buildExecutionPlan({
    asOfMs: 4,
    source: "unit-test",
    portfolioState,
    targetInstrumentPositions: {
      [OKX_BTC_USDT_SWAP]: 2.4,
    },
    residualBudget: {
      maxGrossQuantity: 0.3,
    },
  });

  assert.equal(plan.quantizedDeltas[0]?.roundedDelta, 2);
  assert.equal(plan.residualLedger.length, 1);
  assert.equal(plan.residualBudgetCheck?.withinBudget, false);
  assert.equal(plan.executable, false);
  assert.equal(plan.reason, "execution_plan_residual_budget_exceeded");
});
