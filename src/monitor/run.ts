/**
 * Data collection runner
 * Polls Polymarket + OKX every N ms and stores ticks to SQLite
 */

import * as fs from "fs";
import * as path from "path";
import { pollPolymarket } from "./polymarket.js";
import { fetchBtcPrice } from "./okx.js";
import { insertTick, insertWindowSummary, getStats, closeDb } from "./storage.js";
import type { Tick, Coin } from "../types.js";

// Load .env
try {
  const dotenv = await import("dotenv");
  dotenv.config();
} catch {}

// Config from env with defaults
const INTERVAL_MS = parseInt(process.env.DATA_COLLECT_INTERVAL_MS ?? "5000");
const TARGET_MARKETS = (process.env.TARGET_MARKETS ?? "btc")
  .split(",")
  .map((s) => s.trim().toLowerCase()) as Coin[];
const WINDOW_DURATION_MINUTES = parseInt(process.env.WINDOW_DURATION_MINUTES ?? "15");
const LOG_DIR = path.resolve(process.env.LOG_DIR ?? "logs");
const LOG_FILE = path.join(LOG_DIR, `${process.env.LOG_FILE_PREFIX ?? "collector"}-${new Date().toISOString().slice(0, 10)}.log`);

// Track current window per coin to detect window changes
const currentSlug: Record<string, string> = {};
const windowStartPrice: Record<string, number> = {};
const signalUp: Record<string, { price: number; time: number } | null> = {};
const signalDown: Record<string, { price: number; time: number } | null> = {};

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function logRate(minuteStr: string, upBid: number, downBid: number, btcPrice: number | null, slug: string): void {
  const pct = ((upBid - 0.5) * 200).toFixed(1);
  const dir = upBid > 0.5 ? "🟢UP" : upBid < 0.5 ? "🔴DOWN" : "⚪FLAT";
  const btcStr = btcPrice ? ` BTC:$${btcPrice.toLocaleString()}` : "";
  log(`${minuteStr} | ${dir} ${pct}% | UP:$${upBid.toFixed(3)} DN:$${downBid.toFixed(3)}${btcStr} | ${slug}`);
}

/**
 * Main collection loop for a single coin
 */
