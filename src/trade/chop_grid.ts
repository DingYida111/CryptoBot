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
  reentryCooldownMs: number;
  lossReentryCooldownMs: number;
  sameWindowReentryBlock: boolean;
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
  reentryBlockedUntil: number;
  lastExitAt: number;
  lastExitReason: string | null;
  lastExitWindowEndTs: number | null;
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
  reentryBlockedUntil: 0,
  lastExitAt: 0,
  lastExitReason: null,
  lastExitWindowEndTs: null,
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
  reentry_blocked_until?: number;
  last_exit_at?: number;
  last_exit_reason?: string | null;
  last_exit_window_end_ts?: number | null;
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

interface ExitAuditRow {
  inst_id: string;
  exit_time: number;
  reason: string;
  exit_price: number | null;
  anchor_price: number | null;
  entry_price: number | null;
  inventory_before: number;
  open_lots_before: number;
  pending_order_count: number;
  round_trip_delta: number;
  gross_pnl_delta: number;
  fee_delta: number;
  net_pnl_delta: number;
  active_before: number;
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
const DEFAULT_CONTRACT_VALUE = 0.01;
const ESTIMATED_TAKER_FEE_RATE = 0.0005;
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
let lastRealizedExitTime = 0;
let lastRealizedExitNetPnl: number | null = null;
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
  return Math.max(0.005, feeFloor);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contractValueFromMeta(meta: { ctVal?: number } | null | undefined): number {
  return Number.isFinite(meta?.ctVal) && (meta?.ctVal ?? 0) > 0 ? (meta?.ctVal as number) : DEFAULT_CONTRACT_VALUE;
}

function contractsToBaseQty(contracts: number, contractValue: number): number {
  return contracts * contractValue;
}

function grossPnlForContracts(entryPx: number, exitPx: number, contracts: number, contractValue: number): number {
  return (exitPx - entryPx) * contractsToBaseQty(contracts, contractValue);
}

function estimateTakerExitFee(exitPx: number, contracts: number, contractValue: number): number {
  return Math.abs(exitPx) * contractsToBaseQty(contracts, contractValue) * ESTIMATED_TAKER_FEE_RATE;
}

function totalOpenLotContracts(): number {
  return openLots.reduce((sum, lot) => sum + lot.sz, 0);
}

function ensureTrackedInventory(entryPrice: number | null, inventory: number, reason: string): void {
  if (!(inventory > 0)) {
    openLots = [];
    return;
  }

  const tracked = totalOpenLotContracts();
  if (tracked <= 1e-9) {
    if (entryPrice !== null && Number.isFinite(entryPrice)) {
      openLots = [{ px: entryPrice, sz: inventory, fee: 0 }];
      logTradeEvent("GRID", "inventory_backfilled", {
        entryPrice,
        inventory,
        reason,
      });
    }
    return;
  }

  if (tracked + 1e-9 < inventory && entryPrice !== null && Number.isFinite(entryPrice)) {
    const missing = inventory - tracked;
    openLots.push({ px: entryPrice, sz: missing, fee: 0 });
    logTradeEvent("GRID", "inventory_topup", {
      entryPrice,
      inventory,
      tracked,
      addedContracts: missing,
      reason,
    });
  }
}

function maxBuyLayersAllowed(config: ChopGridConfig): number {
  const remainingCapacity = Math.max(0, config.maxInventory - snapshot.inventory);
  if (remainingCapacity <= 0) return 0;
  return Math.min(config.layers, Math.floor(remainingCapacity / Math.max(1, config.orderSize)));
}

function maxSellLayersAllowed(config: ChopGridConfig): number {
  const sellCapacity = Math.max(0, snapshot.inventory);
  if (sellCapacity <= 0) return 0;
  return Math.min(config.layers, Math.floor(sellCapacity / Math.max(1, config.orderSize)));
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
        reentry_blocked_until INTEGER NOT NULL DEFAULT 0,
        last_exit_at INTEGER NOT NULL DEFAULT 0,
        last_exit_reason TEXT,
        last_exit_window_end_ts INTEGER,
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

      CREATE TABLE IF NOT EXISTS chop_grid_exits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inst_id TEXT NOT NULL,
        exit_time INTEGER NOT NULL,
        reason TEXT NOT NULL,
        exit_price REAL,
        anchor_price REAL,
        entry_price REAL,
        inventory_before REAL NOT NULL,
        open_lots_before INTEGER NOT NULL,
        pending_order_count INTEGER NOT NULL,
        round_trip_delta INTEGER NOT NULL,
        gross_pnl_delta REAL NOT NULL,
        fee_delta REAL NOT NULL,
        net_pnl_delta REAL NOT NULL,
        active_before INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chop_grid_exits_inst_time
        ON chop_grid_exits(inst_id, exit_time DESC);
    `);
    const stateColumns = new Set(
      (db.prepare("PRAGMA table_info(chop_grid_state)").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const migrations: Array<[string, string]> = [
      ["reentry_blocked_until", "INTEGER NOT NULL DEFAULT 0"],
      ["last_exit_at", "INTEGER NOT NULL DEFAULT 0"],
      ["last_exit_reason", "TEXT"],
      ["last_exit_window_end_ts", "INTEGER"],
    ];
    for (const [column, type] of migrations) {
      if (!stateColumns.has(column)) {
        db.exec(`ALTER TABLE chop_grid_state ADD COLUMN ${column} ${type}`);
      }
    }
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
    reentryBlockedUntil: row.reentry_blocked_until ?? 0,
    lastExitAt: row.last_exit_at ?? 0,
    lastExitReason: row.last_exit_reason ?? null,
    lastExitWindowEndTs: row.last_exit_window_end_ts ?? null,
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
      last_action_at, pending_order_count, reason,
      reentry_blocked_until, last_exit_at, last_exit_reason, last_exit_window_end_ts,
      open_lots_json,
      round_trip_count, win_count, loss_count, gross_pnl, fee_total, net_pnl, fee_ratio_total,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inst_id) DO UPDATE SET
      active = excluded.active,
      side = excluded.side,
      anchor_price = excluded.anchor_price,
      entry_price = excluded.entry_price,
      inventory = excluded.inventory,
      last_action_at = excluded.last_action_at,
      pending_order_count = excluded.pending_order_count,
      reason = excluded.reason,
      reentry_blocked_until = excluded.reentry_blocked_until,
      last_exit_at = excluded.last_exit_at,
      last_exit_reason = excluded.last_exit_reason,
      last_exit_window_end_ts = excluded.last_exit_window_end_ts,
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
    snapshot.reentryBlockedUntil,
    snapshot.lastExitAt,
    snapshot.lastExitReason,
    snapshot.lastExitWindowEndTs,
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

function flatten(reason: string): void {
  snapshot = {
    ...FLAT_SNAPSHOT,
    reason,
    reentryBlockedUntil: snapshot.reentryBlockedUntil,
    lastExitAt: snapshot.lastExitAt,
    lastExitReason: snapshot.lastExitReason,
    lastExitWindowEndTs: snapshot.lastExitWindowEndTs,
  };
  openLots = [];
  persistState();
}

function isAdverseExitReason(reason: string | null | undefined): boolean {
  return reason === "force_exit"
    || reason === "breakout_stop"
    || reason === "inventory_depleted_loss"
    || reason === "position_missing_after_loss";
}

export function computeReentryBlockUntil(
  config: Pick<ChopGridConfig, "reentryCooldownMs" | "lossReentryCooldownMs">,
  exitReason: string,
  netPnl: number | null,
  now: number,
): number {
  const adverse = isAdverseExitReason(exitReason) || (netPnl !== null && netPnl < 0);
  return now + (adverse ? config.lossReentryCooldownMs : config.reentryCooldownMs);
}

export function resolveReentryGate(
  gridSnapshot: Pick<ChopGridSnapshot, "reentryBlockedUntil" | "lastExitReason" | "lastExitWindowEndTs">,
  config: Pick<ChopGridConfig, "sameWindowReentryBlock">,
  now: number,
  currentWindowEndTimestamp: number | null,
): { blocked: boolean; reason: string } {
  if (gridSnapshot.reentryBlockedUntil > now) {
    return {
      blocked: true,
      reason: `reentry_cooldown_until_${gridSnapshot.reentryBlockedUntil}`,
    };
  }
  if (
    config.sameWindowReentryBlock
    && currentWindowEndTimestamp !== null
    && gridSnapshot.lastExitWindowEndTs !== null
    && currentWindowEndTimestamp === gridSnapshot.lastExitWindowEndTs
    && isAdverseExitReason(gridSnapshot.lastExitReason)
  ) {
    return {
      blocked: true,
      reason: `same_window_reentry_block:${gridSnapshot.lastExitReason ?? "unknown"}`,
    };
  }
  return { blocked: false, reason: "reentry_open" };
}

function applyReentryBlock(
  config: ChopGridConfig,
  exitReason: string,
  netPnl: number | null,
  currentWindowEndTimestamp: number | null,
): void {
  const now = Date.now();
  snapshot.reentryBlockedUntil = computeReentryBlockUntil(config, exitReason, netPnl, now);
  snapshot.lastExitAt = now;
  snapshot.lastExitReason = exitReason;
  snapshot.lastExitWindowEndTs = currentWindowEndTimestamp;
  snapshot.reason = exitReason;
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

function persistExitAudit(audit: Omit<ExitAuditRow, "inst_id" | "created_at">): void {
  const db = getDbReady();
  db.prepare(`
    INSERT INTO chop_grid_exits (
      inst_id, exit_time, reason, exit_price, anchor_price, entry_price,
      inventory_before, open_lots_before, pending_order_count,
      round_trip_delta, gross_pnl_delta, fee_delta, net_pnl_delta,
      active_before, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    INST_ID,
    audit.exit_time,
    audit.reason,
    audit.exit_price,
    audit.anchor_price,
    audit.entry_price,
    audit.inventory_before,
    audit.open_lots_before,
    audit.pending_order_count,
    audit.round_trip_delta,
    audit.gross_pnl_delta,
    audit.fee_delta,
    audit.net_pnl_delta,
    audit.active_before,
    Date.now()
  );
  logTradeEvent("GRID", "exit_audited", audit);
}

function currentAuditTotals() {
  return {
    roundTripCount: stats.roundTripCount,
    grossPnl: stats.grossPnl,
    fee: stats.fee,
    netPnl: stats.netPnl,
  };
}

function diffAuditTotals(before: ReturnType<typeof currentAuditTotals>) {
  return {
    round_trip_delta: stats.roundTripCount - before.roundTripCount,
    gross_pnl_delta: stats.grossPnl - before.grossPnl,
    fee_delta: stats.fee - before.fee,
    net_pnl_delta: stats.netPnl - before.netPnl,
  };
}

function recomputeStatsFromState(): void {
  stats.avgFeeRatio = stats.roundTripCount > 0 ? stats.feeRatioTotal / stats.roundTripCount : null;
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
  const maxBuyLayers = maxBuyLayersAllowed(config);
  const maxSellLayers = maxSellLayersAllowed(config);
  const szStr = String(Math.round(Math.max(1, config.orderSize)));
  for (let i = 1; i <= config.layers; i += 1) {
    const offset = base * spacing * i;
    if (i <= maxSellLayers) {
      desired.push(`sell:${formatPrice(base + offset, metaTickSz)}:${szStr}`);
    }
    if (i <= maxBuyLayers) {
      desired.push(`buy:${formatPrice(base - offset, metaTickSz)}:${szStr}`);
    }
  }
  return desired.sort();
}

function pendingGridOrderKeys(pending: PendingGridOrder[], metaTickSz: number): string[] {
  return pending
    .filter((order) => order.posSide === "long" && (order.side === "buy" || order.side === "sell"))
    .map((order) => {
      // Normalize price to same format as desiredGridOrders (formatPrice)
      const rawPx = parseFloat(order.px ?? "0");
      const normalizedPx = Number.isFinite(rawPx) ? formatPrice(rawPx, metaTickSz) : (order.px ?? "");
      const rawSz = parseFloat(order.sz ?? "0");
      const normalizedSz = Number.isFinite(rawSz) ? String(Math.round(rawSz)) : (order.sz ?? "");
      return `${order.side}:${normalizedPx}:${normalizedSz}`;
    })
    .sort();
}

function hasBidirectionalLongGridOrders(pending: PendingGridOrder[]): boolean {
  let hasBuy = false;
  let hasSell = false;
  for (const order of pending) {
    if (order.posSide !== "long") continue;
    if (order.side === "buy") hasBuy = true;
    if (order.side === "sell") hasSell = true;
    if (hasBuy && hasSell) return true;
  }
  return false;
}

function shouldRefreshGridOrders(
  pending: PendingGridOrder[],
  config: ChopGridConfig,
  price: number,
  metaTickSz: number
): { refresh: boolean; reason: string } {
  const desired = desiredGridOrders(config, price, metaTickSz);
  const current = pendingGridOrderKeys(pending, metaTickSz);
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

async function syncGridPosition(
  instId: string,
  config: ChopGridConfig | null,
  options?: { adoptIfNeeded?: boolean; pending?: PendingGridOrder[]; windowEndTimestamp?: number | null }
): Promise<void> {
  const positions = await getPositions(instId);
  const active = positions.find((p) => parseInt(p.pos) !== 0 && p.posSide !== "short");
  if (!active) {
    if (snapshot.active) {
      const recentRealized = Date.now() - lastRealizedExitTime <= Math.max(60_000, config?.cooldownMs ?? 60_000);
      const inferredReason = recentRealized
        ? ((lastRealizedExitNetPnl ?? 0) < 0 ? "inventory_depleted_loss" : "inventory_depleted")
        : (snapshot.lastExitReason && isAdverseExitReason(snapshot.lastExitReason)
          ? "position_missing_after_loss"
          : "position_missing");
      if (config) {
        applyReentryBlock(
          config,
          inferredReason,
          recentRealized ? lastRealizedExitNetPnl : null,
          options?.windowEndTimestamp ?? null,
        );
      }
      flatten(inferredReason);
    }
    return;
  }

  const entryPrice = parseFloat(active.avgPx);
  const inventory = Math.abs(parseInt(active.pos));
  const pending = options?.pending ?? [];
  const adoptFromExchange =
    Boolean(options?.adoptIfNeeded) &&
    !snapshot.active &&
    active.posSide !== "short" &&
    hasBidirectionalLongGridOrders(pending);

  if (!snapshot.active && !adoptFromExchange) {
    return;
  }

  const prevActive = snapshot.active;
  const prevEntryPrice = snapshot.entryPrice;
  const prevInventory = snapshot.inventory;
  const prevReason = snapshot.reason;
  snapshot = {
    ...snapshot,
    active: true,
    side: "long",
    anchorPrice:
      adoptFromExchange && Number.isFinite(entryPrice)
        ? entryPrice
        : snapshot.anchorPrice,
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : snapshot.entryPrice,
    inventory,
    pendingOrderCount: pending.length > 0 ? pending.length : snapshot.pendingOrderCount,
    reason: adoptFromExchange ? "adopted_from_exchange" : "synced",
  };
  ensureTrackedInventory(snapshot.entryPrice, inventory, snapshot.reason);
  if (
    !prevActive ||
    prevEntryPrice !== snapshot.entryPrice ||
    prevInventory !== snapshot.inventory ||
    prevReason !== snapshot.reason
  ) {
    logTradeEvent("GRID", adoptFromExchange ? "position_adopted" : "position_synced", {
      instId,
      side: "long",
      entryPrice: snapshot.entryPrice,
      inventory: snapshot.inventory,
      reason: snapshot.reason,
      pendingOrderCount: snapshot.pendingOrderCount,
    });
  }
  persistState();
}

async function ensureGridOrders(instId: string, config: ChopGridConfig, price: number, metaTickSz: number): Promise<void> {
  const spacing = Math.max(config.spacingPct, calcMinSpacingPct());
  const size = String(Math.max(1, config.orderSize));
  const base = snapshot.anchorPrice ?? price;
  const orders: Promise<any>[] = [];
  const maxBuyLayers = maxBuyLayersAllowed(config);
  const maxSellLayers = maxSellLayersAllowed(config);

  for (let i = 1; i <= config.layers; i++) {
    const offset = base * spacing * i;
    const buyPx = formatPrice(base - offset, metaTickSz);
    const sellPx = formatPrice(base + offset, metaTickSz);

    if (i <= maxSellLayers) {
      orders.push(placeGridSellLong(instId, size, sellPx));
    }
    if (i <= maxBuyLayers) {
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
    sellLayersPlaced: maxSellLayers,
    buyLayersPlaced: maxBuyLayers,
    spacingPct: spacing,
  });
  persistState();
}

function bookRealizedGridExit(
  sellPx: number,
  matchedQty: number,
  weightedBuyPx: number,
  grossPnl: number,
  buyFee: number,
  sellFee: number,
  fillTime: number,
  reason: string
): void {
  if (matchedQty <= 0) return;
  const totalFee = buyFee + sellFee;
  const netPnl = grossPnl - totalFee;
  lastRealizedExitTime = fillTime;
  lastRealizedExitNetPnl = netPnl;
  const feeToProfit = grossPnl > 0 ? totalFee / grossPnl : Infinity;
  const buyVwap = weightedBuyPx / matchedQty;
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
  recomputeStatsFromState();
  persistRoundTrip({
    fillTime,
    matchedQty,
    buyVwap,
    sellPx,
    grossPnl,
    fee: totalFee,
    netPnl,
    feeRatio: Number.isFinite(feeToProfit) ? feeToProfit : null,
  });
  persistState();
  logGrid(
    `roundtrip qty=${matchedQty.toFixed(4)} gross=${grossPnl.toFixed(4)} fee=${totalFee.toFixed(4)} net=${netPnl.toFixed(4)} fee_ratio=${Number.isFinite(feeToProfit) ? feeToProfit.toFixed(3) : "inf"} sell_px=${sellPx.toFixed(1)} avg_fee_ratio=${stats.avgFeeRatio === null ? "n/a" : stats.avgFeeRatio.toFixed(3)} wins=${stats.winCount} losses=${stats.lossCount} reason=${reason}`
  );
  logTradeEvent("GRID", "fill_close", {
    instId: INST_ID,
    fillTime,
    matchedQty,
    buyVwap,
    sellPx,
    grossPnl,
    fee: totalFee,
    netPnl,
    feeRatio: Number.isFinite(feeToProfit) ? feeToProfit : null,
    remainingOpenLots: openLots.length,
    reason,
  });
}

function settleRemainingOpenLots(
  exitPx: number,
  fillTime: number,
  contractValue: number,
  reason: "force_exit" | "breakout_stop"
): { matchedQty: number; grossPnl: number; totalFee: number; netPnl: number } | null {
  if (openLots.length === 0) return null;

  let matchedQty = 0;
  let grossPnl = 0;
  let accumulatedBuyFee = 0;
  let weightedBuyPx = 0;
  for (const lot of openLots) {
    if (!(lot.sz > 0)) continue;
    matchedQty += lot.sz;
    grossPnl += grossPnlForContracts(lot.px, exitPx, lot.sz, contractValue);
    accumulatedBuyFee += lot.fee;
    weightedBuyPx += lot.px * lot.sz;
  }

  if (matchedQty <= 0) {
    openLots = [];
    persistState();
    return null;
  }

  const sellFee = estimateTakerExitFee(exitPx, matchedQty, contractValue);
  openLots = [];
  bookRealizedGridExit(
    exitPx,
    matchedQty,
    weightedBuyPx,
    grossPnl,
    accumulatedBuyFee,
    sellFee,
    fillTime,
    `${reason}_synthetic`
  );
  logTradeEvent("GRID", "exit_settled_fallback", {
    reason,
    fillTime,
    exitPx,
    matchedQty,
    grossPnl,
    buyFee: accumulatedBuyFee,
    sellFee,
    netPnl: grossPnl - accumulatedBuyFee - sellFee,
  });
  return {
    matchedQty,
    grossPnl,
    totalFee: accumulatedBuyFee + sellFee,
    netPnl: grossPnl - accumulatedBuyFee - sellFee,
  };
}

async function getOpenLongInventory(instId: string): Promise<number> {
  const positions = await getPositions(instId);
  const activeLong = positions.find((position) => parseInt(position.pos) !== 0 && position.posSide !== "short");
  return activeLong ? Math.abs(parseInt(activeLong.pos)) : 0;
}

async function auditRecentGridFills(instId: string, contractValue: number): Promise<void> {
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
    if (
      cursor &&
      (fillTime < cursor.last_fill_time ||
        (fillTime === cursor.last_fill_time && key <= (cursor.last_fill_key ?? "")))
    ) {
      continue;
    }
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
      grossPnl += grossPnlForContracts(lot.px, px, matched, contractValue);
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

    bookRealizedGridExit(
      px,
      matchedQty,
      weightedBuyPx,
      grossPnl,
      accumulatedBuyFee,
      fee,
      Number(fill.fillTime ?? 0),
      "fill"
    );
    if (fillTime > maxFillTime || (fillTime === maxFillTime && key > (maxFillKey ?? ""))) {
      maxFillTime = fillTime;
      maxFillKey = key;
    }
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
  forceExit = false,
  currentWindowEndTimestamp: number | null = null,
): Promise<{ active: boolean; reason: string; openedSeed: boolean }> {
  const meta = await fetchBtcSwapMeta();
  const price = currentBtcPrice ?? (await fetchBtcPrice());
  if (!meta || !price) {
    return { active: false, reason: "missing_market_meta_or_price", openedSeed: false };
  }
  const contractValue = contractValueFromMeta(meta);

  await auditRecentGridFills(instId, contractValue);
  await syncGridPosition(instId, config, { windowEndTimestamp: currentWindowEndTimestamp });

  if (forceExit) {
    const auditStart = currentAuditTotals();
    const snapshotBefore = { ...snapshot };
    const openLotsBefore = openLots.length;
    await sleep(250);
    await auditRecentGridFills(instId, contractValue);
    await cancelAllGridOrders(instId);
    await closeAllPositions(instId);
    await sleep(250);
    await auditRecentGridFills(instId, contractValue);
    await cancelAllGridOrders(instId);
    const remainingInventory = await getOpenLongInventory(instId);
    if (remainingInventory <= 0 && openLots.length > 0) {
      settleRemainingOpenLots(price, Date.now(), contractValue, "force_exit");
    }
    const delta = diffAuditTotals(auditStart);
    persistExitAudit({
      exit_time: Date.now(),
      reason: "force_exit",
      exit_price: price,
      anchor_price: snapshotBefore.anchorPrice,
      entry_price: snapshotBefore.entryPrice,
      inventory_before: snapshotBefore.inventory,
      open_lots_before: openLotsBefore,
      pending_order_count: snapshotBefore.pendingOrderCount,
      round_trip_delta: delta.round_trip_delta,
      gross_pnl_delta: delta.gross_pnl_delta,
      fee_delta: delta.fee_delta,
      net_pnl_delta: delta.net_pnl_delta,
      active_before: snapshotBefore.active ? 1 : 0,
    });
    applyReentryBlock(config, "force_exit", delta.net_pnl_delta, currentWindowEndTimestamp);
    flatten("force_exit");
    return { active: false, reason: "force_exit", openedSeed: false };
  }

  if (!snapshot.active) {
    await cancelAllGridOrders(instId);
    const reentryGate = resolveReentryGate(snapshot, config, Date.now(), currentWindowEndTimestamp);
    if (reentryGate.blocked) {
      return { active: false, reason: reentryGate.reason, openedSeed: false };
    }
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
      reentryBlockedUntil: snapshot.reentryBlockedUntil,
      lastExitAt: snapshot.lastExitAt,
      lastExitReason: snapshot.lastExitReason,
      lastExitWindowEndTs: snapshot.lastExitWindowEndTs,
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
    const auditStart = currentAuditTotals();
    const snapshotBefore = { ...snapshot };
    const openLotsBefore = openLots.length;
    await sleep(250);
    await auditRecentGridFills(instId, contractValue);
    await cancelAllGridOrders(instId);
    await closeAllPositions(instId);
    await sleep(250);
    await auditRecentGridFills(instId, contractValue);
    await cancelAllGridOrders(instId);
    const remainingInventory = await getOpenLongInventory(instId);
    if (remainingInventory <= 0 && openLots.length > 0) {
      settleRemainingOpenLots(price, Date.now(), contractValue, "breakout_stop");
    }
    const delta = diffAuditTotals(auditStart);
    persistExitAudit({
      exit_time: Date.now(),
      reason: "breakout_stop",
      exit_price: price,
      anchor_price: snapshotBefore.anchorPrice,
      entry_price: snapshotBefore.entryPrice,
      inventory_before: snapshotBefore.inventory,
      open_lots_before: openLotsBefore,
      pending_order_count: snapshotBefore.pendingOrderCount,
      round_trip_delta: delta.round_trip_delta,
      gross_pnl_delta: delta.gross_pnl_delta,
      fee_delta: delta.fee_delta,
      net_pnl_delta: delta.net_pnl_delta,
      active_before: snapshotBefore.active ? 1 : 0,
    });
    logTradeEvent("GRID", "exit_breakout", {
      instId,
      price,
      anchor: anchor,
      breakoutPct: config.breakoutPct,
      inventory: snapshot.inventory,
    });
    applyReentryBlock(config, "breakout_stop", delta.net_pnl_delta, currentWindowEndTimestamp);
    flatten("breakout_stop");
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

export async function primeChopGridPosition(instId: string): Promise<boolean> {
  getDbReady();
  const pending = await getPendingOrders(instId) as PendingGridOrder[];
  await syncGridPosition(instId, null, { adoptIfNeeded: true, pending });
  return snapshot.active && snapshot.side === "long";
}
