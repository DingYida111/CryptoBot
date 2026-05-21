import { insertPortfolioShadowLog } from "../monitor/storage.js";
import { buildTradeLedgerEntry } from "../portfolio/basis.js";
import { buildDecisionIntent } from "../portfolio/decision_intent.js";
import { buildRuntimeDecisionTrace, buildTraceDecisionFromIntent } from "../portfolio/decision_trace.js";
import { OKX_BTC_USDT_SWAP } from "../portfolio/instrument_spec.js";
import { buildOptimizationRequest } from "../portfolio/optimizer_request.js";
import { buildPortfolioState } from "../portfolio/portfolio_state.js";

const FIXTURE_VERSION = "runtime-trace-fixture-v1";
const FIXTURE_SOURCE = "runtime_trace_fixture";

function main(): void {
  const now = Date.now();
  const portfolioState = buildPortfolioState({
    asOfMs: now,
    instrumentPositions: [{ instrumentId: OKX_BTC_USDT_SWAP, quantity: 0 }],
    securityExposures: [],
    metadata: {
      fixture: true,
      purpose: "observe_only_runtime_message_validation",
    },
  });
  const optimizationRequest = buildOptimizationRequest({ portfolioState });
  const actualIntent = buildDecisionIntent("trade", "open_long", 3, "fixture_actual_open_long", {
    fixture: true,
  });
  const shadowIntent = buildDecisionIntent("trade", "close_long", 2, "fixture_shadow_close_long", {
    fixture: true,
  });
  const actualTradeLedger = buildTradeLedgerEntry(
    OKX_BTC_USDT_SWAP,
    actualIntent.route,
    actualIntent.proposedDqContracts,
    actualIntent.basis,
  );
  const shadowTradeLedger = buildTradeLedgerEntry(
    OKX_BTC_USDT_SWAP,
    shadowIntent.route,
    shadowIntent.proposedDqContracts,
    shadowIntent.basis,
  );
  const decisionTrace = buildRuntimeDecisionTrace({
    traceVersion: FIXTURE_VERSION,
    source: FIXTURE_SOURCE,
    portfolioState,
    optimizationRequest,
    actualDecision: buildTraceDecisionFromIntent({
      reason: actualIntent.reason,
      intent: actualIntent,
      tradeLedger: actualTradeLedger,
    }),
    shadowDecision: buildTraceDecisionFromIntent({
      reason: shadowIntent.reason,
      intent: shadowIntent,
      tradeLedger: shadowTradeLedger,
    }),
  });
  const diffPct = Math.abs(actualIntent.proposedDqContracts - shadowIntent.proposedDqContracts)
    / Math.max(Math.abs(actualIntent.proposedDqContracts), Math.abs(shadowIntent.proposedDqContracts), 1)
    * 100;
  const id = insertPortfolioShadowLog({
    source: FIXTURE_SOURCE,
    shadowVersion: FIXTURE_VERSION,
    actualRoute: actualIntent.route,
    shadowRoute: shadowIntent.route,
    actualDqContracts: actualIntent.proposedDqContracts,
    shadowDqContracts: shadowIntent.proposedDqContracts,
    actualBasisId: actualIntent.basis.basisId,
    shadowBasisId: shadowIntent.basis.basisId,
    actualResidualContracts: actualIntent.basis.residualDqContracts,
    shadowResidualContracts: shadowIntent.basis.residualDqContracts,
    shadowResidualReason: shadowIntent.basis.residualReasonCode,
    diffPct,
    rawJson: JSON.stringify({
      fixture: true,
      decisionTrace,
      actualIntent,
      shadowIntent,
      actualTradeLedger,
      shadowTradeLedger,
      optimizationRequest,
    }),
    createdAt: now,
  });

  console.log(JSON.stringify({
    inserted: true,
    id,
    source: FIXTURE_SOURCE,
    shadowVersion: FIXTURE_VERSION,
    expectedMessageCategories: ["instrument_error", "warning"],
    expectedNotifyCount: 1,
    diff: decisionTrace.diff,
  }, null, 2));
}

main();
