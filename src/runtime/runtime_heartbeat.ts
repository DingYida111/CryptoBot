import os from "os";
import { randomUUID } from "crypto";
import {
  getActiveRuntimeMaintenanceLease,
  getRuntimeAgentHeartbeat,
  insertRuntimeAction,
  insertRuntimeMessage,
  insertRuntimeWatchdogEvaluation,
  upsertRuntimeAgentHeartbeat,
  upsertRuntimeMaintenanceLease,
  type RuntimeAgentHeartbeatRow,
  type RuntimeMaintenanceLeaseRow,
} from "../monitor/storage.js";
import type { RuntimeTraceMessage } from "../portfolio/decision_trace_report.js";
import { buildRuntimeActionsForMessage } from "./runtime_actions.js";
import { sendRuntimeNotifications } from "./runtime_notifications.js";

export type RuntimeHeartbeatHealthStatus =
  | "healthy"
  | "stale"
  | "maintenance_grace"
  | "disconnected"
  | "missing";

export interface RuntimeHeartbeatMetadata {
  readonly managedStrategyInstances?: readonly string[];
  readonly managedInstruments?: readonly string[];
  readonly note?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeHeartbeatRecordInput {
  readonly agentId: string;
  readonly role: string;
  readonly pid?: number | null;
  readonly hostname?: string | null;
  readonly commitSha?: string | null;
  readonly status?: string;
  readonly metadata?: RuntimeHeartbeatMetadata;
  readonly heartbeatAt?: number;
}

export interface RuntimeMaintenanceLeaseInput {
  readonly agentId: string;
  readonly leaseId?: string;
  readonly reason: string;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly startsAt?: number;
}

export interface RuntimeHeartbeatEvaluationInput {
  readonly agentId: string;
  readonly heartbeat: RuntimeAgentHeartbeatRow | null;
  readonly maintenanceLease: RuntimeMaintenanceLeaseRow | null;
  readonly now: number;
  readonly staleAfterMs: number;
  readonly disconnectAfterMs: number;
  readonly maintenanceGraceMs: number;
  readonly affectedInstrumentIds?: readonly string[];
}

export interface RuntimeHeartbeatEvaluation {
  readonly agentId: string;
  readonly status: RuntimeHeartbeatHealthStatus;
  readonly heartbeatAgeMs: number | null;
  readonly staleAfterMs: number;
  readonly disconnectAfterMs: number;
  readonly maintenanceActive: boolean;
  readonly maintenanceExpiresAt: number | null;
  readonly maintenanceGraceUntil: number | null;
  readonly message: RuntimeTraceMessage;
}

export interface RuntimeWatchdogOptions {
  readonly agentId: string;
  readonly staleAfterMs?: number;
  readonly disconnectAfterMs?: number;
  readonly maintenanceGraceMs?: number;
  readonly affectedInstrumentIds?: readonly string[];
  readonly persistMessages?: boolean;
  readonly persistInfoMessages?: boolean;
  readonly persistActions?: boolean;
  readonly notifyDryRun?: boolean;
  readonly notify?: boolean;
  readonly webhookUrl?: string | null;
  readonly now?: number;
}

export interface RuntimeWatchdogResult {
  readonly evaluationId: number;
  readonly evaluation: RuntimeHeartbeatEvaluation;
  readonly messagePersistence: {
    readonly enabled: boolean;
    readonly inserted: boolean;
  };
  readonly actionPersistence: {
    readonly enabled: boolean;
    readonly candidateCount: number;
    readonly insertedCount: number;
  };
  readonly notification: {
    readonly enabled: boolean;
    readonly dryRun: boolean;
    readonly resultCount: number;
  };
}

const WATCHDOG_TRACE_VERSION = "runtime-watchdog-v1";

function parseMetadata(value: string | null | undefined): RuntimeHeartbeatMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RuntimeHeartbeatMetadata
      : {};
  } catch {
    return {};
  }
}

