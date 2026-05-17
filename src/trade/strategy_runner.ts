/**
 * Phase 2: Strategy-driven trading runner
 *
 * Reads current position state, evaluates signals, manages entries/exits.
 * Run as a separate process alongside the collector.
 *
 * Usage: npx tsx src/trade/strategy_runner.ts
 */

import { getPositions, closeAllPositions, buyUp, sellDown, getAccountBalance } from "./okx_trade.js";
import { scoreStrategy, DEFAULT_SCORING_CONFIG, calcTimeRatio } from "../strategy/scoring.js";
import { fetchOkxKlines, okxToBinanceCandle } from "../monitor/okx_klines.js";
import { fetchBtcPrice } from "../monitor/okx.js";
import { pollPolymarket } from "../monitor/polymarket.js";
import { config as dotenvConfig } from "dotenv";
import type { StrategySignal } from "../types.js";

dotenvConfig();

// ─── Config ───────────────────────────────────────────────────────────────────

const WINDOW_DURATION_MINUTES = parseInt(process.env.WINDOW_DURATION_MINUTES ?? "15");
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS ?? "10000");
const MAX_POSITION_SIZE = parseInt(process.env.MAX_POSITION_SIZE ?? "1");
const ENABLE_TRADING = process.env.ENABLE_TRADING !== "false"; // default true for paper trading
const CLOSE_BEFORE_MINS = parseFloat(process.env.CLOSE_BEFORE_MINS ?? "0.5"); // close N mins before expiry

// ─── State ────────────────────────────────────────────────────────────────────

interface PositionState {
  side: "long" | "short" | null;  // null = flat
  entryPrice: number | null;
  entryTime: number | null;
  slug: string | null;
  windowEndTimestamp: number | null;
  orderId: string | null;
}

let position: PositionState = { side: null, entryPrice: null, entryTime: null, slug: null, windowEndTimestamp: null, orderId: null };
let lastSignal: StrategySignal | null = null;
let lastBtcPrice: number | null = null;

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Position sync ────────────────────────────────────────────────────────────

/** Sync position state from OKX */
async function syncPosition(): Promise<void> {
  const positions = await getPositions("BTC-USDT-SWAP");
  if (!positions.length) {
    if (position.side !== null) {
      log(`[POS] Flat — no open positions on OKX`);
    }
    position = { side: null, entryPrice: null, entryTime: null, slug: null, windowEndTimestamp: null, orderId: null };
    return;
  }
  const pos = positions[0];
  const side = pos.posSide === "long" ? "long" : pos.posSide === "short" ? "short" : (parseInt(pos.pos) > 0 ? "long" : "short");
  if (position.side !== side || position.entryPrice !== parseFloat(pos.avgPx)) {
    log(`[POS] ${side.toUpperCase()} | avgPx=${pos.avgPx} | sz=${pos.pos} | upl=${pos.upl} | liqPx=${pos.liqPx}`);
    position.side = side;
    position.entryPrice = parseFloat(pos.avgPx);
    position.entryTime = Date.now();
    position.orderId = null; // OKX doesn't expose posId in position list
  }
}

// ─── Signal evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate current market signal.
 * Uses PM probability + TA + regime + time awareness.
 */
