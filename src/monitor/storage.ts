/**
 * SQLite storage for tick data and window summaries
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type { Tick, WindowSummary, Coin } from "../types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "cryptobot.sqlite3");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("synchronous = NORMAL");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      coin TEXT NOT NULL,
      slug TEXT NOT NULL,
      up_bid REAL,
      up_ask REAL,
      down_bid REAL,
      down_ask REAL,
      btc_price REAL,
      market_end_timestamp INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ticks_timestamp ON ticks(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ticks_slug ON ticks(slug);
    CREATE INDEX IF NOT EXISTS idx_ticks_coin ON ticks(coin);

    CREATE TABLE IF NOT EXISTS window_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      slug TEXT NOT NULL,
      window_start_timestamp INTEGER NOT NULL,
      window_end_timestamp INTEGER NOT NULL,
      regime TEXT,
      regime_score REAL,
      regime_reason TEXT,
      signal_up_price REAL,
      signal_down_price REAL,
      signal_up_time INTEGER,
      signal_down_time INTEGER,
      btc_entry_price REAL,
      btc_exit_price REAL,
      btc_return REAL,
      up_won INTEGER,
      profit_if_up REAL,
      profit_if_down REAL,
      net_profit_if_up REAL,
      net_profit_if_down REAL,
      spread_cost REAL,
      fee_cost REAL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_window_slug ON window_summaries(slug);
    CREATE INDEX IF NOT EXISTS idx_window_coin ON window_summaries(coin);

    CREATE TABLE IF NOT EXISTS managed_strategy_runs (
      instance_id TEXT PRIMARY KEY,
      strategy_type TEXT NOT NULL,
      backend TEXT NOT NULL,
      venue TEXT NOT NULL,
      inst_id TEXT,
      algo_id TEXT,
      state TEXT,
      config_json TEXT NOT NULL,
      latest_details_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_managed_strategy_runs_type ON managed_strategy_runs(strategy_type);
    CREATE INDEX IF NOT EXISTS idx_managed_strategy_runs_algo ON managed_strategy_runs(algo_id);

    CREATE TABLE IF NOT EXISTS managed_strategy_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      backend TEXT NOT NULL,
      venue TEXT NOT NULL,
      inst_id TEXT,
      algo_id TEXT,
      state TEXT,
      total_pnl REAL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_managed_strategy_snapshots_instance
      ON managed_strategy_snapshots(instance_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS managed_strategy_sub_orders (
      instance_id TEXT NOT NULL,
      algo_id TEXT NOT NULL,
      ord_id TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      side TEXT,
      pos_side TEXT,
      state TEXT,
      px REAL,
      sz REAL,
      avg_px REAL,
      fill_sz REAL,
      raw_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, ord_id)
    );

    CREATE INDEX IF NOT EXISTS idx_managed_strategy_sub_orders_algo
      ON managed_strategy_sub_orders(algo_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS managed_strategy_positions (
      instance_id TEXT NOT NULL,
      algo_id TEXT NOT NULL,
      strategy_type TEXT NOT NULL,
      pos_side TEXT NOT NULL,
      pos REAL,
      avg_px REAL,
      upl REAL,
      raw_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, algo_id, pos_side)
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      shadow_version TEXT,
      inst_id TEXT,
      position_contracts REAL,
      btc_delta REAL,
      funding_exposure REAL,
      regime TEXT,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_created_at
      ON portfolio_snapshots(created_at DESC);

    CREATE TABLE IF NOT EXISTS portfolio_shadow_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      shadow_version TEXT,
      actual_route TEXT NOT NULL,
      shadow_route TEXT NOT NULL,
      actual_dq_contracts REAL NOT NULL,
      shadow_dq_contracts REAL NOT NULL,
      actual_basis_id TEXT,
      shadow_basis_id TEXT,
      actual_residual_contracts REAL,
      shadow_residual_contracts REAL,
      shadow_residual_reason TEXT,
      diff_pct REAL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_shadow_log_created_at
      ON portfolio_shadow_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS portfolio_residuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      shadow_version TEXT,
      inst_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      reason_code TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_portfolio_residuals_created_at
      ON portfolio_residuals(created_at DESC);

    CREATE TABLE IF NOT EXISTS funding_arb_opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      spot_inst_id TEXT NOT NULL,
      perp_inst_id TEXT NOT NULL,
      funding_rate REAL,
      next_funding_time_ms INTEGER,
      basis_bps REAL,
      candidate_btc_size REAL,
      candidate_swap_contracts REAL,
      expected_funding_usd REAL,
      expected_fees_usd REAL,
      expected_slippage_usd REAL,
      expected_basis_risk_usd REAL,
      net_carry_edge_usd REAL,
      should_enter INTEGER NOT NULL,
      reason TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_funding_arb_opportunities_instance_created_at
      ON funding_arb_opportunities(instance_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS funding_arb_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      spot_inst_id TEXT NOT NULL,
      perp_inst_id TEXT NOT NULL,
      spot_ord_id TEXT,
      perp_ord_id TEXT,
      package_btc_size REAL,
      swap_contracts REAL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_funding_arb_events_instance_created_at
      ON funding_arb_events(instance_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS runtime_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      surface_row_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      trace_version TEXT,
      affected_instrument_ids_json TEXT NOT NULL,
      notify INTEGER NOT NULL,
      message TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      emitted_at INTEGER NOT NULL,
      UNIQUE(surface, surface_row_id, code)
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_messages_created_at
      ON runtime_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_messages_category_created_at
      ON runtime_messages(category, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_messages_notify_created_at
      ON runtime_messages(notify, created_at DESC);

    CREATE TABLE IF NOT EXISTS runtime_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      surface_row_id INTEGER NOT NULL,
      message_code TEXT NOT NULL,
      category TEXT NOT NULL,
      scope TEXT NOT NULL,
      source TEXT NOT NULL,
      trace_version TEXT,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      execution_enabled INTEGER NOT NULL,
      affected_instrument_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      proposed_at INTEGER NOT NULL,
      updated_at INTEGER,
      executor_note TEXT,
      UNIQUE(surface, surface_row_id, message_code, action_type)
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_actions_created_at
      ON runtime_actions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_actions_status_created_at
      ON runtime_actions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_actions_action_type_created_at
      ON runtime_actions(action_type, created_at DESC);
  `);

  const columns = new Set(
    (db.prepare("PRAGMA table_info(window_summaries)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const migrateColumns: Array<[string, string]> = [
    ["regime", "TEXT"],
    ["regime_score", "REAL"],
    ["regime_reason", "TEXT"],
    ["net_profit_if_up", "REAL"],
    ["net_profit_if_down", "REAL"],
    ["spread_cost", "REAL"],
    ["fee_cost", "REAL"],
  ];
  for (const [col, type] of migrateColumns) {
    if (!columns.has(col)) {
      db.exec(`ALTER TABLE window_summaries ADD COLUMN ${col} ${type}`);
    }
  }

  const shadowColumns = new Set(
    (db.prepare("PRAGMA table_info(portfolio_shadow_log)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const shadowMigrations: Array<[string, string]> = [
    ["actual_basis_id", "TEXT"],
    ["shadow_basis_id", "TEXT"],
    ["actual_residual_contracts", "REAL"],
    ["shadow_residual_contracts", "REAL"],
    ["shadow_residual_reason", "TEXT"],
  ];
  for (const [col, type] of shadowMigrations) {
    if (!shadowColumns.has(col)) {
      db.exec(`ALTER TABLE portfolio_shadow_log ADD COLUMN ${col} ${type}`);
    }
  }

  const snapshotColumns = new Set(
    (db.prepare("PRAGMA table_info(portfolio_snapshots)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  if (!snapshotColumns.has("shadow_version")) {
    db.exec("ALTER TABLE portfolio_snapshots ADD COLUMN shadow_version TEXT");
  }

  if (!shadowColumns.has("shadow_version")) {
    db.exec("ALTER TABLE portfolio_shadow_log ADD COLUMN shadow_version TEXT");
  }

  const residualColumns = new Set(
    (db.prepare("PRAGMA table_info(portfolio_residuals)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  if (!residualColumns.has("shadow_version")) {
    db.exec("ALTER TABLE portfolio_residuals ADD COLUMN shadow_version TEXT");
  }

  const runtimeActionColumns = new Set(
    (db.prepare("PRAGMA table_info(runtime_actions)").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
  const runtimeActionMigrations: Array<[string, string]> = [
    ["updated_at", "INTEGER"],
    ["executor_note", "TEXT"],
  ];
  for (const [col, type] of runtimeActionMigrations) {
    if (!runtimeActionColumns.has(col)) {
      db.exec(`ALTER TABLE runtime_actions ADD COLUMN ${col} ${type}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_version_created_at
      ON portfolio_snapshots(shadow_version, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_shadow_log_version_created_at
      ON portfolio_shadow_log(shadow_version, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_portfolio_residuals_version_created_at
      ON portfolio_residuals(shadow_version, created_at DESC);
  `);
}

export interface ManagedStrategyRunRecord {
  instanceId: string;
  strategyType: string;
  backend: string;
  venue: string;
  instId?: string | null;
  algoId?: string | null;
  state?: string | null;
  configJson: string;
  latestDetailsJson?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedStrategySnapshotRecord {
  instanceId: string;
  strategyType: string;
  backend: string;
  venue: string;
  instId?: string | null;
  algoId?: string | null;
  state?: string | null;
  totalPnl?: number | null;
  rawJson: string;
  createdAt: number;
}

export interface ManagedStrategySubOrderRecord {
  instanceId: string;
  algoId: string;
  ordId: string;
  strategyType: string;
  side?: string | null;
  posSide?: string | null;
  state?: string | null;
  px?: number | null;
  sz?: number | null;
  avgPx?: number | null;
  fillSz?: number | null;
  rawJson: string;
  updatedAt: number;
}

export interface ManagedStrategyPositionRecord {
  instanceId: string;
  algoId: string;
  strategyType: string;
  posSide: string;
  pos?: number | null;
  avgPx?: number | null;
  upl?: number | null;
  rawJson: string;
  updatedAt: number;
}

export interface PortfolioSnapshotRecord {
  source: string;
  shadowVersion: string;
  instId?: string | null;
  positionContracts?: number | null;
  btcDelta?: number | null;
  fundingExposure?: number | null;
  regime?: string | null;
  rawJson: string;
  createdAt: number;
}

export interface PortfolioShadowLogRecord {
  source: string;
  shadowVersion: string;
  actualRoute: string;
  shadowRoute: string;
  actualDqContracts: number;
  shadowDqContracts: number;
  actualBasisId?: string | null;
  shadowBasisId?: string | null;
  actualResidualContracts?: number | null;
  shadowResidualContracts?: number | null;
  shadowResidualReason?: string | null;
  diffPct?: number | null;
  rawJson: string;
  createdAt: number;
}

export interface PortfolioResidualRecord {
  source: string;
  shadowVersion: string;
  instId: string;
  quantity: number;
  reasonCode: string;
  rawJson: string;
  createdAt: number;
}

export interface FundingArbOpportunityRecord {
  source: string;
  instanceId: string;
  mode: string;
  spotInstId: string;
  perpInstId: string;
  fundingRate?: number | null;
  nextFundingTimeMs?: number | null;
  basisBps?: number | null;
  candidateBtcSize?: number | null;
  candidateSwapContracts?: number | null;
  expectedFundingUsd?: number | null;
  expectedFeesUsd?: number | null;
  expectedSlippageUsd?: number | null;
  expectedBasisRiskUsd?: number | null;
  netCarryEdgeUsd?: number | null;
  shouldEnter: boolean;
  reason: string;
  rawJson: string;
  createdAt: number;
}

export interface FundingArbEventRecord {
  source: string;
  instanceId: string;
  phase: string;
  spotInstId: string;
  perpInstId: string;
  spotOrdId?: string | null;
  perpOrdId?: string | null;
  packageBtcSize?: number | null;
  swapContracts?: number | null;
  rawJson: string;
  createdAt: number;
}

export interface RuntimeMessageRecord {
  surface: string;
  surfaceRowId: number;
  code: string;
  category: string;
  scope: string;
  source: string;
  traceVersion?: string | null;
  affectedInstrumentIdsJson: string;
  notify: boolean;
  message: string;
  metricsJson: string;
  rawJson: string;
  createdAt: number;
  emittedAt: number;
}

export interface RuntimeActionRecord {
  surface: string;
  surfaceRowId: number;
  messageCode: string;
  category: string;
  scope: string;
  source: string;
  traceVersion?: string | null;
  actionType: string;
  status: string;
  executionEnabled: boolean;
  affectedInstrumentIdsJson: string;
  reason: string;
  rawJson: string;
  createdAt: number;
  proposedAt: number;
  updatedAt?: number | null;
  executorNote?: string | null;
}

export function insertTick(tick: Tick): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO ticks (timestamp, coin, slug, up_bid, up_ask, down_bid, down_ask, btc_price, market_end_timestamp, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    tick.timestamp,
    tick.coin,
    tick.slug,
    tick.upBid,
    tick.upAsk,
    tick.downBid,
    tick.downAsk,
    tick.btcPrice,
    tick.marketEndTimestamp,
    tick.fetchedAt
  );
}

export function insertWindowSummary(summary: Omit<WindowSummary, "id">): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO window_summaries (
      coin, slug, window_start_timestamp, window_end_timestamp,
      regime, regime_score, regime_reason,
      signal_up_price, signal_down_price, signal_up_time, signal_down_time,
      btc_entry_price, btc_exit_price, btc_return,
      up_won, profit_if_up, profit_if_down,
      net_profit_if_up, net_profit_if_down, spread_cost, fee_cost,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    summary.coin,
    summary.slug,
    summary.windowStartTimestamp,
    summary.windowEndTimestamp,
    summary.regime,
    summary.regimeScore,
    summary.regimeReason,
    summary.signalUpPrice,
    summary.signalDownPrice,
    summary.signalUpTime,
    summary.signalDownTime,
    summary.btcEntryPrice,
    summary.btcExitPrice,
    summary.btcReturn,
    summary.upWon === null ? null : (summary.upWon ? 1 : 0),
    summary.profitIfUp,
    summary.profitIfDown,
    summary.netProfitIfUp,
    summary.netProfitIfDown,
    summary.spreadCost,
    summary.feeCost,
    summary.createdAt
  );
  return result.lastInsertRowid as number;
}

/**
 * Get all ticks for a specific slug (window)
 */
