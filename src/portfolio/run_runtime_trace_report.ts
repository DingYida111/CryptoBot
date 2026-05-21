import {
  DEFAULT_RUNTIME_TRACE_ALERT_THRESHOLDS,
  type RuntimeDecisionTraceAlertThresholds,
} from "./decision_trace_report.js";
import { observeRuntimeTraces } from "../runtime/runtime_trace_observer.js";

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

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await observeRuntimeTraces(options);
  const traceReport = result.traceReport;

  console.log(JSON.stringify({
    limit: result.limit,
    source: result.source,
    version: result.version,
    allVersions: result.allVersions,
    thresholds: result.thresholds,
    messagePersistence: result.messagePersistence,
    notification: result.notification,
    surfaces: result.surfaces,
    traceHealth: traceReport.health,
    traceSummary: traceReport.summary,
    messageSummary: traceReport.messageSummary,
    recentTraceVerdicts: traceReport.verdicts.slice(0, 50).map((verdict, index) => ({
      ...verdict,
      surface: result.traces[index]?.surface ?? null,
      rowId: result.traces[index]?.rowId ?? null,
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
