import { getDb, insertRuntimeAction, insertRuntimeMessage } from "../monitor/storage.js";
import {
  buildRuntimeTraceMessages,
  DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
  isRuntimeDecisionTrace,
  summarizeRuntimeDecisionTraces,
  type RuntimeDecisionTraceAlertThresholds,
  type RuntimeTraceMessage,
} from "../portfolio/decision_trace_report.js";
import type { RuntimeDecisionTrace } from "../portfolio/portfolio_types.js";
import { buildRuntimeActionsForMessage, type RuntimeProposedAction } from "./runtime_actions.js";
import { sendRuntimeNotifications, type RuntimeNotificationResult } from "./runtime_notifications.js";

export interface RuntimeTraceObserverOptions {
  readonly limit: number;
  readonly source?: string | null;
  readonly version?: string | null;
  readonly allVersions?: boolean;
  readonly thresholds?: RuntimeDecisionTraceAlertThresholds;
  readonly persistMessages: boolean;
  readonly persistInfoMessages?: boolean;
  readonly persistActions?: boolean;
  readonly notifyDryRun: boolean;
  readonly notify: boolean;
  readonly webhookUrl?: string | null;
}

export interface RuntimeTraceObserverResult {
  readonly limit: number;
  readonly source: string | null;
  readonly version: string | null;
  readonly allVersions: boolean;
  readonly thresholds: RuntimeDecisionTraceAlertThresholds;
  readonly messagePersistence: {
    readonly enabled: boolean;
    readonly insertedCount: number;
    readonly candidateCount: number;
    readonly persistedCandidateCount: number;
    readonly suppressedInfoCount: number;
  };
  readonly notification: {
    readonly enabled: boolean;
    readonly dryRun: boolean;
    readonly webhookConfigured: boolean;
    readonly candidateCount: number;
    readonly results: readonly RuntimeNotificationResult[];
  };
  readonly actionPersistence: {
    readonly enabled: boolean;
    readonly executionEnabled: boolean;
    readonly insertedCount: number;
    readonly candidateCount: number;
    readonly suppressedInfoCount: number;
  };
  readonly surfaces: {
    readonly portfolioShadowLogRows: number;
    readonly portfolioSnapshotsRows: number;
    readonly extractedTraces: number;
  };
  readonly traceReport: ReturnType<typeof summarizeRuntimeDecisionTraces>;
  readonly traces: readonly TraceInput[];
}

interface TraceInput {
  readonly trace: RuntimeDecisionTrace;
  readonly createdAt: number | null;
  readonly surface: "portfolio_shadow_log" | "portfolio_snapshots";
  readonly rowId: number;
}

interface RawTraceRow {
  readonly id: number;
  readonly source: string;
  readonly shadow_version: string | null;
  readonly raw_json: string;
  readonly created_at: number;
}

interface RuntimeTraceMessageWithSurface {
  readonly message: RuntimeTraceMessage;
  readonly surface: string;
  readonly rowId: number;
}

interface RuntimeActionWithSurface {
  readonly action: RuntimeProposedAction;
  readonly surface: string;
  readonly rowId: number;
}

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toTraceInput(
  row: RawTraceRow,
  surface: TraceInput["surface"],
): TraceInput | null {
  const parsed = safeParseJson(row.raw_json);
  const trace = parsed?.decisionTrace;
  if (!isRuntimeDecisionTrace(trace)) return null;
  return {
    trace,
    createdAt: row.created_at,
    surface,
    rowId: row.id,
  };
}

function sourceFilter(source: string | null): string {
  return source === null ? "" : " AND source = ?";
}

function versionFilter(version: string | null, allVersions: boolean): string {
  if (allVersions || version === null) return "";
  return " AND shadow_version = ?";
}