function messageForEvaluation(input: {
  readonly agentId: string;
  readonly status: RuntimeHeartbeatHealthStatus;
  readonly heartbeatAgeMs: number | null;
  readonly staleAfterMs: number;
  readonly disconnectAfterMs: number;
  readonly maintenanceActive: boolean;
  readonly maintenanceExpiresAt: number | null;
  readonly maintenanceGraceUntil: number | null;
  readonly affectedInstrumentIds: readonly string[];
  readonly now: number;
}): RuntimeTraceMessage {
  const metrics = {
    heartbeatAgeMs: input.heartbeatAgeMs,
    staleAfterMs: input.staleAfterMs,
    disconnectAfterMs: input.disconnectAfterMs,
    maintenanceActive: input.maintenanceActive,
    maintenanceExpiresAt: input.maintenanceExpiresAt,
    maintenanceGraceUntil: input.maintenanceGraceUntil,
  };

  if (input.status === "disconnected" || input.status === "missing") {
    return {
      category: "major_error",
      scope: "system",
      notify: true,
      code: "AGENT_HEARTBEAT_DISCONNECTED",
      source: "runtime_watchdog",
      traceVersion: WATCHDOG_TRACE_VERSION,
      createdAt: input.now,
      affectedInstrumentIds: input.affectedInstrumentIds,
      message: `Runtime agent ${input.agentId} heartbeat is disconnected for more than ${input.disconnectAfterMs}ms.`,
      metrics,
    };
  }

  if (input.status === "stale") {
    return {
      category: "warning",
      scope: "system",
      notify: false,
      code: "AGENT_HEARTBEAT_STALE",
      source: "runtime_watchdog",
      traceVersion: WATCHDOG_TRACE_VERSION,
      createdAt: input.now,
      affectedInstrumentIds: input.affectedInstrumentIds,
      message: `Runtime agent ${input.agentId} heartbeat is stale but has not crossed the disconnect threshold.`,
      metrics,
    };
  }

  if (input.status === "maintenance_grace") {
    return {
      category: "warning",
      scope: "system",
      notify: false,
      code: "AGENT_MAINTENANCE_ACTIVE",
      source: "runtime_watchdog",
      traceVersion: WATCHDOG_TRACE_VERSION,
      createdAt: input.now,
      affectedInstrumentIds: input.affectedInstrumentIds,
      message: `Runtime agent ${input.agentId} heartbeat is stale during an active maintenance lease.`,
      metrics,
    };
  }

  return {
    category: "info",
    scope: "system",
    notify: false,
    code: "AGENT_HEARTBEAT_OK",
    source: "runtime_watchdog",
    traceVersion: WATCHDOG_TRACE_VERSION,
    createdAt: input.now,
    affectedInstrumentIds: input.affectedInstrumentIds,
    message: `Runtime agent ${input.agentId} heartbeat is healthy.`,
    metrics,
  };
}

export function evaluateRuntimeHeartbeat(input: RuntimeHeartbeatEvaluationInput): RuntimeHeartbeatEvaluation {
  const heartbeatAgeMs = input.heartbeat ? Math.max(0, input.now - input.heartbeat.last_heartbeat_at) : null;
  const maintenanceActive = Boolean(input.maintenanceLease);
  const maintenanceExpiresAt = input.maintenanceLease?.expires_at ?? null;
  const maintenanceGraceUntil = maintenanceExpiresAt === null
    ? null
    : maintenanceExpiresAt + input.maintenanceGraceMs;

  let status: RuntimeHeartbeatHealthStatus;
  if (heartbeatAgeMs === null) {
    status = maintenanceActive ? "maintenance_grace" : "missing";
  } else if (heartbeatAgeMs <= input.staleAfterMs) {
    status = "healthy";
  } else if (heartbeatAgeMs <= input.disconnectAfterMs) {
    status = "stale";
  } else if (
    maintenanceActive &&
    maintenanceGraceUntil !== null &&
    input.now <= maintenanceGraceUntil
  ) {
    status = "maintenance_grace";
  } else {
    status = "disconnected";
  }

  return {
    agentId: input.agentId,
    status,
    heartbeatAgeMs,
    staleAfterMs: input.staleAfterMs,
    disconnectAfterMs: input.disconnectAfterMs,
    maintenanceActive,
    maintenanceExpiresAt,
    maintenanceGraceUntil,
    message: messageForEvaluation({
      agentId: input.agentId,
      status,
      heartbeatAgeMs,
      staleAfterMs: input.staleAfterMs,
      disconnectAfterMs: input.disconnectAfterMs,
      maintenanceActive,
      maintenanceExpiresAt,
      maintenanceGraceUntil,
      affectedInstrumentIds: input.affectedInstrumentIds ?? [],
      now: input.now,
    }),
  };
}

export function recordRuntimeAgentHeartbeat(input: RuntimeHeartbeatRecordInput): void {
  const heartbeatAt = input.heartbeatAt ?? Date.now();
  upsertRuntimeAgentHeartbeat({
    agentId: input.agentId,
    role: input.role,
    pid: input.pid ?? process.pid,
    hostname: input.hostname ?? os.hostname(),
    commitSha: input.commitSha ?? process.env.CRYPTOBOT_COMMIT_SHA ?? null,
    status: input.status ?? "running",
    metadataJson: JSON.stringify(input.metadata ?? {}),
    heartbeatAt,
    createdAt: heartbeatAt,
  });
}

