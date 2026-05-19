import { buyUp, closeAllPositions, getPendingOrders, getPositions, cancelOrder, placeGridBuyLong, placeGridSellLong } from "./okx_trade.js";
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
  return Math.max(0.006, roundTrip * 2.5 + takerFee * 2);
}

function reset(): void {
  snapshot = { ...FLAT_SNAPSHOT };
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
    await cancelAllGridOrders(instId);
    snapshot.anchorPrice = price;
    snapshot.entryPrice = price;
    snapshot.reason = "recentering";
  }

  await cancelAllGridOrders(instId);
  await ensureGridOrders(instId, config, price, meta.tickSz);
  return { active: true, reason: snapshot.reason, openedSeed: false };
}
