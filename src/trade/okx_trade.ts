/**
 * OKX Trading Module
 * Supports both live and simulated trading
 * Paper trading: set x-simulated-trading: true header
 */

import { retryWithInstantRetry } from "../utils/retry.js";

const OKX_API = "https://www.okx.com";
const USE_SIMULATED = true;

interface RequestHeaders {
  "OK-ACCESS-KEY": string;
  "OK-ACCESS-SECRET": string;
  "OK-ACCESS-PASSPHRASE": string;
  "Content-Type": string;
  "x-simulated-trading"?: string;
}

/**
 * Sign OKX API request using HMAC SHA256
 */
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

/**
 * Make an authenticated OKX API request
 */
async function okxRequest<T = any>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string = "",
  needSimulated: boolean = false
): Promise<T> {
  const key = process.env.OKX_API_KEY ?? "a72b9df1-337b-4358-b4a3-ce234409d329";
  const secret = process.env.OKX_API_SECRET ?? "23FF3B339570F13AAD8881743CDF58AD";
  const passphrase = process.env.OKX_API_PASSPHRASE ?? "SH1218dyd!";

  const timestamp = new Date().toISOString();
  const signature = await sign(timestamp, method, path, body, secret);

  const headers: RequestHeaders = {
    "OK-ACCESS-KEY": key,
    "OK-ACCESS-SECRET": secret,
    "OK-ACCESS-PASSPHRASE": passphrase,
    "Content-Type": "application/json",
  };

  if (USE_SIMULATED && needSimulated) {
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

// ─── Account ─────────────────────────────────────────────────────────────────

export interface AccountBalance {
  totalEq: string;          // Account equity in USD
  isoEq: string;           // Isolated margin equity
  adjEq: string;           // Adjusted equity
  imr: string;             // Initial margin requirement
  mmr: string;             // Maintenance margin requirement
  upl: string;             // Unrealized PnL
  currency: string;
}

export async function getAccountBalance(): Promise<AccountBalance[] | null> {
  try {
    const data = await okxRequest<{ code: string; data: AccountBalance[] }>(
      "GET",
      "/api/v5/account/balance",
      "",
      true
    );
    if (data.code === "0" && data.data) return data.data;
    console.error("getAccountBalance error:", data);
    return null;
  } catch (e) {
    console.error("getAccountBalance exception:", e);
    return null;
  }
}

// ─── Position ────────────────────────────────────────────────────────────────

export interface Position {
  instId: string;
  posSide: "long" | "short" | "net";
  pos: string;             // Position size (contracts)
  avgPx: string;           // Average entry price
  upl: string;             // Unrealized PnL
  liqPx: string;           // Liquidation price
  margin: string;          // Margin allocated
  leverage: string;        // Leverage multiplier
}

export async function getPositions(instId: string = "BTC-USDT-SWAP"): Promise<Position[]> {
  try {
    const data = await okxRequest<{ code: string; data: Position[] }>(
      "GET",
      `/api/v5/account/positions?instId=${instId}`,
      "",
      true
    );
    if (data.code === "0") return data.data ?? [];
    console.error("getPositions error:", data);
    return [];
  } catch (e) {
    console.error("getPositions exception:", e);
    return [];
  }
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type PosSide = "long" | "short";

export interface OrderRequest {
  instId: string;
  tdMode: "cross" | "isolated" | "cash";
  side: OrderSide;
  posSide?: PosSide;
  ordType: OrderType;
  sz: string;              // Size (contracts)
  px?: string;            // Price (null for market order)
  reduceOnly?: boolean;
}

export interface OrderResult {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
}

export async function placeOrder(req: OrderRequest): Promise<OrderResult | null> {
  try {
    const body = JSON.stringify(req);
    const data = await okxRequest<{ code: string; data: OrderResult[] }>(
      "POST",
      "/api/v5/trade/order",
      body,
      true
    );
    if (data.code === "0" && data.data?.[0]) {
      const r = data.data[0];
      console.log(`[OKX] Order placed: ordId=${r.ordId} clOrdId=${r.clOrdId} sCode=${r.sCode} ${r.sMsg}`);
      return r;
    }
    console.error("placeOrder error:", data);
    return null;
  } catch (e) {
    console.error("placeOrder exception:", e);
    return null;
  }
}

/**
 * Buy UP (long) — goes long BTC-USDT-SWAP
 */
export async function buyUp(instId: string = "BTC-USDT-SWAP", sz: string = "1"): Promise<OrderResult | null> {
  return placeOrder({
    instId,
    tdMode: "cross",
    side: "buy",
    posSide: "long",
    ordType: "market",
    sz,
  });
}

/**
 * Sell DOWN (short) — goes short BTC-USDT-SWAP
 */
export async function sellDown(instId: string = "BTC-USDT-SWAP", sz: string = "1"): Promise<OrderResult | null> {
  return placeOrder({
    instId,
    tdMode: "cross",
    side: "sell",
    posSide: "short",
    ordType: "market",
    sz,
  });
}

/**
 * Close all positions
 */
export async function closeAllPositions(instId: string = "BTC-USDT-SWAP"): Promise<void> {
  const positions = await getPositions(instId);
  for (const pos of positions) {
    const sz = pos.pos;
    if (parseInt(sz) === 0) continue;
    if (pos.posSide === "long" || pos.posSide === "net") {
      await placeOrder({ instId, tdMode: "cross", side: "sell", ordType: "market", sz, reduceOnly: true });
    }
    if (pos.posSide === "short" || pos.posSide === "net") {
      await placeOrder({ instId, tdMode: "cross", side: "buy", ordType: "market", sz, reduceOnly: true });
    }
  }
}

/**
 * Get pending orders
 */
export async function getPendingOrders(instId: string = "BTC-USDT-SWAP"): Promise<any[]> {
  try {
    const data = await okxRequest<{ code: string; data: any[] }>(
      "GET",
      `/api/v5/trade/orders-pending?instId=${instId}`,
      "",
      true
    );
    if (data.code === "0") return data.data ?? [];
    return [];
  } catch {
    return [];
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(instId: string, ordId: string): Promise<boolean> {
  try {
    const body = JSON.stringify([{ instId, ordId }]);
    const data = await okxRequest<{ code: string }>(
      "POST",
      "/api/v5/trade/cancel-orders",
      body,
      true
    );
    return data.code === "0";
  } catch {
    return false;
  }
}

// ─── Order History ─────────────────────────────────────────────────────────────

export interface FilledOrder {
  instId: string;
  ordId: string;
  fillPx: string;
  fillSz: string;
  side: OrderSide;
  posSide: PosSide;
  fillTime: string;
}

export async function getRecentFills(instId: string = "BTC-USDT-SWAP", limit: number = 10): Promise<FilledOrder[]> {
  try {
    const data = await okxRequest<{ code: string; data: FilledOrder[] }>(
      "GET",
      `/api/v5/trade/fills?instId=${instId}&limit=${limit}`,
      "",
      true
    );
    if (data.code === "0") return data.data ?? [];
    return [];
  } catch {
    return [];
  }
}