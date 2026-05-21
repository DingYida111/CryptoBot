import { recordRuntimeAgentHeartbeat } from "./runtime_heartbeat.js";

interface CliOptions {
  readonly agentId: string;
  readonly role: string;
  readonly intervalMs: number;
  readonly watch: boolean;
  readonly status: string;
  readonly managedInstruments: readonly string[];
}

function parseCsv(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(",").map((row) => row.trim()).filter(Boolean).sort();
}

function numberArg(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let agentId = process.env.RUNTIME_AGENT_ID ?? "cryptobot-agent";
  let role = process.env.RUNTIME_AGENT_ROLE ?? "agent";
  let intervalMs = numberArg(process.env.RUNTIME_HEARTBEAT_INTERVAL_MS, 10_000);
  let watch = false;
  let status = "running";
  let managedInstruments = parseCsv(process.env.RUNTIME_AGENT_MANAGED_INSTRUMENTS);

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
    if (arg === "--interval-ms" && argv[index + 1]) {
      intervalMs = numberArg(argv[index + 1], intervalMs);
      index += 1;
      continue;
    }
    if (arg === "--status" && argv[index + 1]) {
      status = argv[index + 1] ?? status;
      index += 1;
      continue;
    }
    if (arg === "--managed-instruments" && argv[index + 1]) {
      managedInstruments = parseCsv(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--watch") {
      watch = true;
    }
  }

  return { agentId, role, intervalMs, watch, status, managedInstruments };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeHeartbeat(options: CliOptions): void {
  recordRuntimeAgentHeartbeat({
    agentId: options.agentId,
    role: options.role,
    status: options.status,
    metadata: {
      managedInstruments: options.managedInstruments,
      source: "run_runtime_heartbeat",
    },
  });
  console.log(JSON.stringify({
    phase: "heartbeat",
    agentId: options.agentId,
    role: options.role,
    status: options.status,
    at: new Date().toISOString(),
  }));
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.watch) {
    writeHeartbeat(options);
    return;
  }
  while (true) {
    writeHeartbeat(options);
    await sleep(options.intervalMs);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