async function evaluateSignal(): Promise<{
  signal: StrategySignal;
  btcPrice: number;
} | null> {
  const pollResult = await pollPolymarket("btc", WINDOW_DURATION_MINUTES);
  if (!pollResult || pollResult.marketClosed) {
    return null;
  }

  const { slug, endTimestamp, upBid, upAsk, downBid } = pollResult;
  if (upBid === null || downBid === null) return null;

  const btcPrice = await fetchBtcPrice();
  if (btcPrice === null) return null;
  lastBtcPrice = btcPrice;

  // Fetch candles for TA
  const barLimit = WINDOW_DURATION_MINUTES <= 15 ? "1m" : "5m";
  const klines = await fetchOkxKlines(barLimit, 60).catch(() => []);
  const candles = klines.map(okxToBinanceCandle);

  // Score the strategy
  const signal = scoreStrategy(candles, upBid, endTimestamp, {
    ...DEFAULT_SCORING_CONFIG,
    // Override window duration for scoring
  });

  return { signal, btcPrice };
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function tryOpenPosition(signal: StrategySignal): Promise<boolean> {
  if (!ENABLE_TRADING) {
    log(`[SIM] Would open: ${signal.direction} edge=${signal.edge.toFixed(3)} prob=${signal.confidence.toFixed(3)}`);
    return false;
  }

  if (position.side !== null) {
    log(`[POS] Already ${position.side}, skipping open`);
    return false;
  }

  const size = "1";
  let result = null;

  if (signal.direction === "up") {
    log(`[TRADE] buyUp — edge=${signal.edge.toFixed(3)} prob=${signal.confidence.toFixed(3)}`);
    result = await buyUp("BTC-USDT-SWAP", size);
    if (result?.sCode === "0") {
      position = {
        side: "long",
        entryPrice: lastBtcPrice,
        entryTime: Date.now(),
        slug: null,
        windowEndTimestamp: null,
        orderId: result.ordId,
      };
      log(`[TRADE] Opened LONG | ordId=${result.ordId} | BTC≈${lastBtcPrice}`);
      return true;
    }
  } else if (signal.direction === "down") {
    log(`[TRADE] sellDown — edge=${signal.edge.toFixed(3)} prob=${signal.confidence.toFixed(3)}`);
    result = await sellDown("BTC-USDT-SWAP", size);
    if (result?.sCode === "0") {
      position = {
        side: "short",
        entryPrice: lastBtcPrice,
        entryTime: Date.now(),
        slug: null,
        windowEndTimestamp: null,
        orderId: result.ordId,
      };
      log(`[TRADE] Opened SHORT | ordId=${result.ordId} | BTC≈${lastBtcPrice}`);
      return true;
    }
  }
  return false;
}

// ─── Exit logic ───────────────────────────────────────────────────────────────

async function tryClosePosition(signal: StrategySignal): Promise<boolean> {
  if (position.side === null) return false;

  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;

  // Exit reason: window closing soon, or regime shifted against us
  const windowClosingSoon = remaining < closeBeforeSec && remaining > 0;
  const regimeShifted = (position.side === "long" && signal.regime === "TREND_DOWN")
                     || (position.side === "short" && signal.regime === "TREND_UP");

  if (!windowClosingSoon && !regimeShifted && remaining > 0) {
    return false;
  }

  if (!ENABLE_TRADING) {
    log(`[SIM] Would close: reason=${windowClosingSoon ? "window_closing" : "regime_shift"} remaining=${remaining.toFixed(0)}s`);
    return false;
  }

  log(`[TRADE] closeAllPositions — reason=${windowClosingSoon ? "window_closing" : "regime_shift"} remaining=${remaining.toFixed(0)}s`);
  await closeAllPositions("BTC-USDT-SWAP");

  const pnl = position.entryPrice && lastBtcPrice
    ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice)
    : 0;
  log(`[TRADE] Closed ${position.side?.toUpperCase()} | PnL≈${pnl.toFixed(2)} (BTC ${position.entryPrice}→${lastBtcPrice})`);

  position = { side: null, entryPrice: null, entryTime: null, slug: null, windowEndTimestamp: null, orderId: null };
  return true;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Strategy runner starting`);
  log(`Window: ${WINDOW_DURATION_MINUTES}min | Interval: ${SIGNAL_INTERVAL_MS}ms | Trading: ${ENABLE_TRADING}`);

  // Sync initial position
  await syncPosition();

  // Test OKX connectivity
  const balance = await getAccountBalance();
  if (balance && balance[0]) {
    const bal = balance[0];
    const usdtBal = (bal as any).details?.find((d: any) => d.ccy === "USDT");
    const availEq = usdtBal?.availEq ?? (bal as any).totalEq ?? "N/A";
    log(`Balance: availEq=${availEq} USDT`);
  } else {
    log(`WARNING: Could not fetch OKX balance`);
  }

  log(`Starting signal loop...`);

  while (true) {
    try {
      // Sync position from OKX
      await syncPosition();

      // Evaluate signal
      const evalResult = await evaluateSignal();
      if (!evalResult) {
        await sleep(SIGNAL_INTERVAL_MS);
        continue;
      }

      const { signal, btcPrice } = evalResult;
      lastSignal = signal;
      position.windowEndTimestamp = signal.reason.includes("stage=")
        ? 0  // Will be updated when we have the actual window end
        : 0;

      // Log signal every tick
      const dir = signal.direction === "none" ? "—" : signal.direction.toUpperCase();
      const edge = signal.edge >= 0 ? `+${signal.edge.toFixed(3)}` : signal.edge.toFixed(3);
      log(`${dir} | edge=${edge} | conf=${signal.confidence.toFixed(3)} | regime=${signal.regime} | stage=${signal.stage} | ratio=${signal.upPriceRatio.toFixed(3)} | BTC=$${btcPrice}`);

      if (position.side !== null) {
        // Try to close if in a position
        const closed = await tryClosePosition(signal);
        if (closed) {
          // Position just closed — don't open a new one immediately
        }
      } else {
        // Try to open if flat
        if (signal.direction !== "none") {
          await tryOpenPosition(signal);
        }
      }
    } catch (err) {
      log(`ERROR: ${err}`);
    }

    await sleep(SIGNAL_INTERVAL_MS);
  }
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  log(`Shutting down...`);
  if (position.side !== null) {
    log(`Closing open position before exit...`);
    await closeAllPositions("BTC-USDT-SWAP");
  }
  process.exit(0);
});

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});