export function getTicksForSlug(slug: string): Tick[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM ticks WHERE slug = ? ORDER BY timestamp ASC").all(slug) as any[];
  return rows.map(rowToTick);
}

/**
 * Get window summaries with enough data for analysis
 */
export function getWindowSummaries(limit: number = 500): WindowSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM window_summaries
    WHERE btc_return IS NOT NULL
    ORDER BY window_end_timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(row => ({
    ...row,
    upWon: row.up_won === null ? null : row.up_won === 1,
    btcReturn: row.btc_return,
    profitIfUp: row.profit_if_up,
    profitIfDown: row.profit_if_down,
    netProfitIfUp: row.net_profit_if_up,
    netProfitIfDown: row.net_profit_if_down,
    spreadCost: row.spread_cost,
    feeCost: row.fee_cost,
    signalUpPrice: row.signal_up_price,
    signalDownPrice: row.signal_down_price,
    signalUpTime: row.signal_up_time,
    signalDownTime: row.signal_down_time,
    regime: row.regime,
    regimeScore: row.regime_score,
    regimeReason: row.regime_reason,
    btcEntryPrice: row.btc_entry_price,
    btcExitPrice: row.btc_exit_price,
    windowStartTimestamp: row.window_start_timestamp,
    windowEndTimestamp: row.window_end_timestamp,
    createdAt: row.created_at,
  }));
}

