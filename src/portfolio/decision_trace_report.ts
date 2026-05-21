import type {
  RuntimeDecisionTrace,
  RuntimeDecisionTraceDecision,
} from "./portfolio_types.js";

export type RuntimeDecisionTraceAlertSeverity = "warning" | "critical";

export type RuntimeDecisionTraceAlertCode =
  | "SHADOW_MISSING"
  | "ROUTE_MISMATCH"
  | "BASIS_MISMATCH"
  | "DQ_MISMATCH"
  | "RESIDUAL_MISMATCH"
  | "PACKAGE_RESIDUAL_DRIFT";

export interface RuntimeDecisionTraceAlertThresholds {
  readonly dqDiffPctWarn: number;
  readonly residualNetQuantityTolerance: number;
  readonly packageResidualRowDiffTolerance: number;
  readonly alertOnMissingShadow: boolean;
}

export const DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS: RuntimeDecisionTraceAlertThresholds = {
  dqDiffPctWarn: 0,
  residualNetQuantityTolerance: 1e-9,
  packageResidualRowDiffTolerance: 0,
  alertOnMissingShadow: true,
};

export interface RuntimeDecisionTraceReportRow {
  readonly source: string;
  readonly traceVersion: string;
  readonly createdAt: number | null;
  readonly involvedInstrumentIds: readonly string[];
  readonly actualRoute: string;
  readonly shadowRoute: string | null;
  readonly actualDqContracts: number | null;
  readonly shadowDqContracts: number | null;
  readonly dqDiffContracts: number | null;
  readonly dqDiffPct: number | null;
  readonly actualBasisId: string | null;
  readonly shadowBasisId: string | null;
  readonly actualResidualNetQuantity: number;
  readonly shadowResidualNetQuantity: number | null;
  readonly residualNetQuantityDiff: number | null;
  readonly actualPackageResidualRows: number | null;
  readonly shadowPackageResidualRows: number | null;
  readonly packageResidualRowDiff: number | null;
  readonly routeMatch: boolean | null;
  readonly exactDqMatch: boolean | null;
  readonly basisMatch: boolean | null;
  readonly residualMatch: boolean | null;
}

export interface RuntimeDecisionTraceAlert {
  readonly code: RuntimeDecisionTraceAlertCode;
  readonly severity: RuntimeDecisionTraceAlertSeverity;
  readonly source: string;
  readonly traceVersion: string;
  readonly createdAt: number | null;
  readonly actualRoute: string;
  readonly shadowRoute: string | null;
  readonly message: string;
  readonly metrics: Readonly<Record<string, number | string | boolean | null>>;
}

export interface RuntimeDecisionTraceSummary {
  readonly totalTraces: number;
  readonly shadowMissingCount: number;
  readonly routeMismatchCount: number;
  readonly routeMismatchRate: number;
  readonly exactDqMismatchCount: number;
  readonly exactDqMismatchRate: number;
  readonly basisMismatchCount: number;
  readonly residualMismatchCount: number;
  readonly packageResidualDriftCount: number;
  readonly avgDqDiffPct: number | null;
  readonly maxDqDiffPct: number | null;
  readonly maxAbsResidualNetQuantityDiff: number | null;
  readonly sourceBreakdown: ReadonlyArray<{
    readonly source: string;
    readonly count: number;
  }>;
  readonly topRouteMismatches: ReadonlyArray<{
    readonly actualRoute: string;
    readonly shadowRoute: string;
    readonly count: number;
  }>;
  readonly alertCount: number;
  readonly alertBreakdown: ReadonlyArray<{
    readonly code: RuntimeDecisionTraceAlertCode;
    readonly count: number;
  }>;
}

export type RuntimeMessageCategory = "major_error" | "instrument_error" | "warning" | "info";

export type RuntimeMessageScope = "system" | "instrument" | "strategy";

export interface RuntimeTraceMessage {
  readonly category: RuntimeMessageCategory;
  readonly scope: RuntimeMessageScope;
  readonly notify: boolean;
  readonly code: RuntimeDecisionTraceAlertCode | "TRACE_OK";
  readonly source: string;
  readonly traceVersion: string;
  readonly createdAt: number | null;
  readonly affectedInstrumentIds: readonly string[];
  readonly message: string;
  readonly metrics: Readonly<Record<string, number | string | boolean | null>>;
}

