import { persistManagedStrategySync } from "./persistence.js";
import { createManagedStrategyRegistry } from "./strategy_registry.js";
import type {
  ManagedStrategyController,
  ManagedStrategyInstanceConfig,
  ManagedStrategyRegistry,
  ManagedStrategySyncResult,
} from "./managed_strategies.js";

export interface StrategySupervisorOptions {
  defaultIntervalMs: number;
  defaultAutoStart: boolean;
}

export interface StrategySyncSummary {
  instanceId: string;
  type: string;
  instrument: string;
  state: string;
  algoId?: string | null;
  totalPnl?: number | null;
  subOrders: number;
  positions: number;
  status: "synced" | "skipped" | "error";
  error?: string;
}

export class StrategySupervisor {
  private readonly controllers = new Map<string, ManagedStrategyController>();
  private readonly lastSyncedAt = new Map<string, number>();

  constructor(
    private readonly registry: ManagedStrategyRegistry,
    private readonly instances: ManagedStrategyInstanceConfig[],
    private readonly options: StrategySupervisorOptions
  ) {}

  private getController(config: ManagedStrategyInstanceConfig): ManagedStrategyController {
    const existing = this.controllers.get(config.instanceId);
    if (existing) {
      return existing;
    }
    const created = this.registry.create(config.type);
    this.controllers.set(config.instanceId, created);
    return created;
  }

  private isDue(config: ManagedStrategyInstanceConfig, now: number): boolean {
    const intervalMs = config.syncIntervalMs ?? this.options.defaultIntervalMs;
    const last = this.lastSyncedAt.get(config.instanceId);
    return last === undefined || now - last >= intervalMs;
  }

  private markSynced(config: ManagedStrategyInstanceConfig, now: number): void {
    this.lastSyncedAt.set(config.instanceId, now);
  }

  private async syncInstance(config: ManagedStrategyInstanceConfig, now: number): Promise<StrategySyncSummary> {
    if (!config.enabled) {
      return {
        instanceId: config.instanceId,
        type: config.type,
        instrument: config.instrument,
        state: "disabled",
        subOrders: 0,
        positions: 0,
        status: "skipped",
      };
    }

    if (!this.isDue(config, now)) {
      return {
        instanceId: config.instanceId,
        type: config.type,
        instrument: config.instrument,
        state: "not_due",
        subOrders: 0,
        positions: 0,
        status: "skipped",
      };
    }

    const controller = this.getController(config);
    const autoStart = config.autoStart ?? this.options.defaultAutoStart;

    let sync = await controller.sync(config);
    if (sync.snapshot.state === "idle" && autoStart) {
      const start = await controller.start(config);
      if (start.algoId) {
        config.parameters.algoId = start.algoId;
      }
      sync = await controller.sync(config);
    }

    persistManagedStrategySync(config, sync);
    this.markSynced(config, now);
    return summarizeSync(config, sync);
  }

  async runOnce(now = Date.now()): Promise<StrategySyncSummary[]> {
    const results = await Promise.allSettled(
      this.instances.map(async (config) => this.syncInstance(config, now))
    );

    return results.map((result, index) => {
      const config = this.instances[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      return {
        instanceId: config.instanceId,
        type: config.type,
        instrument: config.instrument,
        state: "error",
        subOrders: 0,
        positions: 0,
        status: "error" as const,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }
}

function summarizeSync(
  config: ManagedStrategyInstanceConfig,
  sync: ManagedStrategySyncResult
): StrategySyncSummary {
  return {
    instanceId: config.instanceId,
    type: config.type,
    instrument: config.instrument,
    state: sync.snapshot.state,
    algoId: sync.snapshot.algoId ?? null,
    totalPnl: sync.snapshot.totalPnl ?? null,
    subOrders: sync.snapshot.subOrderCount ?? sync.subOrders.length,
    positions: sync.snapshot.positionCount ?? sync.positions.length,
    status: "synced",
  };
}

export function createStrategySupervisor(
  instances: ManagedStrategyInstanceConfig[],
  options: StrategySupervisorOptions
): StrategySupervisor {
  return new StrategySupervisor(createManagedStrategyRegistry(), instances, options);
}
