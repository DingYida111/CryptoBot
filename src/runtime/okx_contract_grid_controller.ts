import { fetchBtcPrice } from "../monitor/okx.js";
import {
  createGridAlgoOrder,
  getGridAlgoOrderDetails,
  getGridAlgoPositions,
  getGridAlgoSubOrders,
  listHistoricalGridAlgoOrders,
  listPendingGridAlgoOrders,
  stopGridAlgoOrder,
  type OkxGridAlgoOrderSummary,
} from "../trade/okx_bots.js";
import type {
  ManagedStrategyController,
  ManagedStrategyDefinition,
  ManagedStrategyInstanceConfig,
  ManagedStrategySnapshot,
  ManagedStrategyStartResult,
  ManagedStrategySyncResult,
} from "./managed_strategies.js";

const DEFINITION: ManagedStrategyDefinition = {
  type: "okx_contract_grid",
  backend: "okx_managed",
  venue: "okx",
  label: "OKX Contract Grid",
  description: "Exchange-managed contract grid strategy queried through OKX grid endpoints.",
  supportsRemotePnl: true,
  parameters: [],
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requireNumber(config: ManagedStrategyInstanceConfig, key: string, fallback: number): number {
  const value = config.parameters[key];
  const parsed = toNumber(value);
  return parsed ?? fallback;
}

function requireString(config: ManagedStrategyInstanceConfig, key: string, fallback: string): string {
  const value = config.parameters[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function normalizeState(value: string | undefined): ManagedStrategySnapshot["state"] {
  if (!value) return "unknown";
  if (value === "running") return "running";
  if (value === "stopped") return "stopped";
  if (value === "pause") return "paused";
  return "unknown";
}

function selectPreferredOrder(
  pending: OkxGridAlgoOrderSummary[],
  history: OkxGridAlgoOrderSummary[],
  instrument: string
): OkxGridAlgoOrderSummary | null {
  const filteredPending = pending.filter((row) => row.instId === instrument);
  if (filteredPending.length > 0) {
    return filteredPending.sort((a, b) => Number(b.cTime ?? 0) - Number(a.cTime ?? 0))[0];
  }
  const filteredHistory = history.filter((row) => row.instId === instrument);
  if (filteredHistory.length > 0) {
    return filteredHistory.sort((a, b) => Number(b.cTime ?? 0) - Number(a.cTime ?? 0))[0];
  }
  return null;
}

async function resolveAlgoId(config: ManagedStrategyInstanceConfig): Promise<string | null> {
  const explicit = requireString(config, "algoId", "");
  if (explicit) return explicit;
  const pending = await listPendingGridAlgoOrders({ algoOrdType: "contract_grid" });
  const history = await listHistoricalGridAlgoOrders({ algoOrdType: "contract_grid" });
  const selected = selectPreferredOrder(pending, history, config.instrument);
  return selected?.algoId ?? null;
}

function toSnapshot(
  config: ManagedStrategyInstanceConfig,
  detail: OkxGridAlgoOrderSummary | null,
  subOrders: Record<string, unknown>[],
  positions: Record<string, unknown>[],
  algoId: string | null
): ManagedStrategySnapshot {
  const totalPnl = toNumber(detail?.totalPnl);
  return {
    instanceId: config.instanceId,
    type: "okx_contract_grid",
    backend: "okx_managed",
    venue: "okx",
    instrument: config.instrument,
    algoId,
    state: normalizeState(typeof detail?.state === "string" ? detail.state : undefined),
    totalPnl,
    subOrderCount: subOrders.length,
    positionCount: positions.length,
    capturedAt: Date.now(),
    detail: {
      detail,
      parameters: config.parameters,
    },
  };
}

export class OkxContractGridController implements ManagedStrategyController {
  readonly definition = DEFINITION;

  async start(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategyStartResult> {
    const currentPrice = await fetchBtcPrice();
    if (currentPrice === null) {
      throw new Error("Cannot create OKX contract grid without current BTC price");
    }

    const minRatio = requireNumber(config, "minPriceRatio", 0.97);
    const maxRatio = requireNumber(config, "maxPriceRatio", 1.03);
    const lower = Math.round(currentPrice * Math.min(minRatio, maxRatio));
    const upper = Math.round(currentPrice * Math.max(minRatio, maxRatio));
    const response = await createGridAlgoOrder({
      instId: config.instrument,
      algoOrdType: "contract_grid",
      minPx: String(lower),
      maxPx: String(upper),
      gridNum: String(requireNumber(config, "gridNum", 7)),
      runType: String(requireNumber(config, "runType", 1)) as "1" | "2",
      sz: String(requireNumber(config, "margin", 200)),
      direction: requireString(config, "direction", "neutral") as "long" | "short" | "neutral",
      lever: String(requireNumber(config, "leverage", 2)),
    });
    const ack = response[0];
    return {
      algoId: ack?.algoId ?? null,
      state: ack?.sCode === "0" ? "running" : "error",
      raw: ack ? { ack } : undefined,
    };
  }

  async sync(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategySyncResult> {
    const algoId = await resolveAlgoId(config);
    if (!algoId) {
      const snapshot = toSnapshot(config, null, [], [], null);
      return { snapshot: { ...snapshot, state: "idle" }, rawDetail: {}, subOrders: [], positions: [] };
    }

    const detailRows = await getGridAlgoOrderDetails({ algoOrdType: "contract_grid", algoId });
    const detail = detailRows[0] ?? null;
    const subOrders = await getGridAlgoSubOrders({ algoOrdType: "contract_grid", algoId, type: "live" });
    const positions = await getGridAlgoPositions({ algoOrdType: "contract_grid", algoId });
    return {
      snapshot: toSnapshot(config, detail, subOrders, positions, algoId),
      rawDetail: detail ?? {},
      subOrders,
      positions,
    };
  }

  async stop(config: ManagedStrategyInstanceConfig): Promise<void> {
    const algoId = await resolveAlgoId(config);
    if (!algoId) return;
    await stopGridAlgoOrder({
      algoId,
      instId: config.instrument,
      algoOrdType: "contract_grid",
      stopType: "1",
    });
  }
}
