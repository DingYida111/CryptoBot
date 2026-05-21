import { execFileSync } from "child_process";
import { recordRuntimeAgentHeartbeat } from "./runtime_heartbeat.js";

interface Pm2Process {
  readonly name?: string;
  readonly pid?: number;
  readonly pm_id?: number;
  readonly pm2_env?: {
    readonly status?: string;
    readonly restart_time?: number;
    readonly unstable_restarts?: number;
    readonly pm_uptime?: number;
  };
}

interface CliOptions {
  readonly pm2Name: string;
  readonly agentId: string;
  readonly role: string;
  readonly intervalMs: number;
  readonly managedInstruments: readonly string[];
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
  let pm2Name = process.env.RUNTIME_HEARTBEAT_PM2_NAME ?? "cryptobot-supervisor";
  let agentId = process.env.RUNTIME_AGENT_ID ?? pm2Name;
  let role = process.env.RUNTIME_AGENT_ROLE ?? "pm2_supervised_agent";
  let intervalMs = positiveNumber(process.env.RUNTIME_HEARTBEAT_INTERVAL_MS, 10_000);
  let managedInstruments = csv(process.env.RUNTIME_AGENT_MANAGED_INSTRUMENTS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--pm2-name" && argv[index + 1]) {
      pm2Name = argv[index + 1] ?? pm2Name;
      index += 1;
      continue;
    }
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
      intervalMs = positiveNumber(argv[index + 1], intervalMs);
      index += 1;
      continue;
    }
    if (arg === "--managed-instruments" && argv[index + 1]) {
      managedInstruments = csv(argv[index + 1]);
      index += 1;
    }
  }

  return { pm2Name, agentId, role, intervalMs, managedInstruments };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listPm2Processes(): readonly Pm2Process[] {
  const output = execFileSync("pm2", ["jlist"], { encoding: "utf8" });
  const parsed = JSON.parse(output) as unknown;
  return Array.isArray(parsed) ? parsed as Pm2Process[] : [];
}

function findTarget(name: string): Pm2Process | null {
  return listPm2Processes().find((processRow) => processRow.name === name) ?? null;
}

function writeHeartbeatIfOnline(options: CliOptions): void {
  const target = findTarget(options.pm2Name);
  const status = target?.pm2_env?.status ?? "missing";
  if (status !== "online") {
    console.log(JSON.stringify({
      phase: "heartbeat_proxy_skip",
      pm2Name: options.pm2Name,
      status,
      at: new Date().toISOString(),
    }));
    return;
  }

  recordRuntimeAgentHeartbeat({
    agentId: options.agentId,
    role: options.role,
    pid: target?.pid ?? null,
    status: "running",
    metadata: {
      source: "pm2_heartbeat_proxy",
      pm2Name: options.pm2Name,
      pm2Id: target?.pm_id ?? null,
      pm2Status: status,
      pm2RestartTime: target?.pm2_env?.restart_time ?? null,
      pm2UnstableRestarts: target?.pm2_env?.unstable_restarts ?? null,
      pm2Uptime: target?.pm2_env?.pm_uptime ?? null,
      managedInstruments: options.managedInstruments,
    },
  });
  console.log(JSON.stringify({
    phase: "heartbeat_proxy_write",
    agentId: options.agentId,
    pm2Name: options.pm2Name,
    pid: target?.pid ?? null,
    at: new Date().toISOString(),
  }));
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  while (true) {
    writeHeartbeatIfOnline(options);
    await sleep(options.intervalMs);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
