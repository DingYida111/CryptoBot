import {
  insertManagedStrategySnapshot,
  replaceManagedStrategyPositions,
  replaceManagedStrategySubOrders,
  upsertManagedStrategyRun,
} from "../monitor/storage.js";
import type { ManagedStrategyInstanceConfig, ManagedStrategySyncResult } from "./managed_strategies.js";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function persistManagedStrategySync(
  config: ManagedStrategyInstanceConfig,
  sync: ManagedStrategySyncResult
): void {
  upsertManagedStrategyRun({
    instanceId: config.instanceId,
    strategyType: config.type,
    backend: sync.snapshot.backend,
    venue: sync.snapshot.venue,
    instId: config.instrument,
    algoId: sync.snapshot.algoId ?? null,
    state: sync.snapshot.state,
    configJson: JSON.stringify(config.parameters),
    latestDetailsJson: JSON.stringify(sync.rawDetail),
    createdAt: sync.snapshot.capturedAt,
    updatedAt: sync.snapshot.capturedAt,
  });

  insertManagedStrategySnapshot({
    instanceId: sync.snapshot.instanceId,
    strategyType: sync.snapshot.type,
    backend: sync.snapshot.backend,
    venue: sync.snapshot.venue,
    instId: sync.snapshot.instrument,
    algoId: sync.snapshot.algoId ?? null,
    state: sync.snapshot.state,
    totalPnl: sync.snapshot.totalPnl ?? null,
    rawJson: JSON.stringify(sync.snapshot.detail),
    createdAt: sync.snapshot.capturedAt,
  });

  replaceManagedStrategySubOrders(
    config.instanceId,
    sync.snapshot.algoId ?? "none",
    sync.subOrders
      .map((row) => ({
        instanceId: config.instanceId,
        algoId: sync.snapshot.algoId ?? "none",
        ordId: String(row.ordId ?? ""),
        strategyType: config.type,
        side: typeof row.side === "string" ? row.side : null,
        posSide: typeof row.posSide === "string" ? row.posSide : null,
        state: typeof row.state === "string" ? row.state : null,
        px: toNumber(row.px),
        sz: toNumber(row.sz),
        avgPx: toNumber(row.avgPx),
        fillSz: toNumber(row.accFillSz),
        rawJson: JSON.stringify(row),
        updatedAt: sync.snapshot.capturedAt,
      }))
      .filter((row) => row.ordId.length > 0)
  );

  replaceManagedStrategyPositions(
    config.instanceId,
    sync.snapshot.algoId ?? "none",
    sync.positions.map((row) => ({
      instanceId: config.instanceId,
      algoId: sync.snapshot.algoId ?? "none",
      strategyType: config.type,
      posSide: typeof row.posSide === "string" && row.posSide.length > 0 ? row.posSide : "net",
      pos: toNumber(row.pos),
      avgPx: toNumber(row.avgPx),
      upl: toNumber(row.upl),
      rawJson: JSON.stringify(row),
      updatedAt: sync.snapshot.capturedAt,
    }))
  );
}
