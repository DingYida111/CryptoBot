import { insertRuntimeMessage } from "../monitor/storage.js";
import type { RuntimeTraceMessage } from "../portfolio/decision_trace_report.js";
import { sendRuntimeNotifications } from "./runtime_notifications.js";

interface CliOptions {
  readonly persistMessages: boolean;
  readonly notify: boolean;
  readonly notifyDryRun: boolean;
  readonly webhookUrl: string | null;
  readonly unique: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let persistMessages = false;
  let notify = false;
  let notifyDryRun = true;
  let webhookUrl = process.env.RUNTIME_NOTIFY_WEBHOOK_URL ?? null;
  let unique = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--persist-messages") {
      persistMessages = true;
      continue;
    }
    if (arg === "--notify") {
      notify = true;
      notifyDryRun = false;
      continue;
    }
    if (arg === "--notify-dry-run") {
      notifyDryRun = true;
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
    if (arg === "--unique") {
      unique = true;
    }
  }

  return {
    persistMessages,
    notify,
    notifyDryRun,
    webhookUrl,
    unique,
  };
}

function sampleInstrumentError(createdAt: number): RuntimeTraceMessage {
  return {
    category: "instrument_error",
    scope: "instrument",
    notify: true,
    code: "ROUTE_MISMATCH",
    source: "runtime_message_self_test",
    traceVersion: "self-test-v1",
    createdAt,
    affectedInstrumentIds: ["OKX:BTC-USDT-SWAP"],
    message: "Self-test instrument error: validates persistence and notification plumbing without trading action.",
    metrics: {
      selfTest: true,
      actualRoute: "open_long",
      shadowRoute: "close_long",
    },
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const now = Date.now();
  const message = sampleInstrumentError(now);
  const surfaceRowId = options.unique ? now : 1;
  const persisted = options.persistMessages
    ? insertRuntimeMessage({
        surface: "self_test",
        surfaceRowId,
        code: message.code,
        category: message.category,
        scope: message.scope,
        source: message.source,
        traceVersion: message.traceVersion,
        affectedInstrumentIdsJson: JSON.stringify(message.affectedInstrumentIds),
        notify: message.notify,
        message: message.message,
        metricsJson: JSON.stringify(message.metrics),
        rawJson: JSON.stringify(message),
        createdAt: message.createdAt ?? now,
        emittedAt: now,
      })
    : false;
  const notificationResults = (options.notify || options.notifyDryRun)
    ? await sendRuntimeNotifications([message], {
        dryRun: options.notifyDryRun || !options.notify,
        webhookUrl: options.webhookUrl,
        consoleSink: true,
      })
    : [];

  console.log(JSON.stringify({
    selfTest: true,
    persistMessages: options.persistMessages,
    persisted,
    surface: "self_test",
    surfaceRowId,
    notification: {
      enabled: options.notify || options.notifyDryRun,
      dryRun: options.notifyDryRun || !options.notify,
      webhookConfigured: Boolean(options.webhookUrl?.trim()),
      results: notificationResults,
    },
    message,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
