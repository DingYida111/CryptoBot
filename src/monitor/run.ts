/**
 * Data collection runner + strategy signal generator
 * Phase 1: polls Polymarket + OKX every N ms, stores to SQLite
 * Phase 2: computes TA signals, regime detection
 */

import * as fs from "fs";
import * as path from "path";
import { pollPolymarket } from "./polymarket.js";
import { fetchBtcPrice } from "./okx.js";
import { fetchOkxKlines, okxToBinanceCandle } from "./okx_klines.js";
import { insertTick, insertWindowSummary, getStats, closeDb } from "./storage.js";
import { detectRegime } from "../strategy/regime.js";
import type { Tick, Coin } from "../types.js";

// Load .env synchronously
import { config as dotenvConfig } from "dotenv";
dotenvConfig();

import { z } from "zod";

// ── Env schema (validated at startup) ────────────────────────────────────────
const EnvSchema = z.object({
  DATA_COLLECT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  TARGET_MARKETS: z.string().default("btc"),
  WINDOW_DURATION_MINUTES: z.coerce.number().int().min(1).default(15),
  LOG_DIR: z.string().default("logs"),
  LOG_FILE_PREFIX: z.string().default("collector"),
  POLYMARKET_FEE_RATE: z.coerce.number().min(0).max(1).default(0.02), // 2% taker fee
  SIGNAL_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.55),
});

const _envParsed = EnvSchema.safeParse(process.env);
if (!_envParsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of _envParsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}
const ENV = _envParsed.data;

// Config from validated env
const INTERVAL_MS = ENV.DATA_COLLECT_INTERVAL_MS;
const TARGET_MARKETS = ENV.TARGET_MARKETS.split(",").map((s) => s.trim().toLowerCase()) as Coin[];
const WINDOW_DURATION_MINUTES = ENV.WINDOW_DURATION_MINUTES;
const LOG_DIR = path.resolve(ENV.LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, `${ENV.LOG_FILE_PREFIX}-${new Date().toISOString().slice(0, 10)}.log`);
const POLYMARKET_FEE_RATE = ENV.POLYMARKET_FEE_RATE;
const SIGNAL_THRESHOLD = ENV.SIGNAL_THRESHOLD;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main collection loop for a single coin
 */
async function collectCoin(coin: Coin): Promise<void> {
  const result = await pollPolymarket(coin, WINDOW_DURATION_MINUTES);

  if (!result) {
    log(`[${coin}] Market not available yet`);
    return;
  }

  const { slug, endTimestamp, upBid, upAsk, downBid, downAsk } = result;

  // Fetch OKX BTC price + klines in parallel
  const [btcPrice, okxRaw] = await Promise.all([
    fetchBtcPrice(),
    fetchOkxKlines(WINDOW_DURATION_MINUTES <= 15 ? "1m" : "5m", 60).catch(() => [] as any[]),
  ]);

  const candles = okxRaw.map(okxToBinanceCandle);
  const upPriceRatio = upBid !== null ? Math.abs(upBid - 0.5) / 0.5 : 0;
  const regimeInfo = detectRegime(candles);

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

    if (prevSlug in windowStartPrice && btcPrice) {
      const exitPrice = btcPrice;
      const entryPrice = windowStartPrice[prevSlug];
      const btcReturn = (exitPrice - entryPrice) / entryPrice;

      const upWon = btcReturn > 0;
      const profitIfUp = upWon ? (1 - (entryPrice / exitPrice)) * 100 : -1;
      const profitIfDown = !upWon ? (1 - (exitPrice / entryPrice)) * 100 : -1;

      // Friction costs: spread at entry time + platform fee on notional
      const spreadAtEntry = (upAsk !== null && upBid !== null) ? (upAsk - upBid) : null;
      const feePerShare = POLYMARKET_FEE_RATE;  // fee as fraction of $1 notional
      const spreadCost = spreadAtEntry;
      const feeCost = feePerShare;
      const totalFriction = (spreadCost ?? 0) + (feeCost ?? 0);
      const netProfitIfUp = profitIfUp !== null ? profitIfUp - totalFriction * 100 : null;
      const netProfitIfDown = profitIfDown !== null ? profitIfDown - totalFriction * 100 : null;

      insertWindowSummary({
        coin,
        slug: prevSlug,
        windowStartTimestamp: endTimestamp - WINDOW_DURATION_MINUTES * 60,
        windowEndTimestamp: endTimestamp,
        regime: regimeInfo.regime,
        regimeScore: regimeInfo.score,
        regimeReason: regimeInfo.reason,
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
        netProfitIfUp,
        netProfitIfDown,
        spreadCost,
        feeCost,
        createdAt: Date.now(),
      });

      log(`[${coin}] Window closed: UP ${upWon ? "WON" : "LOST"} | BTC ${entryPrice.toFixed(0)}→${exitPrice.toFixed(0)} (${(btcReturn * 100).toFixed(2)}%)`);
    }

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
  if (upBid !== null && upBid > SIGNAL_THRESHOLD && !signalUp[slug]) {
    signalUp[slug] = { price: upBid, time: Date.now() };
    log(`[${coin}] SIGNAL: UP > ${SIGNAL_THRESHOLD} (${upBid.toFixed(3)}) at ${slug}`);
  }
  if (downBid !== null && (1 - downBid) > SIGNAL_THRESHOLD && !signalDown[slug]) {
    signalDown[slug] = { price: downBid, time: Date.now() };
    log(`[${coin}] SIGNAL: DOWN > ${SIGNAL_THRESHOLD} (${downBid.toFixed(3)}) at ${slug}`);
  }

  // Log rate (every 12 ticks)
  const stats = getStats();
  const minuteStr = new Date().toISOString().slice(11, 16);
  if (upBid !== null && downBid !== null && stats.tickCount % 12 === 0) {
    const dir = upBid > 0.5 ? "🟢UP" : upBid < 0.5 ? "🔴DOWN" : "⚪FLAT";
    const pct = ((upBid - 0.5) * 200).toFixed(1);
    const btcStr = btcPrice ? ` BTC:$${btcPrice.toLocaleString()}` : "";
    const upPriceRatio = Math.abs(upBid - 0.5) / 0.5;
    log(`${minuteStr} | ${dir} ${pct}% | UP:$${upBid.toFixed(3)} DN:$${downBid.toFixed(3)}${btcStr} [${regimeInfo.regime} ${regimeInfo.score.toFixed(2)}] ratio:${upPriceRatio.toFixed(3)} | ${slug}`);
    log(`[${coin}] Stats: ${stats.tickCount} ticks, ${stats.windowCount} windows`);
  }
}

/**
 * Main loop
 */
async function main(): Promise<void> {
  log(`CryptoBot collector starting`);
  log(`Markets: ${TARGET_MARKETS.join(", ")} | Interval: ${INTERVAL_MS}ms | Window: ${WINDOW_DURATION_MINUTES}min`);

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