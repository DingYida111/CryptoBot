import test from "node:test";
import assert from "node:assert/strict";

import { BASIS_BTC_FUNDING_CARRY_PACKAGE, BASIS_LONG_BTC_SWAP, STRATEGY_BASIS_SPECS } from "../basis.js";
import { buildExecutionPlanFromOptimization, buildPackageExecutionPlanFromBasis } from "../execution.js";
import { computeExposure, toInstrumentSpecMap } from "../exposure.js";
import {
  buildBtcSpotInstrumentSpec,
  buildBtcSwapInstrumentSpec,
  DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER,
  OKX_BTC_USDT_SPOT,
  OKX_BTC_USDT_SWAP,
} from "../instrument_spec.js";
import { buildOptimizationRequest } from "../optimizer_request.js";
import { runOptimizationV1 } from "../optimizer_v1.js";
import { buildPortfolioState } from "../portfolio_state.js";
import type { InstrumentPosition } from "../portfolio_types.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX, USDT_CASH } from "../security_spec.js";

const INSTRUMENT_SPECS = [buildBtcSpotInstrumentSpec(), buildBtcSwapInstrumentSpec()] as const;
const INSTRUMENT_SPEC_MAP = toInstrumentSpecMap(INSTRUMENT_SPECS);

function assertApprox(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function buildState(positions: readonly InstrumentPosition[] = []) {
  return buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: positions,
    securityExposures: computeExposure(positions, INSTRUMENT_SPEC_MAP),
    metadata: {},
  });
}

test("optimization chain turns a directional signal into a quantized swap order", () => {
  const portfolioState = buildState();
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      signalEdge: 0.8,
      confidence: 1,
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

  const optimization = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    riskAversion: 0,
    tradeCostPerUnit: 0,
  });
  const plan = buildExecutionPlanFromOptimization({
    asOfMs: 2,
    source: "optimization-chain-test",
    portfolioState,
    optimizationResult: optimization,
  });

  assert.equal(optimization.selectedBasisId, BASIS_LONG_BTC_SWAP);
  assert.ok((optimization.targetInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0) > 0);
  assert.ok((plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0) > 0);
  assert.ok(plan.residualLedger.some((row) => row.reasonCode === "LOT_ROUNDING"));
});

test("optimization chain can reduce an existing long swap position when signal turns negative", () => {
  const portfolioState = buildState([
    { instrumentId: OKX_BTC_USDT_SWAP, quantity: 3 },
  ]);
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      signalEdge: -0.1,
      confidence: 1,
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

  const optimization = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    riskAversion: 0,
    tradeCostPerUnit: 0,
  });
  const plan = buildExecutionPlanFromOptimization({
    asOfMs: 3,
    source: "optimization-chain-test",
    portfolioState,
    optimizationResult: optimization,
  });

  assert.equal(optimization.selectedBasisId, BASIS_LONG_BTC_SWAP);
  assert.ok((optimization.targetInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0) < 0);
  assert.ok((plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0) < 0);
});

test("optimization chain exposes multi-leg package rounding gap for funding carry", () => {
  const portfolioState = buildState();
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      [BASIS_BTC_FUNDING_CARRY_PACKAGE]: 1,
      confidence: 1,
    },
    instrumentBounds: {
      [OKX_BTC_USDT_SPOT]: [0, 0.05],
      [OKX_BTC_USDT_SWAP]: [-5, 0],
    },
    securityBounds: {
      [BTC_DELTA]: [-1, 1],
      [BTC_PERP_FUNDING_OKX]: [-1, 1],
      [USDT_CASH]: [-1_000_000, 1_000_000],
    },
  });

  const optimization = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    riskAversion: 0,
    tradeCostPerUnit: 0,
  });
  const plan = buildExecutionPlanFromOptimization({
    asOfMs: 4,
    source: "optimization-chain-test",
    portfolioState,
    optimizationResult: optimization,
  });

  assert.equal(optimization.selectedBasisId, BASIS_BTC_FUNDING_CARRY_PACKAGE);
  assert.ok((optimization.targetInstrumentDeltas[OKX_BTC_USDT_SPOT] ?? 0) > 0);
  assert.ok((optimization.targetInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0) < 0);

  const executedSpotBtc = plan.executedInstrumentDeltas[OKX_BTC_USDT_SPOT] ?? 0;
  const executedSwapContracts = plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0;
  const executedPackageWeightMismatch = Math.abs((executedSpotBtc / DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER) + executedSwapContracts);

  assert.ok(executedPackageWeightMismatch > 0.5);
  assert.ok(plan.residualLedger.some((row) => row.instrumentId === OKX_BTC_USDT_SWAP));
  assertApprox(executedSpotBtc, optimization.targetInstrumentDeltas[OKX_BTC_USDT_SPOT] ?? 0, 1e-7);
});

test("package-aware rounding preserves funding carry leg ratio", () => {
  const portfolioState = buildState();
  const request = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: {
      [BASIS_BTC_FUNDING_CARRY_PACKAGE]: 1,
      confidence: 1,
    },
    instrumentBounds: {
      [OKX_BTC_USDT_SPOT]: [0, 0.05],
      [OKX_BTC_USDT_SWAP]: [-5, 0],
    },
    securityBounds: {
      [BTC_DELTA]: [-1, 1],
      [BTC_PERP_FUNDING_OKX]: [-1, 1],
      [USDT_CASH]: [-1_000_000, 1_000_000],
    },
  });

  const optimization = runOptimizationV1({
    request,
    basisSpecs: STRATEGY_BASIS_SPECS,
    riskAversion: 0,
    tradeCostPerUnit: 0,
  });
  const carryBasis = STRATEGY_BASIS_SPECS.find((basis) => basis.basisId === BASIS_BTC_FUNDING_CARRY_PACKAGE);
  assert.ok(carryBasis);

  const plan = buildPackageExecutionPlanFromBasis({
    asOfMs: 5,
    source: "optimization-chain-test",
    portfolioState,
    basisSpec: carryBasis,
    requestedBasisWeight: optimization.selectedBasisWeight,
  });

  const executedSpotBtc = plan.executedInstrumentDeltas[OKX_BTC_USDT_SPOT] ?? 0;
  const executedSwapContracts = plan.executedInstrumentDeltas[OKX_BTC_USDT_SWAP] ?? 0;
  const executedPackageWeightMismatch = Math.abs((executedSpotBtc / DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER) + executedSwapContracts);

  assert.equal(plan.executable, true);
  assertApprox(executedPackageWeightMismatch, 0);
  assert.ok(plan.residualLedger.some((row) => row.instrumentId === OKX_BTC_USDT_SWAP));
  assert.ok(plan.residualLedger.some((row) => row.instrumentId === OKX_BTC_USDT_SPOT));
});

test("package-aware execution rejects residuals that exceed budget", () => {
  const portfolioState = buildState();
  const carryBasis = STRATEGY_BASIS_SPECS.find((basis) => basis.basisId === BASIS_BTC_FUNDING_CARRY_PACKAGE);
  assert.ok(carryBasis);

  const plan = buildPackageExecutionPlanFromBasis({
    asOfMs: 6,
    source: "optimization-chain-test",
    portfolioState,
    basisSpec: carryBasis,
    requestedBasisWeight: 0.55,
    residualBudget: {
      maxGrossQuantity: 0,
    },
  });

  assert.equal(plan.executable, false);
  assert.equal(plan.residualBudgetCheck?.withinBudget, false);
  assert.deepEqual(plan.residualBudgetCheck?.exceeded, ["maxGrossQuantity"]);
});
