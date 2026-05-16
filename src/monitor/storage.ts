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
  `);
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
      signal_up_price, signal_down_price, signal_up_time, signal_down_time,
      btc_entry_price, btc_exit_price, btc_return,
      up_won, profit_if_up, profit_if_down,
      net_profit_if_up, net_profit_if_down, spread_cost, fee_cost,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    summary.coin,
    summary.slug,
    summary.windowStartTimestamp,
    summary.windowEndTimestamp,
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