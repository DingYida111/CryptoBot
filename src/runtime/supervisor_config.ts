import { z } from "zod";
import {
  MANAGED_STRATEGY_TYPES,
  type ManagedStrategyInstanceConfig,
  type ManagedStrategyType,
} from "./managed_strategies.js";

const BooleanString = z
  .string()
  .default("false")
  .transform((value) => value === "true");

const TrueBooleanString = z
  .string()
  .default("true")
  .transform((value) => value === "true");

const StrategyValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const ManagedStrategyInstanceSchema = z.object({
  instanceId: z.string().min(1),
  type: z.enum(MANAGED_STRATEGY_TYPES as [ManagedStrategyType, ...ManagedStrategyType[]]),
  instrument: z.string().min(1),
  enabled: z.boolean().default(true),
  autoStart: z.boolean().optional(),
  syncIntervalMs: z.number().int().positive().optional(),
  parameters: z.record(StrategyValueSchema).default({}),
  metadata: z.record(z.string()).optional(),
});

const ManagedStrategyInstancesSchema = z.array(ManagedStrategyInstanceSchema);

export const BenchmarkEnvSchema = z.object({
  OKX_BENCHMARK_INSTANCE_ID: z.string().default("okx_contract_grid_benchmark"),
  OKX_BENCHMARK_ENABLED: z.string().default("true").transform((value) => value === "true"),
  OKX_BENCHMARK_AUTO_CREATE: z.string().default("false").transform((value) => value === "true"),
  OKX_BENCHMARK_WATCH: z.string().default("false").transform((value) => value === "true"),
  OKX_BENCHMARK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  OKX_BENCHMARK_INST_ID: z.string().default("BTC-USDT-SWAP"),
  OKX_BENCHMARK_DIRECTION: z.enum(["long", "short", "neutral"]).default("neutral"),
  OKX_BENCHMARK_MARGIN: z.coerce.number().positive().default(200),
  OKX_BENCHMARK_LEVERAGE: z.coerce.number().positive().default(2),
  OKX_BENCHMARK_GRID_NUM: z.coerce.number().int().positive().default(7),
  OKX_BENCHMARK_RUN_TYPE: z.coerce.number().int().min(1).max(2).default(1),
  OKX_BENCHMARK_MIN_RATIO: z.coerce.number().positive().default(0.97),
  OKX_BENCHMARK_MAX_RATIO: z.coerce.number().positive().default(1.03),
  OKX_BENCHMARK_ALGO_ID: z.string().optional(),
});

export const StrategySupervisorEnvSchema = z.object({
  STRATEGY_SUPERVISOR_ENABLED: BooleanString,
  STRATEGY_SUPERVISOR_WATCH: z.string().default("true").transform((value) => value === "true"),
  STRATEGY_SUPERVISOR_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  STRATEGY_SUPERVISOR_AUTO_START: BooleanString,
  STRATEGY_SUPERVISOR_ALLOW_BENCHMARK_FALLBACK: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  RUNTIME_TRACE_OBSERVER_ENABLED: BooleanString,
  RUNTIME_TRACE_OBSERVER_LIMIT: z.coerce.number().int().positive().default(200),
  RUNTIME_TRACE_OBSERVER_PERSIST_MESSAGES: TrueBooleanString,
  RUNTIME_TRACE_OBSERVER_PERSIST_INFO: BooleanString,
  RUNTIME_TRACE_OBSERVER_PERSIST_ACTIONS: BooleanString,
  RUNTIME_TRACE_OBSERVER_NOTIFY_DRY_RUN: TrueBooleanString,
  RUNTIME_TRACE_OBSERVER_NOTIFY: BooleanString,
  RUNTIME_ACTION_EXECUTOR_ENABLED: BooleanString,
  RUNTIME_ACTION_EXECUTOR_LIMIT: z.coerce.number().int().positive().default(50),
  RUNTIME_ACTION_EXECUTOR_COOLDOWN_MS: z.coerce.number().int().positive().default(300_000),
  RUNTIME_ACTION_EXECUTOR_ACK_DRY_RUN: BooleanString,
  RUNTIME_NOTIFY_WEBHOOK_URL: z.string().optional(),
  MANAGED_STRATEGY_INSTANCES_JSON: z.string().optional(),
});

export type BenchmarkEnv = z.infer<typeof BenchmarkEnvSchema>;
export type StrategySupervisorEnv = z.infer<typeof StrategySupervisorEnvSchema>;

export function buildBenchmarkInstanceConfig(env: BenchmarkEnv): ManagedStrategyInstanceConfig {
  return {
    instanceId: env.OKX_BENCHMARK_INSTANCE_ID,
    type: "okx_contract_grid",
    instrument: env.OKX_BENCHMARK_INST_ID,
    enabled: env.OKX_BENCHMARK_ENABLED,
    autoStart: env.OKX_BENCHMARK_AUTO_CREATE,
    syncIntervalMs: env.OKX_BENCHMARK_INTERVAL_MS,
    parameters: {
      algoId: env.OKX_BENCHMARK_ALGO_ID ?? "",
      direction: env.OKX_BENCHMARK_DIRECTION,
      margin: env.OKX_BENCHMARK_MARGIN,
      leverage: env.OKX_BENCHMARK_LEVERAGE,
      gridNum: env.OKX_BENCHMARK_GRID_NUM,
      runType: env.OKX_BENCHMARK_RUN_TYPE,
      minPriceRatio: env.OKX_BENCHMARK_MIN_RATIO,
      maxPriceRatio: env.OKX_BENCHMARK_MAX_RATIO,
    },
    metadata: {
      source: "benchmark_fallback",
    },
  };
}

export function parseManagedStrategyInstancesJson(input: string): ManagedStrategyInstanceConfig[] {
  const parsed = JSON.parse(input) as unknown;
  return ManagedStrategyInstancesSchema.parse(parsed);
}

export function loadManagedStrategyInstances(
  supervisorEnv: StrategySupervisorEnv,
  benchmarkEnv: BenchmarkEnv
): ManagedStrategyInstanceConfig[] {
  if (supervisorEnv.MANAGED_STRATEGY_INSTANCES_JSON?.trim()) {
    return parseManagedStrategyInstancesJson(supervisorEnv.MANAGED_STRATEGY_INSTANCES_JSON);
  }

  if (supervisorEnv.STRATEGY_SUPERVISOR_ALLOW_BENCHMARK_FALLBACK && benchmarkEnv.OKX_BENCHMARK_ENABLED) {
    return [buildBenchmarkInstanceConfig(benchmarkEnv)];
  }

  return [];
}
