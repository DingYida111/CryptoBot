import { deactivateRuntimeMaintenanceLease } from "../monitor/storage.js";
import { createRuntimeMaintenanceLease } from "./runtime_heartbeat.js";

interface CliOptions {
  readonly agentId: string;
  readonly reason: string;
  readonly durationMs: number;
  readonly leaseId: string | null;
  readonly clear: boolean;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let agentId = process.env.RUNTIME_AGENT_ID ?? "cryptobot-supervisor";
  let reason = "planned_maintenance";
  let durationMs = positiveNumber(process.env.RUNTIME_MAINTENANCE_DURATION_MS, 300_000);
  let leaseId: string | null = process.env.RUNTIME_MAINTENANCE_LEASE_ID ?? null;
  let clear = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--agent-id" && argv[index + 1]) {
      agentId = argv[index + 1] ?? agentId;
      index += 1;
      continue;
    }
    if (arg === "--reason" && argv[index + 1]) {
      reason = argv[index + 1] ?? reason;
      index += 1;
      continue;
    }
    if (arg === "--duration-ms" && argv[index + 1]) {
      durationMs = positiveNumber(argv[index + 1], durationMs);
      index += 1;
      continue;
    }
    if (arg === "--lease-id" && argv[index + 1]) {
      leaseId = argv[index + 1] ?? leaseId;
      index += 1;
      continue;
    }
    if (arg === "--clear") {
      clear = true;
    }
  }

  return { agentId, reason, durationMs, leaseId, clear };
}

const options = parseCliOptions(process.argv.slice(2));
if (options.clear) {
  if (!options.leaseId) {
    console.error("--clear requires --lease-id or RUNTIME_MAINTENANCE_LEASE_ID");
    process.exit(1);
  }
  const cleared = deactivateRuntimeMaintenanceLease({
    leaseId: options.leaseId,
    updatedAt: Date.now(),
  });
  console.log(JSON.stringify({
    phase: "maintenance_lease_clear",
    leaseId: options.leaseId,
    cleared,
  }, null, 2));
} else {
  const leaseId = createRuntimeMaintenanceLease({
    agentId: options.agentId,
    leaseId: options.leaseId ?? undefined,
    reason: options.reason,
    durationMs: options.durationMs,
    metadata: {
      source: "run_runtime_maintenance_lease",
    },
  });
  console.log(JSON.stringify({
    phase: "maintenance_lease_create",
    agentId: options.agentId,
    leaseId,
    reason: options.reason,
    durationMs: options.durationMs,
    expiresAt: Date.now() + options.durationMs,
  }, null, 2));
}