export interface RuntimeTraceMessageSummary {
  readonly totalMessages: number;
  readonly majorErrorCount: number;
  readonly instrumentErrorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly notifyCount: number;
  readonly byCategory: ReadonlyArray<{
    readonly category: RuntimeMessageCategory;
    readonly count: number;
  }>;
}

export type RuntimeDecisionTraceGateStatus = "pass" | "warn" | "fail";

export interface RuntimeDecisionTraceGateVerdict {
  readonly status: RuntimeDecisionTraceGateStatus;
  readonly source: string;
  readonly traceVersion: string;
  readonly createdAt: number | null;
  readonly actualRoute: string;
  readonly shadowRoute: string | null;
  readonly alertCount: number;
  readonly warningCount: number;
  readonly criticalCount: number;
  readonly alertCodes: readonly RuntimeDecisionTraceAlertCode[];
}

export interface RuntimeDecisionTraceHealthSummary {
  readonly status: RuntimeDecisionTraceGateStatus;
  readonly totalTraces: number;
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
  readonly bySource: ReadonlyArray<{
    readonly source: string;
    readonly status: RuntimeDecisionTraceGateStatus;
    readonly totalTraces: number;
    readonly passCount: number;
    readonly warnCount: number;
    readonly failCount: number;
  }>;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function basisId(decision: RuntimeDecisionTraceDecision | null): string | null {
  if (!decision) return null;
  return (
    decision.packageLedger?.basisId ??
    decision.tradeLedger?.basisId ??
    decision.intent?.basis.basisId ??
    null
  );
}

function residualNetQuantity(decision: RuntimeDecisionTraceDecision | null): number | null {
  if (!decision) return null;
  return (
    decision.packageLedger?.residualSummary.netQuantity ??
    decision.tradeLedger?.residualDq ??
    decision.intent?.basis.residualDqContracts ??
    0
  );
}

function packageResidualRows(decision: RuntimeDecisionTraceDecision | null): number | null {
  if (!decision?.packageLedger) return null;
  return decision.packageLedger.residualSummary.rowCount;
}

function involvedInstrumentIds(decision: RuntimeDecisionTraceDecision | null): readonly string[] {
  if (!decision) return [];
  if (decision.packageLedger) {
    return decision.packageLedger.legs.map((leg) => leg.instrumentId);
  }
  if (decision.tradeLedger) {
    return [decision.tradeLedger.instrumentId];
  }
  return [];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function dqDiffPct(actualDq: number | null, shadowDq: number | null): number | null {
  if (actualDq === null || shadowDq === null) return null;
  const denom = Math.max(Math.abs(actualDq), Math.abs(shadowDq), 1);
  return Math.abs(actualDq - shadowDq) / denom * 100;
}

export function isRuntimeDecisionTrace(value: unknown): value is RuntimeDecisionTrace {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.traceVersion === "string" &&
    typeof row.source === "string" &&
    !!row.actualDecision &&
    typeof row.actualDecision === "object" &&
    !!row.diff &&
    typeof row.diff === "object"
  );
}

export function buildRuntimeDecisionTraceReportRow(input: {
  readonly trace: RuntimeDecisionTrace;
  readonly createdAt?: number | null;
}): RuntimeDecisionTraceReportRow {
  const actualResidual = residualNetQuantity(input.trace.actualDecision) ?? 0;
  const shadowResidual = residualNetQuantity(input.trace.shadowDecision);
  const actualDq = input.trace.actualDecision.proposedDqContracts;
  const shadowDq = input.trace.shadowDecision?.proposedDqContracts ?? null;
  return {
    source: input.trace.source,
    traceVersion: input.trace.traceVersion,
    createdAt: input.createdAt ?? null,
    involvedInstrumentIds: uniqueStrings([
      ...involvedInstrumentIds(input.trace.actualDecision),
      ...involvedInstrumentIds(input.trace.shadowDecision),
    ]),
    actualRoute: input.trace.actualDecision.route,
    shadowRoute: input.trace.shadowDecision?.route ?? null,
    actualDqContracts: actualDq,
    shadowDqContracts: shadowDq,
    dqDiffContracts: actualDq !== null && shadowDq !== null ? actualDq - shadowDq : null,
    dqDiffPct: dqDiffPct(actualDq, shadowDq),
    actualBasisId: basisId(input.trace.actualDecision),
    shadowBasisId: basisId(input.trace.shadowDecision),
    actualResidualNetQuantity: actualResidual,
    shadowResidualNetQuantity: shadowResidual,
    residualNetQuantityDiff: shadowResidual === null ? null : actualResidual - shadowResidual,
    actualPackageResidualRows: packageResidualRows(input.trace.actualDecision),
    shadowPackageResidualRows: packageResidualRows(input.trace.shadowDecision),
    packageResidualRowDiff: input.trace.diff.packageResidualRowDiff,
    routeMatch: input.trace.diff.routeMatch,
    exactDqMatch: input.trace.diff.exactDqMatch,
    basisMatch: input.trace.diff.basisMatch,
    residualMatch: input.trace.diff.residualMatch,
  };
}

export function buildRuntimeDecisionTraceAlerts(
  row: RuntimeDecisionTraceReportRow,
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): RuntimeDecisionTraceAlert[] {
  const base = {
    source: row.source,
    traceVersion: row.traceVersion,
    createdAt: row.createdAt,
    actualRoute: row.actualRoute,
    shadowRoute: row.shadowRoute,
  };
  const alerts: RuntimeDecisionTraceAlert[] = [];

  if (row.shadowRoute === null && thresholds.alertOnMissingShadow) {
    alerts.push({
      ...base,
      code: "SHADOW_MISSING",
      severity: "warning",
      message: "Runtime trace has no shadow decision.",
      metrics: {},
    });
  }

  if (row.routeMatch === false) {
    alerts.push({
      ...base,
      code: "ROUTE_MISMATCH",
      severity: "critical",
      message: "Actual and shadow routes diverged.",
      metrics: {
        actualRoute: row.actualRoute,
        shadowRoute: row.shadowRoute,
      },
    });
  }

  if (row.basisMatch === false) {
    alerts.push({
      ...base,
      code: "BASIS_MISMATCH",
      severity: "critical",
      message: "Actual and shadow basis IDs diverged.",
      metrics: {
        actualBasisId: row.actualBasisId,
        shadowBasisId: row.shadowBasisId,
      },
    });
  }

  if (row.exactDqMatch === false && (row.dqDiffPct ?? 0) > thresholds.dqDiffPctWarn) {
    alerts.push({
      ...base,
      code: "DQ_MISMATCH",
      severity: "warning",
      message: "Actual and shadow proposed quantity diverged.",
      metrics: {
        dqDiffContracts: row.dqDiffContracts,
        dqDiffPct: row.dqDiffPct,
      },
    });
  }

  if (
    row.residualMatch === false ||
    Math.abs(row.residualNetQuantityDiff ?? 0) > thresholds.residualNetQuantityTolerance
  ) {
    alerts.push({
      ...base,
      code: "RESIDUAL_MISMATCH",
      severity: "warning",
      message: "Actual and shadow residual quantities diverged.",
      metrics: {
        residualNetQuantityDiff: row.residualNetQuantityDiff,
        actualResidualNetQuantity: row.actualResidualNetQuantity,
        shadowResidualNetQuantity: row.shadowResidualNetQuantity,
      },
    });
  }

  if (Math.abs(row.packageResidualRowDiff ?? 0) > thresholds.packageResidualRowDiffTolerance) {
    alerts.push({
      ...base,
      code: "PACKAGE_RESIDUAL_DRIFT",
      severity: "warning",
      message: "Actual and shadow package residual row counts diverged.",
      metrics: {
        packageResidualRowDiff: row.packageResidualRowDiff,
        actualPackageResidualRows: row.actualPackageResidualRows,
        shadowPackageResidualRows: row.shadowPackageResidualRows,
      },
    });
  }

  return alerts;
}

function categoryForAlert(alert: RuntimeDecisionTraceAlert): RuntimeMessageCategory {
  if (alert.code === "ROUTE_MISMATCH" || alert.code === "BASIS_MISMATCH") {
    return "instrument_error";
  }
  return "warning";
}

function scopeForCategory(category: RuntimeMessageCategory): RuntimeMessageScope {
  if (category === "major_error") return "system";
  if (category === "instrument_error") return "instrument";
  return "strategy";
}

function shouldNotify(category: RuntimeMessageCategory): boolean {
  return category === "major_error" || category === "instrument_error";
}

export function buildRuntimeTraceMessages(
  row: RuntimeDecisionTraceReportRow,
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): RuntimeTraceMessage[] {
  const alerts = buildRuntimeDecisionTraceAlerts(row, thresholds);
  if (alerts.length === 0) {
    return [{
      category: "info",
      scope: "strategy",
      notify: false,
      code: "TRACE_OK",
      source: row.source,
      traceVersion: row.traceVersion,
      createdAt: row.createdAt,
      affectedInstrumentIds: row.involvedInstrumentIds,
      message: "Runtime trace passed shadow gating thresholds.",
      metrics: {
        actualRoute: row.actualRoute,
        shadowRoute: row.shadowRoute,
      },
    }];
  }

  return alerts.map((alert) => {
    const category = categoryForAlert(alert);
    return {
      category,
      scope: scopeForCategory(category),
      notify: shouldNotify(category),
      code: alert.code,
      source: alert.source,
      traceVersion: alert.traceVersion,
      createdAt: alert.createdAt,
      affectedInstrumentIds: row.involvedInstrumentIds,
      message: alert.message,
      metrics: alert.metrics,
    };
  });
}

export function summarizeRuntimeTraceMessages(
  messages: readonly RuntimeTraceMessage[],
): RuntimeTraceMessageSummary {
  const counts = new Map<RuntimeMessageCategory, number>();
  for (const message of messages) {
    counts.set(message.category, (counts.get(message.category) ?? 0) + 1);
  }
  return {
    totalMessages: messages.length,
    majorErrorCount: counts.get("major_error") ?? 0,
    instrumentErrorCount: counts.get("instrument_error") ?? 0,
    warningCount: counts.get("warning") ?? 0,
    infoCount: counts.get("info") ?? 0,
    notifyCount: messages.filter((message) => message.notify).length,
    byCategory: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function statusRank(status: RuntimeDecisionTraceGateStatus): number {
  if (status === "fail") return 2;
  if (status === "warn") return 1;
  return 0;
}

function maxStatus(statuses: readonly RuntimeDecisionTraceGateStatus[]): RuntimeDecisionTraceGateStatus {
  return statuses.reduce<RuntimeDecisionTraceGateStatus>((current, next) =>
    statusRank(next) > statusRank(current) ? next : current
  , "pass");
}

export function buildRuntimeDecisionTraceGateVerdict(
  row: RuntimeDecisionTraceReportRow,
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): RuntimeDecisionTraceGateVerdict {
  const alerts = buildRuntimeDecisionTraceAlerts(row, thresholds);
  const criticalCount = alerts.filter((alert) => alert.severity === "critical").length;
  const warningCount = alerts.filter((alert) => alert.severity === "warning").length;
  return {
    status: criticalCount > 0 ? "fail" : (warningCount > 0 ? "warn" : "pass"),
    source: row.source,
    traceVersion: row.traceVersion,
    createdAt: row.createdAt,
    actualRoute: row.actualRoute,
    shadowRoute: row.shadowRoute,
    alertCount: alerts.length,
    warningCount,
    criticalCount,
    alertCodes: alerts.map((alert) => alert.code),
  };
}

export function summarizeRuntimeDecisionTraceHealth(
  rows: readonly RuntimeDecisionTraceReportRow[],
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): RuntimeDecisionTraceHealthSummary {
  const verdicts = rows.map((row) => buildRuntimeDecisionTraceGateVerdict(row, thresholds));
  const bySource = new Map<string, RuntimeDecisionTraceGateVerdict[]>();
  for (const verdict of verdicts) {
    const existing = bySource.get(verdict.source);
    if (existing) {
      existing.push(verdict);
    } else {
      bySource.set(verdict.source, [verdict]);
    }
  }

  return {
    status: maxStatus(verdicts.map((verdict) => verdict.status)),
    totalTraces: verdicts.length,
    passCount: verdicts.filter((verdict) => verdict.status === "pass").length,
    warnCount: verdicts.filter((verdict) => verdict.status === "warn").length,
    failCount: verdicts.filter((verdict) => verdict.status === "fail").length,
    bySource: [...bySource.entries()]
      .map(([source, sourceVerdicts]) => ({
        source,
        status: maxStatus(sourceVerdicts.map((verdict) => verdict.status)),
        totalTraces: sourceVerdicts.length,
        passCount: sourceVerdicts.filter((verdict) => verdict.status === "pass").length,
        warnCount: sourceVerdicts.filter((verdict) => verdict.status === "warn").length,
        failCount: sourceVerdicts.filter((verdict) => verdict.status === "fail").length,
      }))
      .sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.totalTraces - a.totalTraces),
  };
}

export function summarizeRuntimeDecisionTraceRows(
  rows: readonly RuntimeDecisionTraceReportRow[],
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): RuntimeDecisionTraceSummary {
  const totalTraces = rows.length;
  const sourceCounts = new Map<string, number>();
  const routeMismatchCounts = new Map<string, { actualRoute: string; shadowRoute: string; count: number }>();
  const alertCounts = new Map<RuntimeDecisionTraceAlertCode, number>();
  const dqDiffValues = rows
    .map((row) => row.dqDiffPct)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const residualDiffValues = rows
    .map((row) => row.residualNetQuantityDiff)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  for (const row of rows) {
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
    if (row.routeMatch === false && row.shadowRoute !== null) {
      const key = `${row.actualRoute}=>${row.shadowRoute}`;
      const current = routeMismatchCounts.get(key);
      if (current) {
        current.count += 1;
      } else {
        routeMismatchCounts.set(key, {
          actualRoute: row.actualRoute,
          shadowRoute: row.shadowRoute,
          count: 1,
        });
      }
    }
    for (const alert of buildRuntimeDecisionTraceAlerts(row, thresholds)) {
      alertCounts.set(alert.code, (alertCounts.get(alert.code) ?? 0) + 1);
    }
  }

  const routeMismatchCount = rows.filter((row) => row.routeMatch === false).length;
  const exactDqMismatchCount = rows.filter((row) => row.exactDqMatch === false).length;
  const basisMismatchCount = rows.filter((row) => row.basisMatch === false).length;
  const residualMismatchCount = rows.filter((row) => row.residualMatch === false).length;
  const packageResidualDriftCount = rows.filter((row) =>
    Math.abs(row.packageResidualRowDiff ?? 0) > thresholds.packageResidualRowDiffTolerance
  ).length;

  return {
    totalTraces,
    shadowMissingCount: rows.filter((row) => row.shadowRoute === null).length,
    routeMismatchCount,
    routeMismatchRate: rate(routeMismatchCount, totalTraces),
    exactDqMismatchCount,
    exactDqMismatchRate: rate(exactDqMismatchCount, totalTraces),
    basisMismatchCount,
    residualMismatchCount,
    packageResidualDriftCount,
    avgDqDiffPct: dqDiffValues.length > 0
      ? dqDiffValues.reduce((sum, value) => sum + value, 0) / dqDiffValues.length
      : null,
    maxDqDiffPct: dqDiffValues.length > 0
      ? dqDiffValues.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY)
      : null,
    maxAbsResidualNetQuantityDiff: residualDiffValues.length > 0
      ? residualDiffValues.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
      : null,
    sourceBreakdown: [...sourceCounts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    topRouteMismatches: [...routeMismatchCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    alertCount: [...alertCounts.values()].reduce((sum, count) => sum + count, 0),
    alertBreakdown: [...alertCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function summarizeRuntimeDecisionTraces(
  inputs: readonly { readonly trace: RuntimeDecisionTrace; readonly createdAt?: number | null }[],
  thresholds: RuntimeDecisionTraceAlertThresholds = DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
): {
  readonly rows: RuntimeDecisionTraceReportRow[];
  readonly summary: RuntimeDecisionTraceSummary;
  readonly health: RuntimeDecisionTraceHealthSummary;
  readonly verdicts: RuntimeDecisionTraceGateVerdict[];
  readonly alerts: RuntimeDecisionTraceAlert[];
  readonly messages: RuntimeTraceMessage[];
  readonly messageSummary: RuntimeTraceMessageSummary;
  readonly notifyMessages: RuntimeTraceMessage[];
} {
  const rows = inputs.map((input) => buildRuntimeDecisionTraceReportRow(input));
  const messages = rows.flatMap((row) => buildRuntimeTraceMessages(row, thresholds));
  return {
    rows,
    summary: summarizeRuntimeDecisionTraceRows(rows, thresholds),
    health: summarizeRuntimeDecisionTraceHealth(rows, thresholds),
    verdicts: rows.map((row) => buildRuntimeDecisionTraceGateVerdict(row, thresholds)),
    alerts: rows.flatMap((row) => buildRuntimeDecisionTraceAlerts(row, thresholds)),
    messages,
    messageSummary: summarizeRuntimeTraceMessages(messages),
    notifyMessages: messages.filter((message) => message.notify),
  };
}
