import { buyUp, closeAllPositions, getPendingOrders, getPositions, cancelPendingOrders, placeGridBuyLong, placeGridSellLong, getRecentFills } from "./okx_trade.js";
import { logTradeEvent } from "./trade_logger.js";
import { getDb } from "../monitor/storage.js";
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

export interface ChopGridStats {
  roundTripCount: number;
  winCount: number;
  lossCount: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
  feeRatioTotal: number;
  avgFeeRatio: number | null;
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

interface PersistedOpenLot {
  px: number;
  sz: number;
  fee: number;
}

interface GridStateRow {
  inst_id: string;
  active: number;
  side: "long" | null;
  anchor_price: number | null;
  entry_price: number | null;
  inventory: number;
  last_action_at: number;
  pending_order_count: number;
  reason: string;
  open_lots_json: string;
  round_trip_count: number;
  win_count: number;
  loss_count: number;
  gross_pnl: number;
  fee_total: number;
  net_pnl: number;
  fee_ratio_total: number;
  updated_at: number;
}

interface FillCursorRow {
  inst_id: string;
  last_fill_time: number;
  last_fill_key: string | null;
  created_at: number;
}

interface RoundTripRow {
  inst_id: string;
  fill_time: number;
  matched_qty: number;
  buy_vwap: number;
  sell_px: number;
  gross_pnl: number;
  fee: number;
  net_pnl: number;
  fee_ratio: number | null;
  created_at: number;
}

interface PendingGridOrder {
  ordId?: string;
  side?: "buy" | "sell";
  posSide?: "long" | "short";
  px?: string;
  sz?: string;
  state?: string;
}

const INST_ID = "BTC-USDT-SWAP";
let snapshot: ChopGridSnapshot = { ...FLAT_SNAPSHOT };
let openLots: PersistedOpenLot[] = [];
let stats: ChopGridStats = {
  roundTripCount: 0,
  winCount: 0,
  lossCount: 0,
  grossPnl: 0,
  fee: 0,
  netPnl: 0,
  feeRatioTotal: 0,
  avgFeeRatio: null,
};
let schemaReady = false;

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
  const makerFee = 0.0002;
  const roundTrip = makerFee * 2;
  const feeFloor = roundTrip * 4;
  return Math.max(0.007, feeFloor);
}

