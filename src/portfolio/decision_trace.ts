import type {
  OptimizationRequest,
  PortfolioState,
  RuntimeDecisionTrace,
  RuntimeDecisionTraceDecision,
  RuntimeDecisionTraceDiff,
  TradeLedgerEntry,
  TradePackageLedger,
} from "./portfolio_types.js";

export function buildTraceDecisionFromIntent(input: {
  readonly reason: string;
  readonly intent: RuntimeDecisionTraceDecision["intent"];
  readonly tradeLedger: TradeLedgerEntry | null;
  readonly packageLedger?: TradePackageLedger | null;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): RuntimeDecisionTraceDecision {
  if (!input.intent) {
    throw new Error("buildTraceDecisionFromIntent requires a non-null intent");
  }
  return {
    mode: input.intent.mode,
    route: input.intent.route,
    reason: input.reason,
    proposedDqContracts: input.intent.proposedDqContracts,
    metadata: input.metadata ?? input.intent.metadata,
    intent: input.intent,
    tradeLedger: input.tradeLedger,
    packageLedger: input.packageLedger ?? null,
  };
}

export function buildPackageTraceDecision(input: {
  readonly route: RuntimeDecisionTraceDecision["route"];
  readonly reason: string;
  readonly packageLedger: TradePackageLedger | null;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): RuntimeDecisionTraceDecision {
  const proposedDqContracts = input.packageLedger
    ? input.packageLedger.legs
        .filter((leg) => leg.instrumentId.endsWith("SWAP"))
        .reduce((sum, leg) => sum + leg.dq, 0)
    : null;
  return {
    mode: "package",
    route: input.route,
    reason: input.reason,
    proposedDqContracts,
    metadata: input.metadata ?? {},
    intent: null,
    tradeLedger: null,
    packageLedger: input.packageLedger,
  };
}

export function buildHoldTraceDecision(input: {
  readonly route?: RuntimeDecisionTraceDecision["route"];
  readonly reason: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): RuntimeDecisionTraceDecision {
  return {
    mode: "hold",
    route: input.route ?? "package_hold",
    reason: input.reason,
    proposedDqContracts: 0,
    metadata: input.metadata ?? {},
    intent: null,
    tradeLedger: null,
    packageLedger: null,
  };
}

export function computeRuntimeDecisionTraceDiff(input: {
  readonly actualDecision: RuntimeDecisionTraceDecision;
  readonly shadowDecision: RuntimeDecisionTraceDecision | null;
}): RuntimeDecisionTraceDiff {
  const shadow = input.shadowDecision;
  if (shadow === null) {
    return {
      routeMatch: null,
      exactDqMatch: null,
      basisMatch: null,
      residualMatch: null,
      packageResidualRowDiff: null,
    };
  }

  const actualBasisId =
    input.actualDecision.packageLedger?.basisId ??
    input.actualDecision.tradeLedger?.basisId ??
    input.actualDecision.intent?.basis.basisId ??
    null;
  const shadowBasisId =
    shadow.packageLedger?.basisId ??
    shadow.tradeLedger?.basisId ??
    shadow.intent?.basis.basisId ??
    null;

  const actualResidual =
    input.actualDecision.packageLedger?.residualSummary.netQuantity ??
    input.actualDecision.tradeLedger?.residualDq ??
    input.actualDecision.intent?.basis.residualDqContracts ??
    0;
  const shadowResidual =
    shadow.packageLedger?.residualSummary.netQuantity ??
    shadow.tradeLedger?.residualDq ??
    shadow.intent?.basis.residualDqContracts ??
    0;

  return {
    routeMatch: input.actualDecision.route === shadow.route,
    exactDqMatch:
      input.actualDecision.proposedDqContracts !== null &&
      shadow.proposedDqContracts !== null
        ? input.actualDecision.proposedDqContracts === shadow.proposedDqContracts
        : null,
    basisMatch: actualBasisId === shadowBasisId,
    residualMatch: Math.abs(actualResidual - shadowResidual) <= 1e-9,
    packageResidualRowDiff:
      (input.actualDecision.packageLedger?.residualSummary.rowCount ?? 0) -
      (shadow.packageLedger?.residualSummary.rowCount ?? 0),
  };
}

export function buildRuntimeDecisionTrace(input: {
  readonly traceVersion: string;
  readonly source: string;
  readonly portfolioState: PortfolioState;
  readonly optimizationRequest: OptimizationRequest;
  readonly actualDecision: RuntimeDecisionTraceDecision;
  readonly shadowDecision: RuntimeDecisionTraceDecision | null;
}): RuntimeDecisionTrace {
  return {
    traceVersion: input.traceVersion,
    source: input.source,
    portfolioState: input.portfolioState,
    optimizationRequest: input.optimizationRequest,
    actualDecision: input.actualDecision,
    shadowDecision: input.shadowDecision,
    diff: computeRuntimeDecisionTraceDiff({
      actualDecision: input.actualDecision,
      shadowDecision: input.shadowDecision,
    }),
  };
}
