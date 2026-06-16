import { config as dotenvConfig } from "dotenv";
import { executeRuntimeActionDryRun, queryRuntimeActionRows } from "./runtime_action_executor.js";
import { updateRuntimeActionStatus } from "../monitor/storage.js";
import { executeOkxRuntimeAction, createOkxRuntimeActionAdapter } from "./okx_runtime_action_adapter.js";
import { buildRuntimeActionExecutionPlan } from "./runtime_action_executor.js";
import { findRuntimeActionCooldownDuplicates } from "./runtime_actions.js";

dotenvConfig();

interface CliOptions {
  readonly limit: number;
  readonly source: string | null;
  readonly actionType: string | null;
  readonly instrumentId: string | null;
  readonly status: string;
  readonly cooldownMs: number;
  readonly ackDryRun: boolean;
  readonly liveExecutionEnabled: boolean;
  readonly tradingAdapterConfigured: boolean;
  readonly persistControlEffects: boolean;
  readonly live: boolean;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 50;
  let source: string | null = null;
  let actionType: string | null = null;
  let instrumentId: string | null = null;
  let status = "proposed";
  let cooldownMs = 300_000;
  let ackDryRun = false;
  let liveExecutionEnabled = false;
  let tradingAdapterConfigured = false;
  let persistControlEffects = false;

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
    if (arg === "--action-type") {
      const next = argv[index + 1];
      if (next) {
        actionType = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--instrument") {
      const next = argv[index + 1];
      if (next) {
        instrumentId = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--status") {
      const next = argv[index + 1];
      if (next) {
        status = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--cooldown-ms") {
      const parsed = parsePositiveNumber(argv[index + 1]);
      if (parsed !== null) {
        cooldownMs = Math.floor(parsed);
        index += 1;
      }
      continue;
    }
    if (arg === "--ack-dry-run") {
      ackDryRun = true;
      continue;
    }
    if (arg === "--simulate-live-execution-enabled") {
      liveExecutionEnabled = true;
      continue;
    }
    if (arg === "--simulate-trading-adapter-configured") {
      tradingAdapterConfigured = true;
      continue;
    }
    if (arg === "--persist-control-effects") {
      persistControlEffects = true;
      continue;
    }
    if (arg === "--live") {
      liveExecutionEnabled = true;
      tradingAdapterConfigured = true;
      continue;
    }
    const parsed = parsePositiveNumber(arg);
    if (parsed !== null) {
      limit = Math.floor(parsed);
    }
  }

  return {
    limit,
    source,
    actionType,
    instrumentId,
    status,
    cooldownMs,
    ackDryRun,
    liveExecutionEnabled,
    tradingAdapterConfigured,
    persistControlEffects,
    live: liveExecutionEnabled && tradingAdapterConfigured,
  };
}

async function runLiveExecution(options: CliOptions): Promise<void> {
  const adapter = createOkxRuntimeActionAdapter();
  const rows = queryRuntimeActionRows({ ...options, status: "proposed" });
  const duplicates = findRuntimeActionCooldownDuplicates(rows, options.cooldownMs);
  const duplicateIds = new Set(duplicates.map((r) => r.id));
  const plan = buildRuntimeActionExecutionPlan({
    rows,
    cooldownMs: options.cooldownMs,
    ackDryRun: false,
    preflight: { liveExecutionEnabled: true, tradingAdapterConfigured: true, adapter },
  });

  const ready = plan.rows.filter((r) => r.readyForLiveExecution && !duplicateIds.has(r.id));
  const results: Array<{ id: number; actionType: string; success: boolean; note: string }> = [];

  for (const row of ready) {
    const result = await executeOkxRuntimeAction(row.actionType);
    const nextStatus = result.success ? "live_executed" : "live_skipped";
    updateRuntimeActionStatus({ id: row.id, status: nextStatus, updatedAt: Date.now(), executorNote: result.note });
    results.push({ id: row.id, actionType: row.actionType, ...result });
    console.error(`[LIVE] ${row.actionType} id=${row.id}: ${result.note}`);
  }

  console.log(JSON.stringify({ live: true, executedCount: results.length, results }, null, 2));
}

const options = parseCliOptions(process.argv.slice(2));

if (options.live) {
  runLiveExecution(options).catch((err) => {
    console.error("Live executor error:", err);
    process.exit(1);
  });
} else {
  console.log(JSON.stringify(executeRuntimeActionDryRun(options), null, 2));
}