async function collectCoin(coin: Coin): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const result = await pollPolymarket(coin, WINDOW_DURATION_MINUTES);

  if (!result) {
    log(`[${coin}] Market not available yet`);
    return;
  }

  const { slug, endTimestamp, upBid, upAsk, downBid, downAsk } = result;

  // Fetch OKX BTC price in parallel
  const btcPrice = await fetchBtcPrice();

  // Record tick
  const tick: Tick = {
    timestamp: Date.now(),
    coin,
    slug,
    upBid,
    upAsk,
    downBid,
    downAsk,
    btcPrice,
    marketEndTimestamp: endTimestamp,
    fetchedAt: Date.now(),
  };
  insertTick(tick);

  // Window change detection
  const prevSlug = currentSlug[coin];
  if (prevSlug && prevSlug !== slug) {
    log(`[${coin}] Window changed: ${prevSlug} → ${slug}`);

    // Compute window summary for the closed window
    if (prevSlug in windowStartPrice && btcPrice) {
      const exitPrice = btcPrice; // Use current price at window end
      const entryPrice = windowStartPrice[prevSlug];
      const btcReturn = (exitPrice - entryPrice) / entryPrice;

      // Estimate UP/DOWN outcome based on final price direction
      const upWon = btcReturn > 0;
      const profitIfUp = upWon ? (1 - (entryPrice / exitPrice)) * 100 : -1;
      const profitIfDown = !upWon ? (1 - (exitPrice / entryPrice)) * 100 : -1;

      insertWindowSummary({
        coin,
        slug: prevSlug,
        windowStartTimestamp: endTimestamp - WINDOW_DURATION_MINUTES * 60,
        windowEndTimestamp: endTimestamp,
        signalUpPrice: signalUp[prevSlug]?.price ?? null,
        signalDownPrice: signalDown[prevSlug]?.price ?? null,
        signalUpTime: signalUp[prevSlug]?.time ?? null,
        signalDownTime: signalDown[prevSlug]?.time ?? null,
        btcEntryPrice: entryPrice,
        btcExitPrice: exitPrice,
        btcReturn,
        upWon,
        profitIfUp,
        profitIfDown,
        createdAt: Date.now(),
      });

      log(`[${coin}] Window closed: UP ${upWon ? "WON" : "LOST"} | BTC ${entryPrice.toFixed(0)}→${exitPrice.toFixed(0)} (${(btcReturn * 100).toFixed(2)}%)`);
    }

    // Reset state for new window
    delete windowStartPrice[prevSlug];
    delete signalUp[prevSlug];
    delete signalDown[prevSlug];
  }

  // Track new slug and entry price
  if (!currentSlug[coin] || currentSlug[coin] !== slug) {
    currentSlug[coin] = slug;
    if (btcPrice) windowStartPrice[slug] = btcPrice;
    signalUp[slug] = null;
    signalDown[slug] = null;
  } else if (btcPrice && !(slug in windowStartPrice)) {
    windowStartPrice[slug] = btcPrice;
  }

  // Record signals (first time price exceeds threshold)
  const SIGNAL_THRESHOLD = 0.55;
  if (upBid !== null && upBid > SIGNAL_THRESHOLD && !signalUp[slug]) {
    signalUp[slug] = { price: upBid, time: Date.now() };
    log(`[${coin}] SIGNAL: UP > ${SIGNAL_THRESHOLD} (${upBid.toFixed(3)}) at ${slug}`);
  }
  if (downBid !== null && downBid > SIGNAL_THRESHOLD && !signalDown[slug]) {
    signalDown[slug] = { price: downBid, time: Date.now() };
    log(`[${coin}] SIGNAL: DOWN > ${SIGNAL_THRESHOLD} (${downBid.toFixed(3)}) at ${slug}`);
  }

  // Log rate (every 5 ticks to avoid spam)
  const stats = getStats();
  const minuteStr = new Date().toISOString().slice(11, 16);
  if (upBid !== null && downBid !== null) {
    if (stats.tickCount % 12 === 0) {
      logRate(minuteStr, upBid, downBid, btcPrice, slug);
      log(`[${coin}] Stats: ${stats.tickCount} ticks, ${stats.windowCount} windows closed`);
    }
  }
}

/**
 * Main loop
 */
async function main(): Promise<void> {
  log(`CryptoBot collector starting`);
  log(`Markets: ${TARGET_MARKETS.join(", ")} | Interval: ${INTERVAL_MS}ms | Window: ${WINDOW_DURATION_MINUTES}min`);

  // Check API connectivity first
  log("Testing Polymarket connectivity...");
  const testPoly = await pollPolymarket("btc", WINDOW_DURATION_MINUTES);
  if (!testPoly) {
    log("ERROR: Cannot reach Polymarket API. Check network/proxy.");
    process.exit(1);
  }
  log(`Polymarket OK: slug=${testPoly.slug} UP=${testPoly.upAsk} DOWN=${testPoly.downAsk}`);

  log("Testing OKX connectivity...");
  const testBtc = await fetchBtcPrice();
  if (!testBtc) {
    log("WARNING: Cannot reach OKX API. BTC price will be null.");
  } else {
    log(`OKX OK: BTC=${testBtc}`);
  }

  log("Starting collection loop...");

  // Collect indefinitely
  let count = 0;
  while (true) {
    for (const coin of TARGET_MARKETS) {
      await collectCoin(coin);
    }
    count++;
    if (count % 20 === 0) {
      const stats = getStats();
      log(`Heartbeat: ${stats.tickCount} ticks, ${stats.windowCount} windows`);
    }
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run
main().catch((err) => {
  log(`FATAL: ${err}`);
  closeDb();
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  closeDb();
  process.exit(0);
});