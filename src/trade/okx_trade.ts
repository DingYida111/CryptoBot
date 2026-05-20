/**
 * OKX Trading Module
 * Supports both live and simulated trading
 * Paper trading: set x-simulated-trading: true header
 */

import { retryWithInstantRetry } from "../utils/retry.js";
import { getOkxCredentialSet } from "../utils/secrets.js";
import { logTradeEvent } from "./trade_logger.js";

const OKX_API = "https://www.okx.com";
const USE_LIVE_API = process.env.USE_LIVE_API === "true";

interface RequestHeaders {
  "OK-ACCESS-KEY": string;
  "OK-ACCESS-SECRET": string;
  "OK-ACCESS-PASSPHRASE": string;
  "Content-Type": string;
  "x-simulated-trading"?: string;
}

async function sign(
  timestamp: string,
  method: string,
  path: string,
  body: string,
  secret: string
): Promise<string> {
  const msg = timestamp + method + path + body;
  const crypto = await import("crypto");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(msg);
  return hmac.digest("base64");
}

export async function okxPrivateRequest<T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string = "",
  needSimulated: boolean = false
): Promise<T> {
  const isLive = USE_LIVE_API;
  const creds = getOkxCredentialSet(isLive);
  const key = creds.apiKey;
  const secret = creds.apiSecret;
  const passphrase = creds.apiPassphrase;

  if (!key || !secret || !passphrase) {
    throw new Error(
      "[OKX] Credentials not configured. Set OKX credentials in env vars or secret files."
    );
  }

  const timestamp = new Date().toISOString();
  const signature = await sign(timestamp, method, path, body, secret);

  const headers: RequestHeaders = {
    "OK-ACCESS-KEY": key,
    "OK-ACCESS-SECRET": secret,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };

  // x-simulated-trading: only for paper trading (not live), and only when needSimulated=true
  if (!isLive && needSimulated) {
    headers["x-simulated-trading"] = "1";
  }

  const url = OKX_API + path;
  const res = await retryWithInstantRetry(
    async (): Promise<{ ok: boolean; status: number; json: () => Promise<T> }> => {
      const r = await fetch(url, {
        method,
        headers: {
          ...headers,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": passphrase,
        },
        body: method !== "GET" ? body : undefined,
      });
      return { ok: r.ok, status: r.status, json: () => r.json() as Promise<T> };
    },
    `okx ${method} ${path}`,
    { maxAttempts: 3, initialDelayMs: 500 }
  );

  const parsed = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parsed;
}

export interface AccountBalance {
  totalEq: string; isoEq: string; adjEq: string;
  imr: string; mmr: string; upl: string; currency: string;
}

export async function getAccountBalance(): Promise<AccountBalance[] | null> {
  try {
    const data = await okxPrivateRequest<{ code: string; data: AccountBalance[] }>(
      "GET", "/api/v5/account/balance", "", true);
    if (data.code === "0" && data.data) return data.data;
    console.error("getAccountBalance error:", data);
    return null;
  } catch (e) { console.error("getAccountBalance exception:", e); return null; }
}

export interface Position {
  instId: string; posSide: "long" | "short" | "net"; pos: string;
  avgPx: string; upl: string; liqPx: string; margin: string; leverage: string;
}

