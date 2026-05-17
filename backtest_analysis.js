const Database = require("better-sqlite3");
const db = new Database("./data/cryptobot.sqlite3", { readonly: true });

// 基础统计
const total = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE btc_return IS NOT NULL").get();
const wins = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE up_won = 1 AND btc_return IS NOT NULL").get();
const avgReturn = db.prepare("SELECT AVG(btc_return * 100) as avg FROM window_summaries WHERE btc_return IS NOT NULL").get();
const avgUp = db.prepare("SELECT AVG(profit_if_up) as avg FROM window_summaries WHERE profit_if_up IS NOT NULL").get();
const avgDown = db.prepare("SELECT AVG(profit_if_down) as avg FROM window_summaries WHERE profit_if_down IS NOT NULL").get();
const stdReturn = null;

// 信号统计
const withSignalUp = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE signal_up_price IS NOT NULL").get();
const withSignalDown = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE signal_down_price IS NOT NULL").get();
const signalUpWins = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE signal_up_price IS NOT NULL AND up_won = 1").get();
const signalDownWins = db.prepare("SELECT COUNT(*) as c FROM window_summaries WHERE signal_down_price IS NOT NULL AND up_won = 0").get();

// 分布
const buckets = db.prepare(`
  SELECT
    CASE
      WHEN btc_return * 100 < -1 THEN 'lt_-1%'
      WHEN btc_return * 100 BETWEEN -1 AND 0 THEN '-1~0%'
      WHEN btc_return * 100 BETWEEN 0 AND 1 THEN '0~1%'
      ELSE 'gt_1%'
    END as bucket,
    COUNT(*) as c
  FROM window_summaries
  WHERE btc_return IS NOT NULL
  GROUP BY bucket
`).all();

// 最近50窗口
const recent = db.prepare(`
  SELECT slug, window_end_timestamp, btc_return, up_won,
         profit_if_up, profit_if_down, signal_up_price, signal_down_price
  FROM window_summaries
  WHERE btc_return IS NOT NULL
  ORDER BY window_end_timestamp DESC
  LIMIT 50
`).all();

console.log("=== BACKTEST SUMMARY (all windows, unfiltered) ===");
console.log("Total windows:", total.c);
console.log("UP wins:", wins.c, "(" + (wins.c/total.c*100).toFixed(1) + "%)");
console.log("DOWN wins:", total.c - wins.c, "(" + ((total.c-wins.c)/total.c*100).toFixed(1) + "%)");
console.log("Avg BTC return:", avgReturn.avg?.toFixed(3) + "%");
console.log("Avg profit_if_up:", avgUp.avg?.toFixed(3) + "%");
console.log("Avg profit_if_down:", avgDown.avg?.toFixed(3) + "%");
console.log("");
console.log("=== RETURN DISTRIBUTION ===");
buckets.forEach(b => console.log(" ", b.bucket, ":", b.c, "windows"));
console.log("");
console.log("=== SIGNAL STATS ===");
console.log("Signal UP count:", withSignalUp.c, "| wins:", signalUpWins.c, "| win rate:", withSignalUp.c > 0 ? (signalUpWins.c/withSignalUp.c*100).toFixed(1) + "%" : "N/A");
console.log("Signal DOWN count:", withSignalDown.c, "| wins:", signalDownWins.c, "| win rate:", withSignalDown.c > 0 ? (signalDownWins.c/withSignalDown.c*100).toFixed(1) + "%" : "N/A");
console.log("");
console.log("=== RECENT 20 WINDOWS ===");
recent.slice(0,20).forEach(w => {
  const ts = new Date(w.window_end_timestamp * 1000).toISOString().slice(0,16);
  const dir = w.up_won ? "UP_WON" : "DN_WON";
  const sig = (w.signal_up_price ? "UP@"+w.signal_up_price : "-") + " | " + (w.signal_down_price ? "DN@"+w.signal_down_price : "-");
  console.log(ts, "|", dir, "| BTC:"+(w.btc_return*100).toFixed(2)+"%", "| P(up):"+w.profit_if_up?.toFixed(2)+"%", "| P(dn):"+w.profit_if_down?.toFixed(2)+"%", "|", sig);
});

db.close();