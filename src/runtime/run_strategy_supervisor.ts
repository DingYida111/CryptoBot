import { config as dotenvConfig } from "dotenv";
import { BenchmarkEnvSchema, loadManagedStrategyInstances, StrategySupervisorEnvSchema } from "./supervisor_config.js";
import { createStrategySupervisor } from "./strategy_supervisor.js";
import { executeRuntimeActionDryRun } from "./runtime_action_executor.js";
import { observeRuntimeTraces } from "./runtime_trace_observer.js";

dotenvConfig();

const benchmarkEnv = BenchmarkEnvSchema.parse(process.env);
const supervisorEnv = StrategySupervisorEnvSchema.parse(process.env);
const instances = loadManagedStrategyInstances(supervisorEnv, benchmarkEnv);
const supervisor = createStrategySupervisor(instances, {
  defaultIntervalMs: supervisorEnv.STRATEGY_SUPERVISOR_INTERVAL_MS,
  defaultAutoStart: supervisorEnv.STRATEGY_SUPERVISOR_AUTO_START,
});

function log(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.error(`[${new Date().toISOString()}] [STRATEGY_SUPERVISOR] ${message}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnce(): Promise<void> {
  if (!supervisorEnv.STRATEGY_SUPERVISOR_ENABLED) {
    log("supervisor disabled");
    return;
  }

  if (instances.length === 0) {
    log("no managed strategy instances configured");
    return;
  }

  const results = await supervisor.runOnce();
  for (const result of results) {
    const fields: Record<string, unknown> = {
      instanceId: result.instanceId,
      type: result.type,
      instrument: result.instrument,
      state: result.state,
      status: result.status,
    };
    if (result.algoId) fields.algoId = result.algoId;
    if (result.totalPnl !== null && result.totalPnl !== undefined) fields.totalPnl = result.totalPnl;
    if (result.status === "synced") {
      fields.subOrders = result.subOrders;
      fields.positions = result.positions;
    }
    if (result.error) fields.error = result.error;
    log("instance sync result", fields);
  }

  if (supervisorEnv.RUNTIME_TRACE_OBSERVER_ENABLED) {
    const observerResult = await observeRuntimeTraces({
      limit: supervisorEnv.RUNTIME_TRACE_OBSERVER_LIMIT,
      persistMessages: supervisorEnv.RUNTIME_TRACE_OBSERVER_PERSIST_MESSAGES,
      persistInfoMessages: supervisorEnv.RUNTIME_TRACE_OBSERVER_PERSIST_INFO,
      persistActions: supervisorEnv.RUNTIME_TRACE_OBSERVER_PERSIST_ACTIONS,
      notifyDryRun: supervisorEnv.RUNTIME_TRACE_OBSERVER_NOTIFY_DRY_RUN,
      notify: supervisorEnv.RUNTIME_TRACE_OBSERVER_NOTIFY,
      webhookUrl: supervisorEnv.RUNTIME_NOTIFY_WEBHOOK_URL ?? null,
    });
    log("runtime trace observer result", {
      observeOnly: true,
      traces: observerResult.surfaces.extractedTraces,
      insertedMessages: observerResult.messagePersistence.insertedCount,
      messageCandidates: observerResult.messagePersistence.candidateCount,
      persistedMessageCandidates: observerResult.messagePersistence.persistedCandidateCount,
      suppressedInfoMessages: observerResult.messagePersistence.suppressedInfoCount,
      insertedActions: observerResult.actionPersistence.insertedCount,
      actionCandidates: observerResult.actionPersistence.candidateCount,
      notifyCandidates: observerResult.notification.candidateCount,
      notificationEnabled: observerResult.notification.enabled,
      notificationDryRun: observerResult.notification.dryRun,
      health: observerResult.traceReport.health.status,
    });
  }

  if (supervisorEnv.RUNTIME_ACTION_EXECUTOR_ENABLED) {
    const executorResult = executeRuntimeActionDryRun({
      limit: supervisorEnv.RUNTIME_ACTION_EXECUTOR_LIMIT,
      cooldownMs: supervisorEnv.RUNTIME_ACTION_EXECUTOR_COOLDOWN_MS,
      ackDryRun: supervisorEnv.RUNTIME_ACTION_EXECUTOR_ACK_DRY_RUN,
      liveExecutionEnabled: supervisorEnv.RUNTIME_ACTION_EXECUTOR_LIVE_EXECUTION_ENABLED,
      tradingAdapterConfigured: supervisorEnv.RUNTIME_ACTION_EXECUTOR_TRADING_ADAPTER_CONFIGURED,
      persistControlEffects: supervisorEnv.RUNTIME_ACTION_EXECUTOR_PERSIST_CONTROL_EFFECTS,
      status: "proposed",
    });
    log("runtime action executor dry-run result", {
      observeOnly: true,
      executionEnabled: executorResult.executionEnabled,
      ackDryRun: executorResult.ackDryRun,
      acknowledgedCount: executorResult.acknowledgedCount,
      totalCandidates: executorResult.plan.totalCandidates,
      wouldExecuteCount: executorResult.plan.wouldExecuteCount,
      recordOnlyCount: executorResult.plan.recordOnlyCount,
      cooldownDuplicateCount: executorResult.plan.cooldownDuplicateCount,
      unsupportedCount: executorResult.plan.unsupportedCount,
      readyForLiveExecutionCount: executorResult.plan.readyForLiveExecutionCount,
      blockedCount: executorResult.plan.blockedCount,
      adapterOperationCount: executorResult.plan.adapterOperationCount,
      controlEffectCount: executorResult.plan.controlEffectCount,
      insertedControlEffects: executorResult.controlEffectPersistence.insertedCount,
      controlEffectPersistenceEnabled: executorResult.controlEffectPersistence.enabled,
      controlEffectSummary: executorResult.plan.controlEffectSummary,
      blockerSummary: executorResult.plan.blockerSummary,
    });
  }
}

async function main(): Promise<void> {
  if (!supervisorEnv.STRATEGY_SUPERVISOR_WATCH) {
    await runOnce();
    return;
  }

  log("watch loop started", {
    intervalMs: supervisorEnv.STRATEGY_SUPERVISOR_INTERVAL_MS,
  });

  while (true) {
    try {
      await runOnce();
    } catch (error) {
      log("watch iteration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(supervisorEnv.STRATEGY_SUPERVISOR_INTERVAL_MS);
  }
}

main().catch((error) => {
  log("supervisor failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
