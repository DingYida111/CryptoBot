import { config as dotenvConfig } from "dotenv";
import { persistManagedStrategySync } from "./persistence.js";
import { createManagedStrategyRegistry } from "./strategy_registry.js";
import { BenchmarkEnvSchema, buildBenchmarkInstanceConfig } from "./supervisor_config.js";

dotenvConfig();

const env = BenchmarkEnvSchema.parse(process.env);

function log(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.error(`[${new Date().toISOString()}] [OKX_BENCH] ${message}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncOnce(): Promise<void> {
  if (!env.OKX_BENCHMARK_ENABLED) {
    log("benchmark disabled");
    return;
  }

  const registry = createManagedStrategyRegistry();
  const controller = registry.create("okx_contract_grid");
  const config = buildBenchmarkInstanceConfig(env);
  let sync = await controller.sync(config);

  if (sync.snapshot.state === "idle" && env.OKX_BENCHMARK_AUTO_CREATE) {
    log("no active benchmark found, creating one", {
      instrument: config.instrument,
      direction: config.parameters.direction,
      margin: config.parameters.margin,
      gridNum: config.parameters.gridNum,
    });
    const started = await controller.start(config);
    if (started.algoId) {
      config.parameters.algoId = started.algoId;
    }
    sync = await controller.sync(config);
  }

  persistManagedStrategySync(config, sync);

  log("benchmark sync complete", {
    instanceId: sync.snapshot.instanceId,
    algoId: sync.snapshot.algoId,
    state: sync.snapshot.state,
    totalPnl: sync.snapshot.totalPnl,
    subOrders: sync.snapshot.subOrderCount,
    positions: sync.snapshot.positionCount,
  });
}

async function main(): Promise<void> {
  if (!env.OKX_BENCHMARK_WATCH) {
    await syncOnce();
    return;
  }

  log("benchmark watch loop started", {
    intervalMs: env.OKX_BENCHMARK_INTERVAL_MS,
  });
  while (true) {
    try {
      await syncOnce();
    } catch (error) {
      log("benchmark watch iteration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(env.OKX_BENCHMARK_INTERVAL_MS);
  }
}

main().catch((error) => {
  log("benchmark sync failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
