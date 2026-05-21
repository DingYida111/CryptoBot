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
import { buildRuntimeActionExecutionPlan } from "../../runtime/runtime_action_executor.js";
import { buildRuntimeActionsForMessage, summarizeRuntimeActions } from "../../runtime/runtime_actions.js";

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

test("runtime actions map errors to observe-only proposed interventions", () => {
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

  const report = summarizeRuntimeDecisionTraces([{ trace, createdAt: 50 }]);
  const instrumentError = report.messages.find((message) => message.category === "instrument_error");
  const warning = report.messages.find((message) => message.category === "warning");

  assert.deepEqual(
    instrumentError ? buildRuntimeActionsForMessage(instrumentError).map((row) => row.actionType) : [],
    ["pause_instrument", "flatten_instrument"],
  );
  assert.deepEqual(
    warning ? buildRuntimeActionsForMessage(warning).map((row) => row.actionType) : [],
    ["record_warning"],
  );
  assert.equal(
    instrumentError ? buildRuntimeActionsForMessage(instrumentError)[0]?.executionEnabled : null,
    false,
  );
});

test("runtime action report marks cooldown duplicates without changing status", () => {
  const base = {
    surface: "portfolio_shadow_log",
    surfaceRowId: 1,
    messageCode: "ROUTE_MISMATCH",
    category: "instrument_error",
    scope: "instrument",
    source: "runtime_trace_fixture",
    traceVersion: "test-v1",
    actionType: "pause_instrument",
    status: "proposed",
    executionEnabled: false,
    affectedInstrumentIds: [OKX_BTC_USDT_SWAP],
    reason: "test",
    proposedAt: 1_000,
    updatedAt: null,
    executorNote: null,
  };
  const report = summarizeRuntimeActions([
    {
      ...base,
      id: 1,
      createdAt: 1_000,
    },
    {
      ...base,
      id: 2,
      surfaceRowId: 2,
      createdAt: 1_500,
      proposedAt: 1_500,
    },
    {
      ...base,
      id: 3,
      surfaceRowId: 3,
      actionType: "flatten_instrument",
      createdAt: 1_600,
      proposedAt: 1_600,
    },
  ], { cooldownMs: 1_000 });

  assert.equal(report.summary.totalActions, 3);
  assert.equal(report.summary.proposedCount, 3);
  assert.equal(report.summary.cooldownDuplicateCount, 1);
  assert.equal(report.cooldown.duplicates[0]?.id, 2);
  assert.equal(report.cooldown.duplicates[0]?.previousId, 1);
});

test("runtime action executor builds dry-run plan without enabling execution", () => {
  const base = {
    surface: "portfolio_shadow_log",
    surfaceRowId: 1,
    category: "instrument_error",
    scope: "instrument",
    source: "runtime_trace_fixture",
    traceVersion: "test-v1",
    status: "proposed",
    executionEnabled: false,
    affectedInstrumentIds: [OKX_BTC_USDT_SWAP],
    reason: "test",
    proposedAt: 1_000,
    updatedAt: null,
    executorNote: null,
  };
  const plan = buildRuntimeActionExecutionPlan({
    rows: [
      {
        ...base,
        id: 1,
        messageCode: "ROUTE_MISMATCH",
        actionType: "pause_instrument",
        createdAt: 1_000,
      },
      {
        ...base,
        id: 2,
        surfaceRowId: 2,
        messageCode: "ROUTE_MISMATCH",
        actionType: "pause_instrument",
        createdAt: 1_500,
      },
      {
        ...base,
        id: 3,
        messageCode: "DQ_MISMATCH",
        category: "warning",
        scope: "strategy",
        actionType: "record_warning",
        createdAt: 2_000,
      },
    ],
    cooldownMs: 1_000,
    ackDryRun: false,
  });

  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.totalCandidates, 3);
  assert.equal(plan.wouldExecuteCount, 1);
  assert.equal(plan.cooldownDuplicateCount, 1);
  assert.equal(plan.recordOnlyCount, 1);
  assert.equal(plan.readyForLiveExecutionCount, 0);
  assert.deepEqual(plan.rows[0]?.blockerCodes, [
    "LIVE_EXECUTION_NOT_ENABLED",
    "TRADING_ADAPTER_NOT_CONFIGURED",
  ]);
  assert.equal(plan.rows[0]?.nextStatus, "dry_run_acknowledged");
  assert.equal(plan.rows[1]?.nextStatus, "dry_run_cooldown_duplicate");
});

test("runtime action executor preflight can model live readiness without executing", () => {
  const plan = buildRuntimeActionExecutionPlan({
    rows: [
      {
        id: 1,
        surface: "portfolio_shadow_log",
        surfaceRowId: 1,
        messageCode: "ROUTE_MISMATCH",
        category: "instrument_error",
        scope: "instrument",
        source: "runtime_trace_fixture",
        traceVersion: "test-v1",
        actionType: "flatten_instrument",
        status: "proposed",
        executionEnabled: false,
        affectedInstrumentIds: [OKX_BTC_USDT_SWAP],
        reason: "test",
        createdAt: 1_000,
        proposedAt: 1_000,
        updatedAt: null,
        executorNote: null,
      },
    ],
    cooldownMs: 1_000,
    ackDryRun: false,
    preflight: {
      liveExecutionEnabled: true,
      tradingAdapterConfigured: true,
    },
  });

  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.readyForLiveExecutionCount, 1);
  assert.equal(plan.blockedCount, 0);
  assert.deepEqual(plan.rows[0]?.blockerCodes, []);
});
