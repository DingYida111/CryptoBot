import { runRuntimeWatchdog } from "./runtime_heartbeat.js";

interface CliOptions {
  readonly agentId: string;
  readonly staleAfterMs: number;
  readonly disconnectAfterMs: number;
  readonly maintenanceGraceMs: number;
  readonly intervalMs: number;
  readonly watch: boolean;
  readonly persistMessages: boolean;
  readonly persistInfo: boolean;
  readonly persistActions: boolean;
  readonly notify: boolean;
  readonly notifyDryRun: boolean;
  readonly webhookUrl: string | null;
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
  let agentId = process.env.RUNTIME_WATCHDOG_AGENT_ID ?? process.env.RUNTIME_AGENT_ID ?? "cryptobot-supervisor";
  let staleAfterMs = positiveNumber(process.env.RUNTIME_WATCHDOG_STALE_AFTER_MS, 60_000);
  let disconnectAfterMs = positiveNumber(process.env.RUNTIME_WATCHDOG_DISCONNECT_AFTER_MS, 120_000);
  let maintenanceGraceMs = positiveNumber(process.env.RUNTIME_WATCHDOG_MAINTENANCE_GRACE_MS, 120_000);
  let intervalMs = positiveNumber(process.env.RUNTIME_WATCHDOG_INTERVAL_MS, 10_000);
  let watch = process.env.RUNTIME_WATCHDOG_WATCH === "true";
  let persistMessages = process.env.RUNTIME_WATCHDOG_PERSIST_MESSAGES === "true";
  let persistInfo = process.env.RUNTIME_WATCHDOG_PERSIST_INFO === "true";
  let persistActions = process.env.RUNTIME_WATCHDOG_PERSIST_ACTIONS === "true";
  let notify = process.env.RUNTIME_WATCHDOG_NOTIFY === "true";
  let notifyDryRun = process.env.RUNTIME_WATCHDOG_NOTIFY_DRY_RUN !== "false";
  let webhookUrl = process.env.RUNTIME_NOTIFY_WEBHOOK_URL ?? null;
  let affectedInstrumentIds = csv(process.env.RUNTIME_WATCHDOG_AFFECTED_INSTRUMENTS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--agent-id" && argv[index + 1]) {
      agentId = argv[index + 1] ?? agentId;
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
    if (arg === "--interval-ms" && argv[index + 1]) {
      intervalMs = positiveNumber(argv[index + 1], intervalMs);
      index += 1;
      continue;
    }
    if (arg === "--affected-instruments" && argv[index + 1]) {
      affectedInstrumentIds = csv(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--webhook-url" && argv[index + 1]) {
      webhookUrl = argv[index + 1] ?? webhookUrl;
      index += 1;
      continue;
    }
    if (arg === "--watch") watch = true;
    if (arg === "--persist-messages") persistMessages = true;
    if (arg === "--persist-info") persistInfo = true;
    if (arg === "--persist-actions") persistActions = true;
    if (arg === "--notify") {
      notify = true;
      notifyDryRun = false;
    }
    if (arg === "--notify-dry-run") notifyDryRun = true;
  }

  return {
    agentId,
    staleAfterMs,
    disconnectAfterMs,
    maintenanceGraceMs,
    intervalMs,
    watch,
    persistMessages,
    persistInfo,
    persistActions,
    notify,
    notifyDryRun,
    webhookUrl,
    affectedInstrumentIds,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(options: CliOptions): Promise<void> {
  const result = await runRuntimeWatchdog({
    agentId: options.agentId,
    staleAfterMs: options.staleAfterMs,
    disconnectAfterMs: options.disconnectAfterMs,
    maintenanceGraceMs: options.maintenanceGraceMs,
    affectedInstrumentIds: options.affectedInstrumentIds.length > 0 ? options.affectedInstrumentIds : undefined,
    persistMessages: options.persistMessages,
    persistInfoMessages: options.persistInfo,
    persistActions: options.persistActions,
    notify: options.notify,
    notifyDryRun: options.notifyDryRun,
    webhookUrl: options.webhookUrl,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.watch) {
    await tick(options);
    return;
  }
  while (true) {
    await tick(options);
    await sleep(options.intervalMs);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