/**
 * Get tick count and window count for status reporting
 */
export function getStats(): { tickCount: number; windowCount: number } {
  const db = getDb();
  const tickCount = (db.prepare("SELECT COUNT(*) as c FROM ticks").get() as any).c;
  const windowCount = (db.prepare("SELECT COUNT(*) as c FROM window_summaries").get() as any).c;
  return { tickCount, windowCount };
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function upsertManagedStrategyRun(record: ManagedStrategyRunRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO managed_strategy_runs (
      instance_id, strategy_type, backend, venue, inst_id, algo_id, state,
      config_json, latest_details_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      strategy_type = excluded.strategy_type,
      backend = excluded.backend,
      venue = excluded.venue,
      inst_id = excluded.inst_id,
      algo_id = excluded.algo_id,
      state = excluded.state,
      config_json = excluded.config_json,
      latest_details_json = excluded.latest_details_json,
      updated_at = excluded.updated_at
  `).run(
    record.instanceId,
    record.strategyType,
    record.backend,
    record.venue,
    record.instId ?? null,
    record.algoId ?? null,
    record.state ?? null,
    record.configJson,
    record.latestDetailsJson ?? null,
    record.createdAt,
    record.updatedAt
  );
}

export function insertManagedStrategySnapshot(record: ManagedStrategySnapshotRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO managed_strategy_snapshots (
      instance_id, strategy_type, backend, venue, inst_id, algo_id, state,
      total_pnl, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.instanceId,
    record.strategyType,
    record.backend,
    record.venue,
    record.instId ?? null,
    record.algoId ?? null,
    record.state ?? null,
    record.totalPnl ?? null,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function replaceManagedStrategySubOrders(
  instanceId: string,
  algoId: string,
  records: ManagedStrategySubOrderRecord[]
): void {
  const db = getDb();
  const removeStmt = db.prepare(`
    DELETE FROM managed_strategy_sub_orders
    WHERE instance_id = ? AND algo_id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO managed_strategy_sub_orders (
      instance_id, algo_id, ord_id, strategy_type, side, pos_side, state,
      px, sz, avg_px, fill_sz, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    removeStmt.run(instanceId, algoId);
    for (const record of records) {
      insertStmt.run(
        record.instanceId,
        record.algoId,
        record.ordId,
        record.strategyType,
        record.side ?? null,
        record.posSide ?? null,
        record.state ?? null,
        record.px ?? null,
        record.sz ?? null,
        record.avgPx ?? null,
        record.fillSz ?? null,
        record.rawJson,
        record.updatedAt
      );
    }
  });
  tx();
}

export function replaceManagedStrategyPositions(
  instanceId: string,
  algoId: string,
  records: ManagedStrategyPositionRecord[]
): void {
  const db = getDb();
  const removeStmt = db.prepare(`
    DELETE FROM managed_strategy_positions
    WHERE instance_id = ? AND algo_id = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO managed_strategy_positions (
      instance_id, algo_id, strategy_type, pos_side, pos, avg_px, upl, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    removeStmt.run(instanceId, algoId);
    for (const record of records) {
      insertStmt.run(
        record.instanceId,
        record.algoId,
        record.strategyType,
        record.posSide,
        record.pos ?? null,
        record.avgPx ?? null,
        record.upl ?? null,
        record.rawJson,
        record.updatedAt
      );
    }
  });
  tx();
}

export function insertPortfolioSnapshot(record: PortfolioSnapshotRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO portfolio_snapshots (
      source, shadow_version, inst_id, position_contracts, btc_delta, funding_exposure, regime, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source,
    record.shadowVersion,
    record.instId ?? null,
    record.positionContracts ?? null,
    record.btcDelta ?? null,
    record.fundingExposure ?? null,
    record.regime ?? null,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function insertPortfolioShadowLog(record: PortfolioShadowLogRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO portfolio_shadow_log (
      source, shadow_version, actual_route, shadow_route, actual_dq_contracts, shadow_dq_contracts,
      actual_basis_id, shadow_basis_id, actual_residual_contracts, shadow_residual_contracts,
      shadow_residual_reason, diff_pct, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source,
    record.shadowVersion,
    record.actualRoute,
    record.shadowRoute,
    record.actualDqContracts,
    record.shadowDqContracts,
    record.actualBasisId ?? null,
    record.shadowBasisId ?? null,
    record.actualResidualContracts ?? null,
    record.shadowResidualContracts ?? null,
    record.shadowResidualReason ?? null,
    record.diffPct ?? null,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function insertPortfolioResidual(record: PortfolioResidualRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO portfolio_residuals (
      source, shadow_version, inst_id, quantity, reason_code, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source,
    record.shadowVersion,
    record.instId,
    record.quantity,
    record.reasonCode,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function insertFundingArbOpportunity(record: FundingArbOpportunityRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO funding_arb_opportunities (
      source, instance_id, mode, spot_inst_id, perp_inst_id, funding_rate, next_funding_time_ms,
      basis_bps, candidate_btc_size, candidate_swap_contracts, expected_funding_usd, expected_fees_usd,
      expected_slippage_usd, expected_basis_risk_usd, net_carry_edge_usd, should_enter, reason, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source,
    record.instanceId,
    record.mode,
    record.spotInstId,
    record.perpInstId,
    record.fundingRate ?? null,
    record.nextFundingTimeMs ?? null,
    record.basisBps ?? null,
    record.candidateBtcSize ?? null,
    record.candidateSwapContracts ?? null,
    record.expectedFundingUsd ?? null,
    record.expectedFeesUsd ?? null,
    record.expectedSlippageUsd ?? null,
    record.expectedBasisRiskUsd ?? null,
    record.netCarryEdgeUsd ?? null,
    record.shouldEnter ? 1 : 0,
    record.reason,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function insertFundingArbEvent(record: FundingArbEventRecord): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO funding_arb_events (
      source, instance_id, phase, spot_inst_id, perp_inst_id, spot_ord_id, perp_ord_id,
      package_btc_size, swap_contracts, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source,
    record.instanceId,
    record.phase,
    record.spotInstId,
    record.perpInstId,
    record.spotOrdId ?? null,
    record.perpOrdId ?? null,
    record.packageBtcSize ?? null,
    record.swapContracts ?? null,
    record.rawJson,
    record.createdAt
  );
  return result.lastInsertRowid as number;
}

export function insertRuntimeMessage(record: RuntimeMessageRecord): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO runtime_messages (
      surface, surface_row_id, code, category, scope, source, trace_version,
      affected_instrument_ids_json, notify, message, metrics_json, raw_json,
      created_at, emitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.surface,
    record.surfaceRowId,
    record.code,
    record.category,
    record.scope,
    record.source,
    record.traceVersion ?? null,
    record.affectedInstrumentIdsJson,
    record.notify ? 1 : 0,
    record.message,
    record.metricsJson,
    record.rawJson,
    record.createdAt,
    record.emittedAt,
  );
  return result.changes > 0;
}

export function insertRuntimeAction(record: RuntimeActionRecord): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO runtime_actions (
      surface, surface_row_id, message_code, category, scope, source, trace_version,
      action_type, status, execution_enabled, affected_instrument_ids_json, reason,
      raw_json, created_at, proposed_at, updated_at, executor_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.surface,
    record.surfaceRowId,
    record.messageCode,
    record.category,
    record.scope,
    record.source,
    record.traceVersion ?? null,
    record.actionType,
    record.status,
    record.executionEnabled ? 1 : 0,
    record.affectedInstrumentIdsJson,
    record.reason,
    record.rawJson,
    record.createdAt,
    record.proposedAt,
    record.updatedAt ?? null,
    record.executorNote ?? null,
  );
  return result.changes > 0;
}

export function updateRuntimeActionStatus(input: {
  readonly id: number;
  readonly status: string;
  readonly updatedAt: number;
  readonly executorNote?: string | null;
}): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE runtime_actions
    SET status = ?, updated_at = ?, executor_note = ?
    WHERE id = ?
  `).run(
    input.status,
    input.updatedAt,
    input.executorNote ?? null,
    input.id,
  );
  return result.changes > 0;
}

function rowToTick(row: any): Tick {
  return {
    timestamp: row.timestamp,
    coin: row.coin as Coin,
    slug: row.slug,
    upBid: row.up_bid,
    upAsk: row.up_ask,
    downBid: row.down_bid,
    downAsk: row.down_ask,
    btcPrice: row.btc_price,
    marketEndTimestamp: row.market_end_timestamp,
    fetchedAt: row.fetched_at,
  };
}
