import { buildRuntimeActionsForMessage } from "./runtime_actions.js";
import { recordRuntimeAgentHeartbeat, runRuntimeWatchdog } from "./runtime_heartbeat.js";

interface CliOptions {
  readonly agentId: string;
  readonly role: string;
  readonly heartbeatAgeMs: number;
  readonly staleAfterMs: number;
  readonly disconnectAfterMs: number;
  readonly maintenanceGraceMs: number;
  readonly affectedInstrumentIds: readonly string[];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function csv(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map((row) => row.trim()).filter(Boolean).sort();
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let agentId = process.env.RUNTIME_DISCONNECT_DRY_RUN_AGENT_ID ?? "cryptobot-disconnect-dry-run";
  let role = process.env.RUNTIME_DISCONNECT_DRY_RUN_ROLE ?? "dry_run_agent";
  let heartbeatAgeMs = positiveNumber(process.env.RUNTIME_DISCONNECT_DRY_RUN_HEARTBEAT_AGE_MS, 121_000);
  let staleAfterMs = positiveNumber(process.env.RUNTIME_WATCHDOG_STALE_AFTER_MS, 60_000);
  let disconnectAfterMs = positiveNumber(process.env.RUNTIME_WATCHDOG_DISCONNECT_AFTER_MS, 120_000);
  let maintenanceGraceMs = positiveNumber(process.env.RUNTIME_WATCHDOG_MAINTENANCE_GRACE_MS, 120_000);
  let affectedInstrumentIds = csv(process.env.RUNTIME_WATCHDOG_AFFECTED_INSTRUMENTS);
  if (affectedInstrumentIds.length === 0) {
    affectedInstrumentIds = ["BTC-USDT", "BTC-USDT-SWAP"];
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--agent-id" && argv[index + 1]) {
      agentId = argv[index + 1] ?? agentId;
      index += 1;
      continue;
    }
    if (arg === "--role" && argv[index + 1]) {
      role = argv[index + 1] ?? role;
      index += 1;
      continue;
    }
    if (arg === "--heartbeat-age-ms" && argv[index + 1]) {
      heartbeatAgeMs = positiveNumber(argv[index + 1], heartbeatAgeMs);
      index += 1;
      continue;
    }
    if (arg === "--stale-after-ms" && argv[index + 1]) {
      staleAfterMs = positiveNumber(argv[index + 1], staleAfterMs);
      index += 1;
      continue;
    }
    if (arg === "--disconnect-after-ms" && argv[index + 1]) {
      disconnectAfterMs = positiveNumber(argv[index + 1], disconnectAfterMs);
      index += 1;
      continue;
    }
    if (arg === "--maintenance-grace-ms" && argv[index + 1]) {
      maintenanceGraceMs = positiveNumber(argv[index + 1], maintenanceGraceMs);
      index += 1;
      continue;
    }
    if (arg === "--affected-instruments" && argv[index + 1]) {
      affectedInstrumentIds = csv(argv[index + 1]);
      index += 1;
    }
  }

  return {
    agentId,
    role,
    heartbeatAgeMs,
    staleAfterMs,
    disconnectAfterMs,
    maintenanceGraceMs,
    affectedInstrumentIds,
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const now = Date.now();
  const heartbeatAt = now - options.heartbeatAgeMs;

  recordRuntimeAgentHeartbeat({
    agentId: options.agentId,
    role: options.role,
    status: "dry_run_disconnected",
    heartbeatAt,
    metadata: {
      source: "runtime_disconnect_dry_run",
      expectedStatus: "disconnected",
      heartbeatAgeMs: options.heartbeatAgeMs,
    },
  });

  const result = await runRuntimeWatchdog({
    agentId: options.agentId,
    now,
    staleAfterMs: options.staleAfterMs,
    disconnectAfterMs: options.disconnectAfterMs,
    maintenanceGraceMs: options.maintenanceGraceMs,
    affectedInstrumentIds: options.affectedInstrumentIds,
    persistMessages: true,
    persistActions: true,
    notifyDryRun: true,
  });
  const proposedActionTypes = buildRuntimeActionsForMessage(result.evaluation.message)
    .map((action) => action.actionType);
  const passed = result.evaluation.status === "disconnected" &&
    result.evaluation.message.category === "major_error" &&
    proposedActionTypes.includes("flatten_all") &&
    result.actionPersistence.insertedCount >= proposedActionTypes.length;

  console.log(JSON.stringify({
    phase: "runtime_disconnect_dry_run",
    passed,
    agentId: options.agentId,
    heartbeatAgeMs: result.evaluation.heartbeatAgeMs,
    status: result.evaluation.status,
    messageCategory: result.evaluation.message.category,
    messageCode: result.evaluation.message.code,
    proposedActionTypes,
    persistedActionCount: result.actionPersistence.insertedCount,
    notification: result.notification,
  }, null, 2));

  if (!passed) {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
