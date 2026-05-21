import { LocalFundingArbitrageController } from "./local_funding_arbitrage_controller.js";
import type { ManagedStrategyInstanceConfig } from "./managed_strategies.js";

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return value === "true";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildConfig(): ManagedStrategyInstanceConfig {
  return {
    instanceId: process.env.FUNDING_ARB_INSTANCE_ID ?? "funding_arb_btc_demo",
    type: "local_funding_arbitrage",
    instrument: "BTC funding package",
    enabled: true,
    autoStart: true,
    syncIntervalMs: envNumber("FUNDING_ARB_SYNC_INTERVAL_MS", 5_000),
    parameters: {
      spotInstId: process.env.FUNDING_ARB_SPOT_INST_ID ?? "BTC-USDT",
      perpInstId: process.env.FUNDING_ARB_PERP_INST_ID ?? "BTC-USDT-SWAP",
      entryLeadMs: envNumber("FUNDING_ARB_ENTRY_LEAD_MS", 120_000),
      maxPackageSizeBtc: envNumber("FUNDING_ARB_MAX_PACKAGE_BTC", 0.01),
      minUsefulPackageSizeBtc: envNumber("FUNDING_ARB_MIN_PACKAGE_BTC", 0.01),
      spotFeeRate: envNumber("FUNDING_ARB_SPOT_FEE_RATE", 0.001),
      perpFeeRate: envNumber("FUNDING_ARB_PERP_FEE_RATE", 0.0005),
      spotSlippageBps: envNumber("FUNDING_ARB_SPOT_SLIPPAGE_BPS", 5),
      perpSlippageBps: envNumber("FUNDING_ARB_PERP_SLIPPAGE_BPS", 5),
      basisRiskBufferBps: envNumber("FUNDING_ARB_BASIS_BUFFER_BPS", 8),
      safetyBufferUsd: envNumber("FUNDING_ARB_SAFETY_BUFFER_USD", 1),
      paperExecute: envBool("FUNDING_ARB_PAPER_EXECUTE", false),
      forceValidationEntry: envBool("FUNDING_ARB_FORCE_VALIDATION_ENTRY", false),
      maxHoldMs: envNumber("FUNDING_ARB_MAX_HOLD_MS", 300_000),
      maxNetDeltaToleranceBtc: envNumber("FUNDING_ARB_MAX_NET_DELTA_BTC", 0.002),
    },
  };
}

async function main(): Promise<void> {
  const controller = new LocalFundingArbitrageController();
  const config = buildConfig();
  const loopCount = Math.max(1, envNumber("FUNDING_ARB_LOOP_COUNT", 1));
  const loopSleepMs = Math.max(1_000, envNumber("FUNDING_ARB_LOOP_SLEEP_MS", 5_000));

  const start = await controller.start(config);
  console.log(JSON.stringify({ phase: "start", start }, null, 2));

  for (let index = 0; index < loopCount; index += 1) {
    const sync = await controller.sync(config);
    console.log(JSON.stringify({
      phase: "sync",
      iteration: index + 1,
      state: sync.snapshot.state,
      detail: sync.snapshot.detail,
      subOrders: sync.subOrders,
      positions: sync.positions,
    }, null, 2));
    if (index + 1 < loopCount) {
      await sleep(loopSleepMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