function getDbReady() {
  const db = getDb();
  if (!schemaReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chop_grid_state (
        inst_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL,
        side TEXT,
        anchor_price REAL,
        entry_price REAL,
        inventory REAL NOT NULL,
        last_action_at INTEGER NOT NULL,
        pending_order_count INTEGER NOT NULL,
        reason TEXT NOT NULL,
        open_lots_json TEXT NOT NULL,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        win_count INTEGER NOT NULL DEFAULT 0,
        loss_count INTEGER NOT NULL DEFAULT 0,
        gross_pnl REAL NOT NULL DEFAULT 0,
        fee_total REAL NOT NULL DEFAULT 0,
        net_pnl REAL NOT NULL DEFAULT 0,
        fee_ratio_total REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chop_grid_seen_fills (
        inst_id TEXT NOT NULL,
        fill_key TEXT NOT NULL,
        fill_time INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (inst_id, fill_key)
      );

      CREATE TABLE IF NOT EXISTS chop_grid_fill_cursor (
        inst_id TEXT PRIMARY KEY,
        last_fill_time INTEGER NOT NULL,
        last_fill_key TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chop_grid_roundtrips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inst_id TEXT NOT NULL,
        fill_time INTEGER NOT NULL,
        matched_qty REAL NOT NULL,
        buy_vwap REAL NOT NULL,
        sell_px REAL NOT NULL,
        gross_pnl REAL NOT NULL,
        fee REAL NOT NULL,
        net_pnl REAL NOT NULL,
        fee_ratio REAL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chop_grid_roundtrips_inst_time
        ON chop_grid_roundtrips(inst_id, fill_time DESC);
    `);
    schemaReady = true;
    loadState(db);
  }
  return db;
}

function loadState(db = getDb()): void {
  const row = db.prepare("SELECT * FROM chop_grid_state WHERE inst_id = ?").get(INST_ID) as GridStateRow | undefined;
  if (!row) {
    snapshot = { ...FLAT_SNAPSHOT };
    openLots = [];
    stats = {
      roundTripCount: 0,
      winCount: 0,
      lossCount: 0,
      grossPnl: 0,
      fee: 0,
      netPnl: 0,
      feeRatioTotal: 0,
      avgFeeRatio: null,
    };
    return;
  }

  snapshot = {
    active: row.active === 1,
    side: row.side,
    anchorPrice: row.anchor_price,
    entryPrice: row.entry_price,
    inventory: row.inventory,
    lastActionAt: row.last_action_at,
    pendingOrderCount: row.pending_order_count,
    reason: row.reason,
  };
  try {
    openLots = JSON.parse(row.open_lots_json) as PersistedOpenLot[];
  } catch {
    openLots = [];
  }
  if (snapshot.active && snapshot.side === "long" && openLots.length > 0) {
    logGrid(
      `state_restore active=${snapshot.active} inventory=${snapshot.inventory.toFixed(4)} lots=${openLots.length} reason=${snapshot.reason}`
    );
  }
  stats = {
    roundTripCount: row.round_trip_count,
    winCount: row.win_count,
    lossCount: row.loss_count,
    grossPnl: row.gross_pnl,
    fee: row.fee_total,
    netPnl: row.net_pnl,
    feeRatioTotal: row.fee_ratio_total,
    avgFeeRatio: row.round_trip_count > 0 ? row.fee_ratio_total / row.round_trip_count : null,
  };
}

function persistState(): void {
  const db = getDbReady();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO chop_grid_state (
      inst_id, active, side, anchor_price, entry_price, inventory,
      last_action_at, pending_order_count, reason, open_lots_json,
      round_trip_count, win_count, loss_count, gross_pnl, fee_total, net_pnl, fee_ratio_total,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inst_id) DO UPDATE SET
      active = excluded.active,
      side = excluded.side,
      anchor_price = excluded.anchor_price,
      entry_price = excluded.entry_price,
      inventory = excluded.inventory,
      last_action_at = excluded.last_action_at,
      pending_order_count = excluded.pending_order_count,
      reason = excluded.reason,
      open_lots_json = excluded.open_lots_json,
      round_trip_count = excluded.round_trip_count,
      win_count = excluded.win_count,
      loss_count = excluded.loss_count,
      gross_pnl = excluded.gross_pnl,
      fee_total = excluded.fee_total,
      net_pnl = excluded.net_pnl,
      fee_ratio_total = excluded.fee_ratio_total,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    INST_ID,
    snapshot.active ? 1 : 0,
    snapshot.side,
    snapshot.anchorPrice,
    snapshot.entryPrice,
    snapshot.inventory,
    snapshot.lastActionAt,
    snapshot.pendingOrderCount,
    snapshot.reason,
    JSON.stringify(openLots),
    stats.roundTripCount,
    stats.winCount,
    stats.lossCount,
    stats.grossPnl,
    stats.fee,
    stats.netPnl,
    stats.feeRatioTotal,
    now
  );
}

function reset(): void {
  snapshot = { ...FLAT_SNAPSHOT };
  openLots = [];
  persistState();
}

export function getChopGridSnapshot(): ChopGridSnapshot {
  getDbReady();
  return { ...snapshot };
}

export function getChopGridStats(): ChopGridStats {
  getDbReady();
  return { ...stats };
}

function fillKey(fill: { ordId?: string; tradeId?: string; fillTime?: string; fillPx?: string; fillSz?: string; side?: string; posSide?: string }): string {
  return [
    fill.tradeId ?? "",
    fill.ordId ?? "",
    fill.fillTime ?? "",
    fill.fillPx ?? "",
    fill.fillSz ?? "",
    fill.side ?? "",
    fill.posSide ?? "",
  ].join("|");
}

function recordSeenFill(fill: { ordId?: string; tradeId?: string; fillTime?: string }, key: string): boolean {
  const db = getDbReady();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chop_grid_seen_fills (inst_id, fill_key, fill_time, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(INST_ID, key, Number(fill.fillTime ?? 0), Date.now());
  return result.changes > 0;
}

function getFillCursor(): FillCursorRow | undefined {
  const db = getDbReady();
  return db.prepare("SELECT * FROM chop_grid_fill_cursor WHERE inst_id = ?").get(INST_ID) as FillCursorRow | undefined;
}

function setFillCursor(fillTime: number, key: string | null): void {
  const db = getDbReady();
  db.prepare(`
    INSERT INTO chop_grid_fill_cursor (inst_id, last_fill_time, last_fill_key, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(inst_id) DO UPDATE SET
      last_fill_time = excluded.last_fill_time,
      last_fill_key = excluded.last_fill_key,
      created_at = excluded.created_at
  `).run(INST_ID, fillTime, key, Date.now());
}

function persistRoundTrip(roundTrip: {
  fillTime: number;
  matchedQty: number;
  buyVwap: number;
  sellPx: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
  feeRatio: number | null;
}): void {
  const db = getDbReady();
  db.prepare(`
    INSERT INTO chop_grid_roundtrips (
      inst_id, fill_time, matched_qty, buy_vwap, sell_px, gross_pnl, fee, net_pnl, fee_ratio, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    INST_ID,
    roundTrip.fillTime,
    roundTrip.matchedQty,
    roundTrip.buyVwap,
    roundTrip.sellPx,
    roundTrip.grossPnl,
    roundTrip.fee,
    roundTrip.netPnl,
    roundTrip.feeRatio,
    Date.now()
  );
  logTradeEvent("GRID", "roundtrip_recorded", roundTrip);
}

function recomputeStatsFromState(): void {
  stats.avgFeeRatio = stats.roundTripCount > 0 ? stats.fee / Math.max(stats.grossPnl, 1e-9) : null;
}

async function cancelAllGridOrders(instId: string): Promise<void> {
  let remaining = await getPendingOrders(instId);
  for (let pass = 1; pass <= 3 && remaining.length > 0; pass += 1) {
    const ordIds = remaining
      .map((order) => order?.ordId ?? order?.ordID ?? order?.orderId)
      .filter((ordId): ordId is string => typeof ordId === "string" && ordId.length > 0);
    const acknowledged = await cancelPendingOrders(instId, ordIds);
    logTradeEvent("GRID", "cancel_pending_pass", {
      instId,
      pass,
      before: remaining.length,
      ordIds: ordIds.length,
      acknowledged,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    remaining = await getPendingOrders(instId);
  }
  snapshot.pendingOrderCount = remaining.length;
  persistState();
}

function desiredGridOrders(config: ChopGridConfig, price: number, metaTickSz: number): string[] {
  const spacing = Math.max(config.spacingPct, calcMinSpacingPct());
  const base = snapshot.anchorPrice ?? price;
  const desired: string[] = [];
  for (let i = 1; i <= config.layers; i += 1) {
    const offset = base * spacing * i;
    desired.push(`sell:${formatPrice(base + offset, metaTickSz)}:${Math.max(1, config.orderSize)}`);
    if (snapshot.inventory < config.maxInventory) {
      desired.push(`buy:${formatPrice(base - offset, metaTickSz)}:${Math.max(1, config.orderSize)}`);
    }
  }
  return desired.sort();
}

function pendingGridOrderKeys(pending: PendingGridOrder[]): string[] {
  return pending
    .filter((order) => order.posSide === "long" && (order.side === "buy" || order.side === "sell"))
    .map((order) => `${order.side}:${order.px ?? ""}:${order.sz ?? ""}`)
    .sort();
}

function shouldRefreshGridOrders(
  pending: PendingGridOrder[],
  config: ChopGridConfig,
  price: number,
  metaTickSz: number
): { refresh: boolean; reason: string } {
  const desired = desiredGridOrders(config, price, metaTickSz);
  const current = pendingGridOrderKeys(pending);
  if (current.length !== desired.length) {
    return { refresh: true, reason: `count_mismatch current=${current.length} desired=${desired.length}` };
  }
  for (let i = 0; i < desired.length; i += 1) {
    if (desired[i] !== current[i]) {
      return { refresh: true, reason: `shape_mismatch idx=${i} current=${current[i] ?? "n/a"} desired=${desired[i]}` };
    }
  }
  return { refresh: false, reason: "aligned" };
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
  const prevActive = snapshot.active;
  const prevEntryPrice = snapshot.entryPrice;
  const prevInventory = snapshot.inventory;
  const prevReason = snapshot.reason;
  snapshot = {
    ...snapshot,
    active: true,
    side: "long",
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : snapshot.entryPrice,
    inventory,
    reason: "synced",
  };
  if (
    !prevActive ||
    prevEntryPrice !== snapshot.entryPrice ||
    prevInventory !== snapshot.inventory ||
    prevReason !== snapshot.reason
  ) {
    logTradeEvent("GRID", "position_synced", {
      instId,
      side: "long",
      entryPrice: snapshot.entryPrice,
      inventory: snapshot.inventory,
      reason: snapshot.reason,
    });
  }
  persistState();
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
  logTradeEvent("GRID", "orders_refreshed", {
    instId,
    anchorPrice: snapshot.anchorPrice,
    entryPrice: snapshot.entryPrice,
    inventory: snapshot.inventory,
    pendingOrderCount: snapshot.pendingOrderCount,
    layers: config.layers,
    spacingPct: spacing,
  });
  persistState();
}

async function auditRecentGridFills(instId: string): Promise<void> {
  const fills = await getRecentFills(instId, 50);
  const ordered = [...fills].reverse();
  const cursor = getFillCursor();
  let maxFillTime = cursor?.last_fill_time ?? 0;
  let maxFillKey = cursor?.last_fill_key ?? null;

  if (!cursor && ordered.length > 0) {
    const newest = ordered[ordered.length - 1];
    setFillCursor(Number(newest.fillTime ?? 0), fillKey(newest));
    return;
  }

  for (const fill of ordered) {
    const key = fillKey(fill);
    const fillTime = Number(fill.fillTime ?? 0);
    if (cursor && fillTime <= cursor.last_fill_time) continue;
    if (!recordSeenFill(fill, key)) continue;

    const px = parseFloat(fill.fillPx);
    const sz = parseFloat(fill.fillSz);
    const fee = Math.abs(parseFloat(fill.fee ?? "0"));
    if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) continue;

    if (fill.side === "buy" && fill.posSide === "long") {
      openLots.push({ px, sz, fee });
      logTradeEvent("GRID", "fill_open", {
        instId,
        fillTime,
        side: fill.side,
        posSide: fill.posSide,
        px,
        sz,
        fee,
        openLots: openLots.length,
      });
      if (fillTime > maxFillTime || (fillTime === maxFillTime && key > (maxFillKey ?? ""))) {
        maxFillTime = fillTime;
        maxFillKey = key;
      }
      persistState();
      continue;
    }

    if (fill.side !== "sell" || fill.posSide !== "long") continue;

    let remaining = sz;
    let grossPnl = 0;
    let matchedQty = 0;
    let accumulatedBuyFee = 0;
    let weightedBuyPx = 0;

    while (remaining > 0 && openLots.length > 0) {
      const lot = openLots[0];
      const matched = Math.min(remaining, lot.sz);
      grossPnl += (px - lot.px) * matched;
      accumulatedBuyFee += lot.fee * (matched / lot.sz);
      weightedBuyPx += lot.px * matched;
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
    const buyVwap = matchedQty > 0 ? weightedBuyPx / matchedQty : px;
    stats.roundTripCount += 1;
    stats.grossPnl += grossPnl;
    stats.fee += totalFee;
    stats.netPnl += netPnl;
    stats.feeRatioTotal += Number.isFinite(feeToProfit) ? feeToProfit : 0;
    if (netPnl >= 0) {
      stats.winCount += 1;
    } else {
      stats.lossCount += 1;
    }
    stats.avgFeeRatio = stats.roundTripCount > 0 ? stats.feeRatioTotal / stats.roundTripCount : null;
    persistRoundTrip({
      fillTime: Number(fill.fillTime ?? 0),
      matchedQty,
      buyVwap,
      sellPx: px,
      grossPnl,
      fee: totalFee,
      netPnl,
      feeRatio: Number.isFinite(feeToProfit) ? feeToProfit : null,
    });
    persistState();
    if (fillTime > maxFillTime || (fillTime === maxFillTime && key > (maxFillKey ?? ""))) {
      maxFillTime = fillTime;
      maxFillKey = key;
    }
    logGrid(
      `roundtrip qty=${matchedQty.toFixed(4)} gross=${grossPnl.toFixed(4)} fee=${totalFee.toFixed(4)} net=${netPnl.toFixed(4)} fee_ratio=${Number.isFinite(feeToProfit) ? feeToProfit.toFixed(3) : "inf"} sell_px=${px.toFixed(1)} avg_fee_ratio=${stats.avgFeeRatio === null ? "n/a" : stats.avgFeeRatio.toFixed(3)} wins=${stats.winCount} losses=${stats.lossCount}`
    );
    logTradeEvent("GRID", "fill_close", {
      instId,
      fillTime,
      matchedQty,
      buyVwap,
      sellPx: px,
      grossPnl,
      fee: totalFee,
      netPnl,
      feeRatio: Number.isFinite(feeToProfit) ? feeToProfit : null,
      remainingOpenLots: openLots.length,
    });
  }
  if (maxFillTime > 0) {
    setFillCursor(maxFillTime, maxFillKey);
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

  if (!snapshot.active) {
    await cancelAllGridOrders(instId);
    const now = Date.now();
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
    logTradeEvent("GRID", "seed_opened", {
      instId,
      regime,
      anchorPrice: price,
      entryPrice: price,
      inventory: seedSize,
      seedSize,
      ordId: seed.ordId,
    });
    persistState();
    await ensureGridOrders(instId, config, price, meta.tickSz);
    return { active: true, reason: snapshot.reason, openedSeed: true };
  }

  const anchor = snapshot.anchorPrice ?? price;
  const breakout = Math.abs(price - anchor) / anchor >= config.breakoutPct;
  if (breakout) {
    await cancelAllGridOrders(instId);
    await closeAllPositions(instId);
    logTradeEvent("GRID", "exit_breakout", {
      instId,
      price,
      anchor: anchor,
      breakoutPct: config.breakoutPct,
      inventory: snapshot.inventory,
    });
    reset();
    return { active: false, reason: "breakout_stop", openedSeed: false };
  }

  if (Math.abs(price - (snapshot.entryPrice ?? price)) / (snapshot.entryPrice ?? price) >= config.recenterPct) {
    snapshot.anchorPrice = price;
    snapshot.entryPrice = price;
    snapshot.reason = "recentering";
    persistState();
  }

  const now = Date.now();
  const pending = await getPendingOrders(instId) as PendingGridOrder[];
  snapshot.pendingOrderCount = pending.length;
  const refreshCheck = shouldRefreshGridOrders(pending, config, price, meta.tickSz);
  const cooldownActive = now - snapshot.lastActionAt < config.cooldownMs;
  const mustRefresh = snapshot.reason === "recentering" || snapshot.pendingOrderCount === 0 || refreshCheck.refresh;

  if (mustRefresh) {
    logTradeEvent("GRID", "refresh_required", {
      instId,
      reason: snapshot.reason === "recentering"
        ? "recentering"
        : snapshot.pendingOrderCount === 0
          ? "pending_empty"
          : refreshCheck.reason,
      pendingOrderCount: snapshot.pendingOrderCount,
      cooldownActive,
      inventory: snapshot.inventory,
      anchorPrice: snapshot.anchorPrice,
    });
    await cancelAllGridOrders(instId);
    await ensureGridOrders(instId, config, price, meta.tickSz);
    return { active: true, reason: snapshot.reason, openedSeed: false };
  }

  persistState();
  if (cooldownActive) {
    return { active: true, reason: "cooldown", openedSeed: false };
  }
  return { active: true, reason: snapshot.reason, openedSeed: false };
}