export function createRuntimeMaintenanceLease(input: RuntimeMaintenanceLeaseInput): string {
  const startsAt = input.startsAt ?? Date.now();
  const leaseId = input.leaseId ?? `${input.agentId}-${randomUUID()}`;
  upsertRuntimeMaintenanceLease({
    leaseId,
    agentId: input.agentId,
    reason: input.reason,
    active: true,
    metadataJson: JSON.stringify(input.metadata ?? {}),
    startsAt,
    expiresAt: startsAt + input.durationMs,
    createdAt: startsAt,
    updatedAt: startsAt,
  });
  return leaseId;
}

export async function runRuntimeWatchdog(options: RuntimeWatchdogOptions): Promise<RuntimeWatchdogResult> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const disconnectAfterMs = options.disconnectAfterMs ?? 120_000;
  const maintenanceGraceMs = options.maintenanceGraceMs ?? 120_000;
  const heartbeat = getRuntimeAgentHeartbeat(options.agentId);
  const maintenanceLease = getActiveRuntimeMaintenanceLease({ agentId: options.agentId, now });
  const heartbeatMetadata = parseMetadata(heartbeat?.metadata_json);
  const affectedInstrumentIds = options.affectedInstrumentIds
    ?? heartbeatMetadata.managedInstruments
    ?? [];
  const evaluation = evaluateRuntimeHeartbeat({
    agentId: options.agentId,
    heartbeat,
    maintenanceLease,
    now,
    staleAfterMs,
    disconnectAfterMs,
    maintenanceGraceMs,
    affectedInstrumentIds,
  });
  const evaluationId = insertRuntimeWatchdogEvaluation({
    agentId: options.agentId,
    status: evaluation.status,
    heartbeatAgeMs: evaluation.heartbeatAgeMs,
    staleAfterMs,
    disconnectAfterMs,
    maintenanceActive: evaluation.maintenanceActive,
    maintenanceExpiresAt: evaluation.maintenanceExpiresAt,
    messageCode: evaluation.message.code,
    rawJson: JSON.stringify(evaluation),
    createdAt: now,
  });

  const shouldPersistMessage = Boolean(options.persistMessages) &&
    (evaluation.message.category !== "info" || Boolean(options.persistInfoMessages));
  const insertedMessage = shouldPersistMessage
    ? insertRuntimeMessage({
        surface: "runtime_watchdog_evaluations",
        surfaceRowId: evaluationId,
        code: evaluation.message.code,
        category: evaluation.message.category,
        scope: evaluation.message.scope,
        source: evaluation.message.source,
        traceVersion: evaluation.message.traceVersion,
        affectedInstrumentIdsJson: JSON.stringify(evaluation.message.affectedInstrumentIds),
        notify: evaluation.message.notify,
        message: evaluation.message.message,
        metricsJson: JSON.stringify(evaluation.message.metrics),
        rawJson: JSON.stringify(evaluation.message),
        createdAt: evaluation.message.createdAt ?? now,
        emittedAt: now,
      })
    : false;

  const actions = buildRuntimeActionsForMessage(evaluation.message, { executionEnabled: false });
  const shouldPersistActions = Boolean(options.persistActions) &&
    (evaluation.message.category !== "info" || Boolean(options.persistInfoMessages));
  const insertedActionCount = shouldPersistActions
    ? actions.filter((action) => insertRuntimeAction({
        surface: "runtime_watchdog_evaluations",
        surfaceRowId: evaluationId,
        messageCode: action.messageCode,
        category: action.category,
        scope: action.scope,
        source: action.source,
        traceVersion: action.traceVersion,
        actionType: action.actionType,
        status: action.status,
        executionEnabled: action.executionEnabled,
        affectedInstrumentIdsJson: JSON.stringify(action.affectedInstrumentIds),
        reason: action.reason,
        rawJson: JSON.stringify(action),
        createdAt: action.createdAt ?? now,
        proposedAt: now,
      })).length
    : 0;

  const notificationEnabled = Boolean((options.notify || options.notifyDryRun) && evaluation.message.notify);
  const notificationResults = notificationEnabled
    ? await sendRuntimeNotifications([evaluation.message], {
        dryRun: Boolean(options.notifyDryRun || !options.notify),
        webhookUrl: options.webhookUrl,
        consoleSink: true,
      })
    : [];

  return {
    evaluationId,
    evaluation,
    messagePersistence: {
      enabled: shouldPersistMessage,
      inserted: insertedMessage,
    },
    actionPersistence: {
      enabled: shouldPersistActions,
      candidateCount: actions.length,
      insertedCount: insertedActionCount,
    },
    notification: {
      enabled: notificationEnabled,
      dryRun: Boolean(options.notifyDryRun || !options.notify),
      resultCount: notificationResults.length,
    },
  };
}
