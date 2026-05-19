import { buyUp, closeAllPositions, getPendingOrders, getPositions, cancelOrder, placeGridBuyLong, placeGridSellLong, getRecentFills } from "./okx_trade.js";
import { fetchBtcSwapMeta, fetchBtcPrice } from "../monitor/okx.js";

export interface ChopGridConfig {
  layers: number;
  spacingPct: number;
  orderSize: number;
  seedMultiplier: number;
  maxInventory: number;
  recenterPct: number;
  breakoutPct: number;
  cooldownMs: number;
}

export interface ChopGridSnapshot {
  active: boolean;
  side: "long" | null;
  anchorPrice: number | null;
  entryPrice: number | null;
  inventory: number;
  lastActionAt: number;
  pendingOrderCount: number;
  reason: string;
}

const FLAT_SNAPSHOT: ChopGridSnapshot = {
  active: false,
  side: null,
  anchorPrice: null,
  entryPrice: null,
  inventory: 0,
  lastActionAt: 0,
  pendingOrderCount: 0,
  reason: "flat",
};

let snapshot: ChopGridSnapshot = { ...FLAT_SNAPSHOT };
let seenFillIds = new Set<string>();
let openLots: Array<{ px: number; sz: number; fee: number }> = [];

function logGrid(msg: string): void {
  console.error(`[${new Date().toISOString()}] [GRID] ${msg}`);
}

function roundToTick(price: number, tickSz: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSz) || tickSz <= 0) return price;
  return Math.round(price / tickSz) * tickSz;
}

function formatPrice(price: number, tickSz: number): string {
  const rounded = roundToTick(price, tickSz);
  const decimals = Math.max(0, Math.min(8, String(tickSz).split(".")[1]?.length ?? 0));
  return rounded.toFixed(decimals);
}

function calcMinSpacingPct(): number {
  const takerFee = 0.0005;
  const makerFee = 0.0002;
  const roundTrip = makerFee * 2;
  const feeFloor = roundTrip * 4; // fee <= profit / 4
  return Math.max(0.007, feeFloor);
}

function reset(): void {
  snapshot = { ...FLAT_SNAPSHOT };
  seenFillIds = new Set<string>();
  openLots = [];
}

export function getChopGridSnapshot(): ChopGridSnapshot {
  return { ...snapshot };
}

async function cancelAllGridOrders(instId: string): Promise<void> {
  const pending = await getPendingOrders(instId);
  for (const order of pending) {
    const ordId = order?.ordId ?? order?.ordID ?? order?.orderId;
    if (typeof ordId === "string" && ordId.length > 0) {
      await cancelOrder(instId, ordId);
    }
  }
}

async function syncGridPosition(instId: string): Promise<void> {
  const positions = await getPositions(instId);
  const active = positions.find((p) => parseInt(p.pos) !== 0);
  if (!active) {
    if (snapshot.active) reset();
    return;
  }

  const entryPrice = parseFloat(active.avgPx);
  const inventory = Math.abs(parseInt(active.pos));
  snapshot = {
    ...snapshot,
    active: true,
    side: "long",
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : snapshot.entryPrice,
    inventory,
    reason: "synced",
  };
}

async function ensureGridOrders(instId: string, config: ChopGridConfig, price: number, metaTickSz: number): Promise<void> {
  const spacing = Math.max(config.spacingPct, calcMinSpacingPct());
  const size = String(Math.max(1, config.orderSize));
  const base = snapshot.anchorPrice ?? price;
  const orders: Promise<any>[] = [];

  for (let i = 1; i <= config.layers; i++) {
    const offset = base * spacing * i;
    const buyPx = formatPrice(base - offset, metaTickSz);
    const sellPx = formatPrice(base + offset, metaTickSz);

    orders.push(placeGridSellLong(instId, size, sellPx));
    if (snapshot.inventory < config.maxInventory) {
      orders.push(placeGridBuyLong(instId, size, buyPx));
    }
  }

  await Promise.allSettled(orders);
  snapshot.lastActionAt = Date.now();
  snapshot.pendingOrderCount = (await getPendingOrders(instId)).length;
}

