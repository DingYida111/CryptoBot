import { executeRuntimeActionDryRun } from "./runtime_action_executor.js";

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
  };
}

const options = parseCliOptions(process.argv.slice(2));
console.log(JSON.stringify(executeRuntimeActionDryRun(options), null, 2));
