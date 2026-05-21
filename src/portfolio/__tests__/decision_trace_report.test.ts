import test from "node:test";
import assert from "node:assert/strict";

import { buildFundingCarryPackageLedger, buildTradeLedgerEntry } from "../basis.js";
import { buildDecisionIntent } from "../decision_intent.js";
import { buildPackageTraceDecision, buildRuntimeDecisionTrace, buildTraceDecisionFromIntent } from "../decision_trace.js";
import { summarizeRuntimeDecisionTraces } from "../decision_trace_report.js";
import { OKX_BTC_USDT_SWAP } from "../instrument_spec.js";
import { buildOptimizationRequest } from "../optimizer_request.js";
import { buildPortfolioState } from "../portfolio_state.js";
import { shouldPersistRuntimeTraceMessage } from "../../runtime/runtime_trace_observer.js";

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
  assert.equal(report.health.status, "fail");
  assert.equal(report.health.failCount, 1);
  assert.equal(report.verdicts[0]?.status, "fail");
  assert.equal(report.messageSummary.instrumentErrorCount, 1);
  assert.equal(report.messageSummary.warningCount, 1);
  assert.equal(report.messageSummary.notifyCount, 1);
  assert.equal(report.notifyMessages[0]?.category, "instrument_error");
  assert.deepEqual(report.notifyMessages[0]?.affectedInstrumentIds, [OKX_BTC_USDT_SWAP]);
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
  assert.equal(report.health.status, "warn");
  assert.equal(report.health.warnCount, 1);
  assert.equal(report.verdicts[0]?.status, "warn");
  assert.equal(report.messageSummary.warningCount, 2);
  assert.equal(report.messageSummary.notifyCount, 0);
  assert.deepEqual(report.summary.alertBreakdown.map((row) => row.code).sort(), [
    "PACKAGE_RESIDUAL_DRIFT",
    "RESIDUAL_MISMATCH",
  ]);
  assert.equal(report.rows[0]?.packageResidualRowDiff, -1);
});

test("runtime decision trace health passes when mismatches are inside thresholds", () => {
  const { portfolioState, optimizationRequest } = basePortfolio();
  const actualIntent = buildDecisionIntent("trade", "open_long", 3, "actual_open");
  const shadowIntent = buildDecisionIntent("trade", "open_long", 2, "shadow_open");

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

  const report = summarizeRuntimeDecisionTraces([{ trace, createdAt: 30 }], {
    dqDiffPctWarn: 50,
    residualNetQuantityTolerance: 1e-9,
    packageResidualRowDiffTolerance: 0,
    alertOnMissingShadow: true,
  });

  assert.equal(report.summary.exactDqMismatchCount, 1);
  assert.equal(report.summary.alertCount, 0);
  assert.equal(report.health.status, "pass");
  assert.equal(report.verdicts[0]?.status, "pass");
  assert.equal(report.messageSummary.infoCount, 1);
  assert.equal(report.messageSummary.notifyCount, 0);
  assert.equal(report.messages[0]?.category, "info");
});

test("runtime observer suppresses info persistence unless explicitly enabled", () => {
  const { portfolioState, optimizationRequest } = basePortfolio();
  const intent = buildDecisionIntent("trade", "open_long", 3, "actual_open");
  const trace = buildRuntimeDecisionTrace({
    traceVersion: "test-v1",
    source: "strategy_runner",
    portfolioState,
    optimizationRequest,
    actualDecision: buildTraceDecisionFromIntent({
      reason: intent.reason,
      intent,
      tradeLedger: buildTradeLedgerEntry(
        OKX_BTC_USDT_SWAP,
        intent.route,
        intent.proposedDqContracts,
        intent.basis,
      ),
    }),
    shadowDecision: buildTraceDecisionFromIntent({
      reason: intent.reason,
      intent,
      tradeLedger: buildTradeLedgerEntry(
        OKX_BTC_USDT_SWAP,
        intent.route,
        intent.proposedDqContracts,
        intent.basis,
      ),
    }),
  });

  const report = summarizeRuntimeDecisionTraces([{ trace, createdAt: 40 }]);
  const message = report.messages[0];

  assert.equal(message?.category, "info");
  assert.equal(message ? shouldPersistRuntimeTraceMessage(message) : null, false);
  assert.equal(message ? shouldPersistRuntimeTraceMessage(message, true) : null, true);
});