async function auditRecentGridFills(instId: string): Promise<void> {
  const fills = await getRecentFills(instId, 50);
  const ordered = [...fills].reverse();
  for (const fill of ordered) {
    if (!fill.ordId || seenFillIds.has(fill.ordId)) continue;
    seenFillIds.add(fill.ordId);

    const px = parseFloat(fill.fillPx);
    const sz = parseFloat(fill.fillSz);
    const fee = Math.abs(parseFloat(fill.fee ?? "0"));
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;

    if (fill.side === "buy" && fill.posSide === "long") {
      openLots.push({ px, sz, fee });
      continue;
    }

    if (fill.side !== "sell" || fill.posSide !== "long") continue;

    let remaining = sz;
    let grossPnl = 0;
    let matchedQty = 0;
    let accumulatedBuyFee = 0;

    while (remaining > 0 && openLots.length > 0) {
      const lot = openLots[0];
      const matched = Math.min(remaining, lot.sz);
      grossPnl += (px - lot.px) * matched;
      accumulatedBuyFee += lot.fee * (matched / lot.sz);
      matchedQty += matched;
      remaining -= matched;
      lot.sz -= matched;
      if (lot.sz <= 1e-9) {
        openLots.shift();
      }
    }

    if (matchedQty <= 0) continue;

    const sellFee = fee;
    const totalFee = accumulatedBuyFee + sellFee;
    const netPnl = grossPnl - totalFee;
    const feeToProfit = grossPnl > 0 ? totalFee / grossPnl : Infinity;
    logGrid(
      `roundtrip qty=${matchedQty.toFixed(4)} gross=${grossPnl.toFixed(4)} fee=${totalFee.toFixed(4)} net=${netPnl.toFixed(4)} fee_ratio=${Number.isFinite(feeToProfit) ? feeToProfit.toFixed(3) : "inf"} sell_px=${px.toFixed(1)}`
    );
  }
}

export async function maybeRunChopGrid(
  instId: string,
  config: ChopGridConfig,
  regime: "CHOP" | "RANGE",
  currentBtcPrice: number | null,
  forceExit = false
): Promise<{ active: boolean; reason: string; openedSeed: boolean }> {
  const meta = await fetchBtcSwapMeta();
  const price = currentBtcPrice ?? (await fetchBtcPrice());
  if (!meta || !price) {
    return { active: false, reason: "missing_market_meta_or_price", openedSeed: false };
  }

  await auditRecentGridFills(instId);
  await syncGridPosition(instId);

  if (forceExit) {
    await cancelAllGridOrders(instId);
    await closeAllPositions(instId);
    reset();
    return { active: false, reason: "force_exit", openedSeed: false };
  }

  const now = Date.now();
  if (snapshot.active && now - snapshot.lastActionAt < config.cooldownMs) {
    return { active: true, reason: "cooldown", openedSeed: false };
  }

  if (!snapshot.active) {
    const seedSize = Math.max(1, config.orderSize * Math.max(1, config.seedMultiplier));
    const seed = await buyUp(instId, String(seedSize));
    if (!seed || seed.sCode !== "0") {
      return { active: false, reason: "seed_order_failed", openedSeed: false };
    }
    snapshot = {
      active: true,
      side: "long",
      anchorPrice: price,
      entryPrice: price,
      inventory: seedSize,
      lastActionAt: now,
      pendingOrderCount: 0,
      reason: `init_${regime}`,
    };
    await ensureGridOrders(instId, config, price, meta.tickSz);
    return { active: true, reason: snapshot.reason, openedSeed: true };
  }

  const anchor = snapshot.anchorPrice ?? price;
  const breakout = Math.abs(price - anchor) / anchor >= config.breakoutPct;
  if (breakout) {
    await cancelAllGridOrders(instId);
    await closeAllPositions(instId);
    reset();
    return { active: false, reason: "breakout_stop", openedSeed: false };
  }

  if (Math.abs(price - (snapshot.entryPrice ?? price)) / (snapshot.entryPrice ?? price) >= config.recenterPct) {
    snapshot.anchorPrice = price;
    snapshot.entryPrice = price;
    snapshot.reason = "recentering";
  }

  if (snapshot.pendingOrderCount === 0 || snapshot.reason === "recentering") {
    await cancelAllGridOrders(instId);
    await ensureGridOrders(instId, config, price, meta.tickSz);
  }
  return { active: true, reason: snapshot.reason, openedSeed: false };
}
