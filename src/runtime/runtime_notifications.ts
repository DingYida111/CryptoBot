import type { RuntimeTraceMessage } from "../portfolio/decision_trace_report.js";

export interface RuntimeNotificationOptions {
  readonly dryRun: boolean;
  readonly webhookUrl?: string | null;
  readonly consoleSink?: boolean;
}

export interface RuntimeNotificationResult {
  readonly sink: "console" | "webhook";
  readonly dryRun: boolean;
  readonly delivered: boolean;
  readonly messageCount: number;
  readonly statusCode?: number;
  readonly error?: string;
}

function formatMessage(message: RuntimeTraceMessage): string {
  const instruments = message.affectedInstrumentIds.length > 0
    ? message.affectedInstrumentIds.join(",")
    : "none";
  return [
    `[${message.category}] ${message.code}`,
    `source=${message.source}`,
    `scope=${message.scope}`,
    `instruments=${instruments}`,
    message.message,
  ].join(" | ");
}

function buildWebhookPayload(messages: readonly RuntimeTraceMessage[]): Record<string, unknown> {
  return {
    source: "cryptobot",
    messageCount: messages.length,
    categories: [...new Set(messages.map((message) => message.category))],
    messages: messages.map((message) => ({
      category: message.category,
      scope: message.scope,
      code: message.code,
      source: message.source,
      traceVersion: message.traceVersion,
      createdAt: message.createdAt,
      affectedInstrumentIds: message.affectedInstrumentIds,
      message: message.message,
      metrics: message.metrics,
    })),
  };
}

export async function sendRuntimeNotifications(
  messages: readonly RuntimeTraceMessage[],
  options: RuntimeNotificationOptions,
): Promise<RuntimeNotificationResult[]> {
  if (messages.length === 0) return [];

  const results: RuntimeNotificationResult[] = [];
  if (options.consoleSink ?? true) {
    for (const message of messages) {
      console.log(options.dryRun
        ? `[notification:dry-run] ${formatMessage(message)}`
        : `[notification] ${formatMessage(message)}`
      );
    }
    results.push({
      sink: "console",
      dryRun: options.dryRun,
      delivered: !options.dryRun,
      messageCount: messages.length,
    });
  }

  if (options.webhookUrl && options.webhookUrl.trim().length > 0) {
    if (options.dryRun) {
      results.push({
        sink: "webhook",
        dryRun: true,
        delivered: false,
        messageCount: messages.length,
      });
    } else {
      try {
        const response = await fetch(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildWebhookPayload(messages)),
        });
        results.push({
          sink: "webhook",
          dryRun: false,
          delivered: response.ok,
          messageCount: messages.length,
          statusCode: response.status,
          error: response.ok ? undefined : await response.text(),
        });
      } catch (error) {
        results.push({
          sink: "webhook",
          dryRun: false,
          delivered: false,
          messageCount: messages.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results;
}
