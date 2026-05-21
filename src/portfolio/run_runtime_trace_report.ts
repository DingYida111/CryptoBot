import { getDb, insertRuntimeMessage } from "../monitor/storage.js";
import { sendRuntimeNotifications } from "../runtime/runtime_notifications.js";
import {
  buildRuntimeTraceMessages,
  DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
  isRuntimeDecisionTrace,
  summarizeRuntimeDecisionTraces,
  type RuntimeDecisionTraceAlertThresholds,
  type RuntimeTraceMessage,
} from "./decision_trace_report.js";
import type { RuntimeDecisionTrace } from "./portfolio_types.js";

interface CliOptions {
  readonly limit: number;
  readonly source: string | null;
  readonly version: string | null;
  readonly allVersions: boolean;
  readonly thresholds: RuntimeDecisionTraceAlertThresholds;
  readonly persistMessages: boolean;
  readonly notifyDryRun: boolean;
  readonly notify: boolean;
  readonly webhookUrl: string | null;
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

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 200;
  let source: string | null = null;
  let version: string | null = null;
  let allVersions = false;
  let persistMessages = false;
  let notifyDryRun = false;
  let notify = false;
  let webhookUrl = process.env.RUNTIME_NOTIFY_WEBHOOK_URL ?? null;
  const thresholds = { ...DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--source") {
      const next = argv[index + 1];
      if (next) {
        source = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--version") {
      const next = argv[index + 1];
      if (next) {
        version = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--all") {
      allVersions = true;
      continue;
    }
    if (arg === "--dq-pct-warn") {
      const parsed = parsePositiveNumber(argv[index + 1]);
      if (parsed !== null) {
        thresholds.dqDiffPctWarn = parsed;
        index += 1;
      }
      continue;
    }
    if (arg === "--residual-tolerance") {
      const parsed = parsePositiveNumber(argv[index + 1]);
      if (parsed !== null) {
        thresholds.residualNetQuantityTolerance = parsed;
        index += 1;
      }
      continue;
    }
    if (arg === "--package-row-tolerance") {
      const parsed = parsePositiveNumber(argv[index + 1]);
      if (parsed !== null) {
        thresholds.packageResidualRowDiffTolerance = parsed;
        index += 1;
      }
      continue;
    }
    if (arg === "--ignore-missing-shadow") {
      thresholds.alertOnMissingShadow = false;
      continue;
    }
    if (arg === "--persist-messages") {
      persistMessages = true;
      continue;
    }
    if (arg === "--notify-dry-run") {
      notifyDryRun = true;
      continue;
    }
    if (arg === "--notify") {
      notify = true;
      continue;
    }
    if (arg === "--webhook-url") {
      const next = argv[index + 1];
      if (next) {
        webhookUrl = next;
        index += 1;
      }
      continue;
    }
    const parsed = Number(arg);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.floor(parsed);
    }
  }

  return {
    limit,
    source,
    version,
    allVersions,
    thresholds,
    persistMessages,
    notifyDryRun,
    notify,
    webhookUrl,
  };
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

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const shadowRows = queryRows({
    tableName: "portfolio_shadow_log",
    source: options.source,
    version: options.version,
    allVersions: options.allVersions,
    limit: options.limit,
  });
  const snapshotRows = queryRows({
    tableName: "portfolio_snapshots",
    source: options.source,
    version: options.version,
    allVersions: options.allVersions,
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

  const traceReport = summarizeRuntimeDecisionTraces(traces, options.thresholds);
  const messagesWithSurface = traceReport.rows.flatMap((row, index) =>
    buildRuntimeTraceMessages(row, options.thresholds).map((message) => ({
      message,
      surface: traces[index]?.surface ?? "unknown",
      rowId: traces[index]?.rowId ?? 0,
    }))
  );
  const emittedAt = Date.now();
  const persistedMessageCount = options.persistMessages
    ? messagesWithSurface.filter((row) => insertRuntimeMessage({
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
      })).length
    : 0;
  const notificationMessages = messagesWithSurface
    .map((row) => row.message)
    .filter((message): message is RuntimeTraceMessage => message.notify);
  const notificationResults = (options.notify || options.notifyDryRun)
    ? await sendRuntimeNotifications(notificationMessages, {
        dryRun: options.notifyDryRun || !options.notify,
        webhookUrl: options.webhookUrl,
        consoleSink: true,
      })
    : [];

  console.log(JSON.stringify({
    limit: options.limit,
    source: options.source,
    version: options.allVersions ? null : options.version,
    allVersions: options.allVersions,
    thresholds: options.thresholds,
    messagePersistence: {
      enabled: options.persistMessages,
      insertedCount: persistedMessageCount,
      candidateCount: messagesWithSurface.length,
    },
    notification: {
      enabled: options.notify || options.notifyDryRun,
      dryRun: options.notifyDryRun || !options.notify,
      webhookConfigured: Boolean(options.webhookUrl?.trim()),
      results: notificationResults,
    },
    surfaces: {
      portfolioShadowLogRows: shadowRows.length,
      portfolioSnapshotsRows: snapshotRows.length,
      extractedTraces: traces.length,
    },
    traceHealth: traceReport.health,
    traceSummary: traceReport.summary,
    messageSummary: traceReport.messageSummary,
    recentTraceVerdicts: traceReport.verdicts.slice(0, 50).map((verdict, index) => ({
      ...verdict,
      surface: traces[index]?.surface ?? null,
      rowId: traces[index]?.rowId ?? null,
    })),
    notifyMessages: traceReport.notifyMessages.slice(0, 50),
    recentMessages: traceReport.messages.slice(0, 50),
    recentTraceAlerts: traceReport.alerts.slice(0, 50),
    recentTraceRows: traceReport.rows.slice(0, 20),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
