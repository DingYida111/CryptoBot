import { okxPrivateRequest } from "./okx_trade.js";
import { logTradeEvent } from "./trade_logger.js";

export type OkxGridAlgoType = "grid" | "contract_grid";
export type OkxGridDirection = "long" | "short" | "neutral";
export type OkxGridRunType = "1" | "2";

interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

export interface OkxGridAlgoOrderRequest {
  instId: string;
  algoOrdType: OkxGridAlgoType;
  maxPx: string;
  minPx: string;
  gridNum: string;
  runType?: OkxGridRunType;
  quoteSz?: string;
  baseSz?: string;
  sz?: string;
  direction?: OkxGridDirection;
  lever?: string;
  basePos?: boolean;
  tpRatio?: string;
  slRatio?: string;
  tpTriggerPx?: string;
  slTriggerPx?: string;
  algoClOrdId?: string;
  tag?: string;
}

export interface OkxGridAlgoAck {
  algoId: string;
  algoClOrdId: string;
  sCode: string;
  sMsg: string;
  tag: string;
}

export interface OkxGridAlgoOrderSummary {
  algoId: string;
  algoOrdType: OkxGridAlgoType;
  instId: string;
  instType?: string;
  state: string;
  direction?: string;
  gridNum?: string;
  investment?: string;
  sz?: string;
  maxPx?: string;
  minPx?: string;
  lever?: string;
  fee?: string;
  totalPnl?: string;
  gridProfit?: string;
  pnlRatio?: string;
  floatProfit?: string;
  runPx?: string;
  activeOrdNum?: string;
  tradeNum?: string;
  cTime?: string;
  uTime?: string;
  [key: string]: unknown;
}

export interface OkxGridSubOrder {
  algoId: string;
  ordId: string;
  instId: string;
  instType?: string;
  algoOrdType: OkxGridAlgoType;
  side: string;
  posSide?: string;
  ordType?: string;
  state: string;
  px?: string;
  sz?: string;
  avgPx?: string;
  accFillSz?: string;
  fee?: string;
  feeCcy?: string;
  lever?: string;
  cTime?: string;
  uTime?: string;
  [key: string]: unknown;
}

export interface OkxGridPosition {
  algoId: string;
  algoOrdType: "contract_grid";
  instId: string;
  instType?: string;
  posSide?: string;
  pos?: string;
  avgPx?: string;
  upl?: string;
  lever?: string;
  liqPx?: string;
  margin?: string;
  cTime?: string;
  uTime?: string;
  [key: string]: unknown;
}

function encodeParams(params: Record<string, string | undefined>): string {
  const qp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) {
      qp.set(key, value);
    }
  }
  return qp.toString();
}

async function okxBotRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T[]> {
  const payload = body ? JSON.stringify(body) : "";
  const result = await okxPrivateRequest<OkxResponse<T>>(method, path, payload, true);
  if (result.code !== "0") {
    throw new Error(`[OKX BOT] ${path} failed: code=${result.code} msg=${result.msg}`);
  }
  return result.data ?? [];
}

export async function createGridAlgoOrder(req: OkxGridAlgoOrderRequest): Promise<OkxGridAlgoAck[]> {
  const data = await okxBotRequest<OkxGridAlgoAck>("POST", "/api/v5/tradingBot/grid/order-algo", req);
  logTradeEvent("OKX_BOT", "grid_create_order", {
    instId: req.instId,
    algoOrdType: req.algoOrdType,
    direction: req.direction ?? null,
    gridNum: req.gridNum,
    maxPx: req.maxPx,
    minPx: req.minPx,
    ackCount: data.length,
    algoIds: data.map((row) => row.algoId).join(","),
  });
  return data;
}

export async function stopGridAlgoOrder(input: {
  algoId: string;
  instId: string;
  algoOrdType: OkxGridAlgoType;
  stopType?: "1" | "2";
}): Promise<OkxGridAlgoAck[]> {
  const data = await okxBotRequest<OkxGridAlgoAck>("POST", "/api/v5/tradingBot/grid/stop-order-algo", [input]);
  logTradeEvent("OKX_BOT", "grid_stop_order", {
    algoId: input.algoId,
    instId: input.instId,
    algoOrdType: input.algoOrdType,
    stopType: input.stopType ?? null,
    ackCount: data.length,
  });
  return data;
}

export async function listPendingGridAlgoOrders(params: {
  algoOrdType: OkxGridAlgoType;
  algoId?: string;
}): Promise<OkxGridAlgoOrderSummary[]> {
  const query = encodeParams({
    algoOrdType: params.algoOrdType,
    algoId: params.algoId,
  });
  return okxBotRequest<OkxGridAlgoOrderSummary>("GET", `/api/v5/tradingBot/grid/orders-algo-pending?${query}`);
}

export async function listHistoricalGridAlgoOrders(params: {
  algoOrdType: OkxGridAlgoType;
  algoId?: string;
}): Promise<OkxGridAlgoOrderSummary[]> {
  const query = encodeParams({
    algoOrdType: params.algoOrdType,
    algoId: params.algoId,
  });
  return okxBotRequest<OkxGridAlgoOrderSummary>("GET", `/api/v5/tradingBot/grid/orders-algo-history?${query}`);
}

export async function getGridAlgoOrderDetails(params: {
  algoOrdType: OkxGridAlgoType;
  algoId: string;
}): Promise<OkxGridAlgoOrderSummary[]> {
  const query = encodeParams({
    algoOrdType: params.algoOrdType,
    algoId: params.algoId,
  });
  return okxBotRequest<OkxGridAlgoOrderSummary>("GET", `/api/v5/tradingBot/grid/orders-algo-details?${query}`);
}

export async function getGridAlgoSubOrders(params: {
  algoOrdType: OkxGridAlgoType;
  algoId: string;
  type?: "live" | "filled";
}): Promise<OkxGridSubOrder[]> {
  const query = encodeParams({
    algoOrdType: params.algoOrdType,
    algoId: params.algoId,
    type: params.type ?? "live",
  });
  return okxBotRequest<OkxGridSubOrder>("GET", `/api/v5/tradingBot/grid/sub-orders?${query}`);
}

export async function getGridAlgoPositions(params: {
  algoId: string;
  algoOrdType: "contract_grid";
}): Promise<OkxGridPosition[]> {
  const query = encodeParams({
    algoOrdType: params.algoOrdType,
    algoId: params.algoId,
  });
  return okxBotRequest<OkxGridPosition>("GET", `/api/v5/tradingBot/grid/positions?${query}`);
}
