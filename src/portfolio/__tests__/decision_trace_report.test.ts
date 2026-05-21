import test from "node:test";
import assert from "node:assert/strict";

import { buildFundingCarryPackageLedger, buildTradeLedgerEntry } from "../basis.js";
import { buildDecisionIntent } from "../decision_intent.js";
import { buildPackageTraceDecision, buildRuntimeDecisionTrace, buildTraceDecisionFromIntent } from "../decision_trace.js";
import { summarizeRuntimeDecisionTraces } from "../decision_trace_report.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildOptimizationRequest } from "../optimizer_request.js";
import { buildPortfolioState } from "../portfolio_state.js";

function basePortfolio() {
  const portfolioState = buildPortfolioState({
    asOfMs: 1,
    instrumentPositions: [],
    securityExposures: [],
    metadata: {},
  });
  return {
    portfolioState,
    optimizationRequest: buildOptimizationRequest({ portfolioState }),
  };
}

test("runtime decision trace report summarizes route and dq alerts", () => {
  const { portfolioState, optimizationRequest } = basePortfolio();
  const actualIntent = buildDecisionIntent("trade", "open_long", 3, "actual_open");
  const shadowIntent = buildDecisionIntent("trade", "close_long", 2, "shadow_close");

  const trace = buildRuntimeDecisionTrace({
    traceVersion: "test-v1",
    source: "strategy_runner",
    portfolioState,
    optimizationRequest,
    actualDecision: buildTraceDecisionFromIntent({
      reason: actualIntent.reason,
      intent: actualIntent,
      tradeLedger: buildTradeLedgerEntry(
        OKX_BTC_USDT_SWAP,
        actualIntent.route,
        actualIntent.proposedDqContracts,
        actualIntent.basis,
      ),
    }),
    shadowDecision: buildTraceDecisionFromIntent({
      reason: shadowIntent.reason,
      intent: shadowIntent,
      tradeLedger: buildTradeLedgerEntry(
        OKX_BTC_USDT_SWAP,
        shadowIntent.route,
        shadowIntent.proposedDqContracts,
        shadowIntent.basis,
      ),
    }),
  });

  const report = summarizeRuntimeDecisionTraces([{ trace, createdAt: 10 }]);

  assert.equal(report.summary.totalTraces, 1);
  assert.equal(report.summary.routeMismatchCount, 1);
  assert.equal(report.summary.exactDqMismatchCount, 1);
  assert.equal(report.summary.alertCount, 2);
  assert.deepEqual(report.summary.alertBreakdown.map((row) => row.code).sort(), [
    "DQ_MISMATCH",
    "ROUTE_MISMATCH",
  ]);
  assert.equal(report.alerts[0]?.source, "strategy_runner");
  assert.equal(report.rows[0]?.dqDiffPct, 33.33333333333333);
});

test("runtime decision trace report flags package residual drift", () => {
  const { portfolioState, optimizationRequest } = basePortfolio();
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

  const report = summarizeRuntimeDecisionTraces([{ trace, createdAt: 20 }]);

  assert.equal(report.summary.residualMismatchCount, 1);
  assert.equal(report.summary.packageResidualDriftCount, 1);
  assert.equal(report.summary.alertCount, 2);
  assert.deepEqual(report.summary.alertBreakdown.map((row) => row.code).sort(), [
    "PACKAGE_RESIDUAL_DRIFT",
    "RESIDUAL_MISMATCH",
  ]);
  assert.equal(report.rows[0]?.packageResidualRowDiff, -1);
});