export async function getPositions(instId: string = "BTC-USDT-SWAP"): Promise<Position[]> {
  try {
    const data = await okxPrivateRequest<{ code: string; data: Position[] }>(
      "GET", `/api/v5/account/positions?instId=${instId}`, "", true);
    if (data.code === "0") return data.data ?? [];
    console.error("getPositions error:", data); return [];
  } catch (e) { console.error("getPositions exception:", e); return []; }
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "post_only";
export type PosSide = "long" | "short";
const CANCEL_BATCH_SIZE = 20;

export interface OrderRequest {
  instId: string; tdMode: "cross" | "isolated" | "cash";
  side: OrderSide; posSide?: PosSide; ordType: OrderType;
  sz: string; px?: string; reduceOnly?: boolean;
}

export interface OrderResult { ordId: string; clOrdId: string; sCode: string; sMsg: string; }

export async function placeOrder(req: OrderRequest): Promise<OrderResult | null> {
  try {
    const body = JSON.stringify(req);
    const data = await okxPrivateRequest<{ code: string; data: OrderResult[] }>(
      "POST", "/api/v5/trade/order", body, true);
    if (data.code === "0" && data.data?.[0]) {
      const r = data.data[0];
      logTradeEvent("OKX", "order_placed", {
        ordId: r.ordId,
        clOrdId: r.clOrdId,
        sCode: r.sCode,
        sMsg: r.sMsg,
        instId: req.instId,
        side: req.side,
        posSide: req.posSide ?? null,
        ordType: req.ordType,
        sz: req.sz,
        px: req.px ?? null,
        reduceOnly: req.reduceOnly ?? null,
      });
      return r;
    }
    logTradeEvent("OKX", "order_failed", {
      instId: req.instId,
      side: req.side,
      posSide: req.posSide ?? null,
      ordType: req.ordType,
      sz: req.sz,
      px: req.px ?? null,
      reduceOnly: req.reduceOnly ?? null,
      response: data,
    });
    console.error("placeOrder error:", data); return null;
  } catch (e) {
    logTradeEvent("OKX", "order_exception", {
      instId: req.instId,
      side: req.side,
      posSide: req.posSide ?? null,
      ordType: req.ordType,
      sz: req.sz,
      px: req.px ?? null,
      reduceOnly: req.reduceOnly ?? null,
      error: e instanceof Error ? e.message : String(e),
    });
    console.error("placeOrder exception:", e);
    return null;
  }
}

export async function placeLimitOrder(
  req: Omit<OrderRequest, "ordType"> & { px: string }
): Promise<OrderResult | null> {
  return placeOrder({ ...req, ordType: "post_only" });
}

export async function buyUp(instId = "BTC-USDT-SWAP", sz = "1") {
  return placeOrder({ instId, tdMode: "cross", side: "buy", posSide: "long", ordType: "market", sz });
}

export async function sellDown(instId = "BTC-USDT-SWAP", sz = "1") {
  return placeOrder({ instId, tdMode: "cross", side: "sell", posSide: "short", ordType: "market", sz });
}

export async function placeGridBuyLong(instId = "BTC-USDT-SWAP", sz = "1", px = "") {
  return placeLimitOrder({ instId, tdMode: "cross", side: "buy", posSide: "long", sz, px });
}

export async function placeGridSellLong(instId = "BTC-USDT-SWAP", sz = "1", px = "") {
  return placeLimitOrder({ instId, tdMode: "cross", side: "sell", posSide: "long", sz, px, reduceOnly: true });
}

export async function placeGridBuyShort(instId = "BTC-USDT-SWAP", sz = "1", px = "") {
  return placeLimitOrder({ instId, tdMode: "cross", side: "buy", posSide: "short", sz, px, reduceOnly: true });
}

export async function placeGridSellShort(instId = "BTC-USDT-SWAP", sz = "1", px = "") {
  return placeLimitOrder({ instId, tdMode: "cross", side: "sell", posSide: "short", sz, px });
}

export async function closeAllPositions(instId = "BTC-USDT-SWAP") {
  const positions = await getPositions(instId);
  for (const pos of positions) {
    const sz = pos.pos;
    if (parseInt(sz) === 0) continue;
    if (pos.posSide === "long" || pos.posSide === "net")
      await placeOrder({ instId, tdMode: "cross", side: "sell", ordType: "market", sz, reduceOnly: true, posSide: "long" });
    if (pos.posSide === "short" || pos.posSide === "net")
      await placeOrder({ instId, tdMode: "cross", side: "buy", ordType: "market", sz, reduceOnly: true, posSide: "short" });
  }
}

export async function closePositionPartially(instId = "BTC-USDT-SWAP", sz: string) {
  const positions = await getPositions(instId);
  const pos = positions[0];
  if (!pos || parseInt(pos.pos) === 0) return null;
  const actualSz = Math.min(parseInt(sz), parseInt(pos.pos)).toString();
  if (parseInt(actualSz) === 0) return null;
  if (pos.posSide === "long" || pos.posSide === "net") {
    const result = await placeOrder({ instId, tdMode: "cross", side: "sell", ordType: "market", sz: actualSz, reduceOnly: true, posSide: "long" });
    return result?.sCode === "0" ? actualSz : null;
  }
  if (pos.posSide === "short" || pos.posSide === "net") {
    const result = await placeOrder({ instId, tdMode: "cross", side: "buy", ordType: "market", sz: actualSz, reduceOnly: true, posSide: "short" });
    return result?.sCode === "0" ? actualSz : null;
  }
  return null;
}

export async function getPendingOrders(instId = "BTC-USDT-SWAP") {
  try {
    const data = await okxPrivateRequest<{ code: string; data: any[] }>(
      "GET", `/api/v5/trade/orders-pending?instId=${instId}`, "", true);
    if (data.code === "0") return data.data ?? [];
    return [];
  } catch { return []; }
}

export async function cancelOrder(instId: string, ordId: string) {
  try {
    const body = JSON.stringify({ instId, ordId });
    const data = await okxPrivateRequest<{ code: string; data?: Array<{ ordId?: string; sCode?: string; sMsg?: string }> }>(
      "POST", "/api/v5/trade/cancel-order", body, true);
    logTradeEvent("OKX", "cancel_order_ack", {
      instId,
      ordId,
      response: data,
    });
    return data.code === "0";
  } catch (e) {
    logTradeEvent("OKX", "cancel_order_exception", {
      instId,
      ordId,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export async function cancelPendingOrders(instId: string, ordIds: string[]): Promise<number> {
  if (!ordIds.length) return 0;

  let acknowledged = 0;
  for (let i = 0; i < ordIds.length; i += CANCEL_BATCH_SIZE) {
    const batch = ordIds.slice(i, i + CANCEL_BATCH_SIZE).map((ordId) => ({ instId, ordId }));
    try {
      const body = JSON.stringify(batch);
      const data = await okxPrivateRequest<{
        code: string;
        data?: Array<{ ordId?: string; sCode?: string; sMsg?: string }>;
      }>("POST", "/api/v5/trade/cancel-batch-orders", body, true);
      const successCount = (data.data ?? []).filter((row) => row.sCode === "0").length;
      acknowledged += successCount;
      logTradeEvent("OKX", "cancel_batch_ack", {
        instId,
        batchSize: batch.length,
        successCount,
        response: data,
      });
    } catch (e) {
      logTradeEvent("OKX", "cancel_batch_exception", {
        instId,
        batchSize: batch.length,
        ordIds: batch.map((row) => row.ordId).join(","),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return acknowledged;
}

export interface FilledOrder {
  instId: string; ordId: string; fillPx: string; fillSz: string;
  side: OrderSide; posSide: PosSide; fillTime: string;
  execType?: string;
  fee?: string;
  feeCcy?: string;
}

export async function getRecentFills(instId = "BTC-USDT-SWAP", limit = 10) {
  try {
    const data = await okxPrivateRequest<{ code: string; data: FilledOrder[] }>(
      "GET", `/api/v5/trade/fills?instId=${instId}&limit=${limit}`, "", true);
    if (data.code === "0") return data.data ?? [];
    return [];
  } catch { return []; }
}
