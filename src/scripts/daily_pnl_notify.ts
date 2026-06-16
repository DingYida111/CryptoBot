/**
 * Daily PnL report pushed to Gary WeChat bot via iLink API.
 * Run via PM2 cron or manually: npx tsx src/scripts/daily_pnl_notify.ts
 *
 * Required env: GARY_ILINK_TOKEN, GARY_ILINK_TO_USER (optional, falls back to stdout)
 * Optional env: GARY_ILINK_CONTEXT_TOKEN (for session continuity)
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
  const token = process.env.GARY_ILINK_TOKEN;
  const toUser = process.env.GARY_ILINK_TO_USER;
  if (!token || !toUser) {
    console.log("[DailyReport] Gary iLink not configured, printing to stdout:\n" + text);
    return;
  }
  const contextToken = process.env.GARY_ILINK_CONTEXT_TOKEN;
  const msg: Record<string, unknown> = {
    from_user_id: "",
    to_user_id: toUser,
    client_id: Math.random().toString(36).slice(2),
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }],
  };
  if (contextToken) msg["context_token"] = contextToken;
  const body = JSON.stringify({ msg, base_info: { channel_version: "2.2.0" } });
  const uin = Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString("base64");
  const resp = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Authorization": `Bearer ${token}`,
      "X-WECHAT-UIN": uin,
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "131584",
    },
    body,
  });
  if (!resp.ok) throw new Error(`iLink POST failed: ${resp.status} ${await resp.text()}`);
  const result = await resp.json() as { errcode?: number; errmsg?: string };
  if (result.errcode && result.errcode !== 0) {
    throw new Error(`iLink error: ${result.errcode} ${result.errmsg}`);
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
