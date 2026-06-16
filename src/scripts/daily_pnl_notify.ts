/**
 * Daily PnL report pushed to Gary WeChat bot.
 * Run via PM2 cron or manually: npx tsx src/scripts/daily_pnl_notify.ts
 *
 * Required env: GARY_NOTIFY_WEBHOOK_URL (optional, falls back to stdout)
 */
import { getDb } from "../monitor/storage.js";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

function todayRangeMs(): { startMs: number; endMs: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { startMs: start.getTime(), endMs: now.getTime() };
}

async function sendNotification(text: string): Promise<void> {
  const url = process.env.GARY_NOTIFY_WEBHOOK_URL;
  if (!url) {
    console.log("[DailyReport] No GARY_NOTIFY_WEBHOOK_URL set, printing to stdout:\n" + text);
    return;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    throw new Error(`Webhook POST failed: ${resp.status} ${await resp.text()}`);
  }
}

async function main(): Promise<void> {
  const db = getDb();
  const { startMs, endMs } = todayRangeMs();
  const startSec = startMs / 1000;
  const endSec = endMs / 1000;

  const grid = db.prepare(`
    SELECT COUNT(*) as cnt,
           COALESCE(SUM(net_pnl), 0) as net,
           COALESCE(SUM(gross_pnl), 0) as gross,
           COALESCE(SUM(fee), 0) as fee
    FROM chop_grid_roundtrips
    WHERE fill_time >= ? AND fill_time <= ?
  `).get(startSec, endSec) as { cnt: number; net: number; gross: number; fee: number };

  const snap = db.prepare(`
    SELECT position_contracts, btc_delta, regime, created_at
    FROM portfolio_snapshots
    ORDER BY created_at DESC LIMIT 1
  `).get() as { position_contracts: number; btc_delta: number; regime: string | null; created_at: number } | undefined;

  const date = new Date().toISOString().slice(0, 10);
  const sign = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(4);

  const report = [
    `📊 CryptoBot 每日报告 ${date}`,
    `——— 网格交易 ———`,
    `成交: ${grid.cnt} 笔 | 净PnL: ${sign(grid.net)} BTC`,
    `毛利: ${sign(grid.gross)} | 手续费: ${grid.fee.toFixed(4)}`,
    `——— 持仓状态 ———`,
    snap
      ? `仓位: ${snap.position_contracts} 张 | BTC Δ: ${snap.btc_delta.toFixed(4)} | 制度: ${snap.regime ?? "n/a"}`
      : "无最新持仓快照",
  ].join("\n");

  await sendNotification(report);
  console.log("Daily report sent.");
}

main().catch((err) => {
  console.error("daily_pnl_notify error:", err);
  process.exit(1);
});
