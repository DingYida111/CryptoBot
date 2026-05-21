import test from "node:test";
import assert from "node:assert/strict";

import { buildDecisionIntent } from "../decision_intent.js";
import { buildHoldTraceDecision, buildPackageTraceDecision, buildRuntimeDecisionTrace, buildTraceDecisionFromIntent } from "../decision_trace.js";
import { buildFundingCarryPackageLedger, buildTradeLedgerEntry } from "../basis.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildOptimizationRequest } from "../optimizer_request.js";
import { buildPortfolioState } from "../portfolio_state.js";

test("runtime decision trace compares single-instrument actual and shadow intents", () => {
  const portfolioState = buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    metadata: {},
  });
  const optimizationRequest = buildOptimizationRequest({
    portfolioState,
  });
  const actualIntent = buildDecisionIntent("trade", "open_long", 3, "actual_open");
  const shadowIntent = buildDecisionIntent("trade", "open_long", 3, "shadow_open");

  const trace = buildRuntimeDecisionTrace({
    traceVersion: "test-v1",
    source: "strategy_runner",
    portfolioState,
    optimizationRequest,
    actualDecision: buildTraceDecisionFromIntent({
      reason: actualIntent.reason,
      intent: actualIntent,
      tradeLedger: buildTradeLedgerEntry(OKX_BTC_USDT_SWAP, actualIntent.route, actualIntent.proposedDqContracts, actualIntent.basis),
    }),
    shadowDecision: buildTraceDecisionFromIntent({
      reason: shadowIntent.reason,
      intent: shadowIntent,
      tradeLedger: buildTradeLedgerEntry(OKX_BTC_USDT_SWAP, shadowIntent.route, shadowIntent.proposedDqContracts, shadowIntent.basis),
    }),
  });

  assert.equal(trace.diff.routeMatch, true);
  assert.equal(trace.diff.exactDqMatch, true);
  assert.equal(trace.diff.basisMatch, true);
  assert.equal(trace.diff.residualMatch, true);
});

test("runtime decision trace compares funding package actual and shadow routes", () => {
  const portfolioState = buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    metadata: {},
  });
  const optimizationRequest = buildOptimizationRequest({
    portfolioState,
  });
  const actualPackage = buildFundingCarryPackageLedger({
    spotDqBtc: 0.03,
    swapDqContracts: -3,
    contractMultiplier: 0.01,
    spotRoute: "open_long",
    swapRoute: "open_short",
  });
  const shadowPackage = buildFundingCarryPackageLedger({
    spotDqBtc: 0.029,
    swapDqContracts: -3,
    contractMultiplier: 0.01,
    spotRoute: "open_long",
    swapRoute: "open_short",
  });

  const trace = buildRuntimeDecisionTrace({
    traceVersion: "test-v1",
    source: "local_funding_arbitrage",
    portfolioState,
    optimizationRequest,
    actualDecision: buildPackageTraceDecision({
      route: "funding_carry_enter",
      reason: "actual_enter",
      packageLedger: actualPackage,
    }),
    shadowDecision: buildPackageTraceDecision({
      route: "funding_carry_enter",
      reason: "shadow_enter",
      packageLedger: shadowPackage,
    }),
  });

  assert.equal(trace.diff.routeMatch, true);
  assert.equal(trace.diff.basisMatch, true);
  assert.equal(trace.diff.residualMatch, false);
  assert.equal(trace.diff.packageResidualRowDiff, -1);
});

test("hold trace decision defaults to package_hold route", () => {
  const hold = buildHoldTraceDecision({ reason: "idle" });
  assert.equal(hold.route, "package_hold");
  assert.equal(hold.proposedDqContracts, 0);
});