function queryRows(input: {
  readonly tableName: "portfolio_shadow_log" | "portfolio_snapshots";
  readonly source: string | null;
  readonly version: string | null;
  readonly allVersions: boolean;
  readonly limit: number;
}): RawTraceRow[] {
  const db = getDb();
  const params: Array<string | number> = [];
  if (input.source !== null) params.push(input.source);
  if (!input.allVersions && input.version !== null) params.push(input.version);
  params.push(input.limit);
  return db.prepare(`
    SELECT id, source, shadow_version, raw_json, created_at
    FROM ${input.tableName}
    WHERE raw_json IS NOT NULL
      ${sourceFilter(input.source)}
      ${versionFilter(input.version, input.allVersions)}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params) as RawTraceRow[];
}

function persistMessage(row: RuntimeTraceMessageWithSurface, emittedAt: number): boolean {
  return insertRuntimeMessage({
    surface: row.surface,
    surfaceRowId: row.rowId,
    code: row.message.code,
    category: row.message.category,
    scope: row.message.scope,
    source: row.message.source,
    traceVersion: row.message.traceVersion,
    affectedInstrumentIdsJson: JSON.stringify(row.message.affectedInstrumentIds),
    notify: row.message.notify,
    message: row.message.message,
    metricsJson: JSON.stringify(row.message.metrics),
    rawJson: JSON.stringify(row.message),
    createdAt: row.message.createdAt ?? emittedAt,
    emittedAt,
  });
}

function persistAction(row: RuntimeActionWithSurface, proposedAt: number): boolean {
  return insertRuntimeAction({
    surface: row.surface,
    surfaceRowId: row.rowId,
    messageCode: row.action.messageCode,
    category: row.action.category,
    scope: row.action.scope,
    source: row.action.source,
    traceVersion: row.action.traceVersion,
    actionType: row.action.actionType,
    status: row.action.status,
    executionEnabled: row.action.executionEnabled,
    affectedInstrumentIdsJson: JSON.stringify(row.action.affectedInstrumentIds),
    reason: row.action.reason,
    rawJson: JSON.stringify(row.action),
    createdAt: row.action.createdAt ?? proposedAt,
    proposedAt,
  });
}

export function shouldPersistRuntimeTraceMessage(
  message: RuntimeTraceMessage,
  persistInfoMessages = false,
): boolean {
  return persistInfoMessages || message.category !== "info";
}

export async function observeRuntimeTraces(
  options: RuntimeTraceObserverOptions,
): Promise<RuntimeTraceObserverResult> {
  const source = options.source ?? null;
  const version = options.version ?? null;
  const allVersions = options.allVersions ?? false;
  const thresholds = options.thresholds ?? DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS;

  const shadowRows = queryRows({
    tableName: "portfolio_shadow_log",
    source,
    version,
    allVersions,
    limit: options.limit,
  });
  const snapshotRows = queryRows({
    tableName: "portfolio_snapshots",
    source,
    version,
    allVersions,
    limit: options.limit,
  });
  const traces = [
    ...shadowRows
      .map((row) => toTraceInput(row, "portfolio_shadow_log"))
      .filter((row): row is TraceInput => row !== null),
    ...snapshotRows
      .map((row) => toTraceInput(row, "portfolio_snapshots"))
      .filter((row): row is TraceInput => row !== null),
  ]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, options.limit);

  const traceReport = summarizeRuntimeDecisionTraces(traces, thresholds);
  const messagesWithSurface = traceReport.rows.flatMap((row, index) =>
    buildRuntimeTraceMessages(row, thresholds).map((message) => ({
      message,
      surface: traces[index]?.surface ?? "unknown",
      rowId: traces[index]?.rowId ?? 0,
    }))
  );
  const persistableMessages = messagesWithSurface.filter((row) =>
    shouldPersistRuntimeTraceMessage(row.message, options.persistInfoMessages ?? false)
  );
  const actionMessages = messagesWithSurface.filter((row) =>
    shouldPersistRuntimeTraceMessage(row.message, options.persistInfoMessages ?? false)
  );
  const actionRows = actionMessages.flatMap((row) =>
    buildRuntimeActionsForMessage(row.message, { executionEnabled: false }).map((action) => ({
      action,
      surface: row.surface,
      rowId: row.rowId,
    }))
  );

  const emittedAt = Date.now();
  const insertedMessages = options.persistMessages
    ? persistableMessages.filter((row) => persistMessage(row, emittedAt))
    : [];
  const insertedActions = options.persistActions
    ? actionRows.filter((row) => persistAction(row, emittedAt))
    : [];
  const notificationMessages = (options.persistMessages ? insertedMessages : messagesWithSurface)
    .map((row) => row.message)
    .filter((message): message is RuntimeTraceMessage => message.notify);
  const notificationResults = (options.notify || options.notifyDryRun)
    ? await sendRuntimeNotifications(notificationMessages, {
        dryRun: options.notifyDryRun || !options.notify,
        webhookUrl: options.webhookUrl ?? null,
        consoleSink: true,
      })
    : [];

  return {
    limit: options.limit,
    source,
    version: allVersions ? null : version,
    allVersions,
    thresholds,
    messagePersistence: {
      enabled: options.persistMessages,
      insertedCount: insertedMessages.length,
      candidateCount: messagesWithSurface.length,
      persistedCandidateCount: persistableMessages.length,
      suppressedInfoCount: messagesWithSurface.length - persistableMessages.length,
    },
    notification: {
      enabled: options.notify || options.notifyDryRun,
      dryRun: options.notifyDryRun || !options.notify,
      webhookConfigured: Boolean(options.webhookUrl?.trim()),
      candidateCount: notificationMessages.length,
      results: notificationResults,
    },
    actionPersistence: {
      enabled: options.persistActions ?? false,
      executionEnabled: false,
      insertedCount: insertedActions.length,
      candidateCount: actionRows.length,
      suppressedInfoCount: messagesWithSurface.length - actionMessages.length,
    },
    surfaces: {
      portfolioShadowLogRows: shadowRows.length,
      portfolioSnapshotsRows: snapshotRows.length,
      extractedTraces: traces.length,
    },
    traceReport,
    traces,
  };
}
