/**
 * Contrarian PM Strategy Runner
 *
 * Signal: When Polymarket BTC-up probability > threshold (default 0.75),
 * the crowd is excessively bullish → SHORT the next 5-min window.
 *
 * Exit:   Reuses existing risk management (stop-loss, break-even, step-down, max_holding).
 *         These are checked every SIGNAL_INTERVAL_MS just like the main runner.
 *
 * Usage:  CONTRARIAN_THRESHOLD=0.75 CONTRARIAN_SIZE=2 npx tsx src/trade/contrarian_runner.ts
 */

import {
  getPositions,
  closeAllPositions,
  closePositionPartially,
  buyUp,
  sellDown,
  getAccountBalance,
} from "./okx_trade.js";
import { fetchBtcPrice } from "../monitor/okx.js";
import { pollPolymarket } from "../monitor/polymarket.js";
import { fetchOkxKlines, okxToBinanceCandle } from "../monitor/okx_klines.js";
import { config as dotenvConfig } from "dotenv";
import type { Candle } from "../monitor/binance.js";

dotenvConfig();

// ─── Config ───────────────────────────────────────────────────────────────────

const WINDOW_DURATION_MINUTES = parseInt(process.env.WINDOW_DURATION_MINUTES ?? "15");
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS ?? "10000");

// Contrarian parameters
const PM_THRESHOLD = parseFloat(process.env.CONTRARIAN_THRESHOLD ?? "0.75");
const BASE_POSITION_SIZE = parseInt(process.env.CONTRARIAN_SIZE ?? "2");
const ENABLE_TRADING = process.env.ENABLE_TRADING === "true";

// Exit / risk management (shared with main runner)
const STOP_LOSS_PCT = parseFloat(process.env.CONTRARIAN_STOP_LOSS_PCT ?? "0.4");
const BREAK_EVEN_PCT = parseFloat(process.env.CONTRARIAN_BREAK_EVEN_PCT ?? "0.15");
const CLOSE_BEFORE_MINS = parseFloat(process.env.CLOSE_BEFORE_MINS ?? "0.5");
const MAX_HOLDING_MS = parseInt(process.env.MAX_HOLDING_MS ?? (25 * 60 * 1000).toString());
const FLOATING_PROFIT_THRESHOLD_PCT = parseFloat(process.env.FLOATING_PROFIT_THRESHOLD_PCT ?? "0.5");
const STEP_DOWN_LEVELS: { profitPct: number; closeFraction: number }[] = [
  { profitPct: 1.0, closeFraction: 0.25 },
  { profitPct: 2.0, closeFraction: 0.25 },
];

const CONTRACT_SIZE = 0.01;    // BTC-USDT-SWAP: 1 contract = 0.01 BTC
const TAKER_FEE_RATE = 0.0005; // OKX taker fee 0.05% per side

// ─── State ────────────────────────────────────────────────────────────────────

interface PositionState {
  side: "long" | "short" | null;
  entryPrice: number | null;
  entryTime: number | null;
  windowEndTimestamp: number | null;
  orderId: string | null;
  originalSize: number | null;
  lastStepIndex: number;
  stopLossPct: number;
  breakEvenActivated: boolean;
}

const FLAT_POSITION: PositionState = {
  side: null, entryPrice: null, entryTime: null,
  windowEndTimestamp: null, orderId: null, originalSize: null,
  lastStepIndex: -1, stopLossPct: STOP_LOSS_PCT, breakEvenActivated: false,
};

let position: PositionState = { ...FLAT_POSITION };
let lastBtcPrice: number | null = null;
let lastCandles: Candle[] = [];
let lastPollResult: { slug: string; endTimestamp: number; upBid: number; downBid: number } | null = null;

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] [CONTRARIAN] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Position sync ────────────────────────────────────────────────────────────

async function syncPosition(): Promise<void> {
  if (!ENABLE_TRADING) return; // simulation mode: skip OKX sync
  const positions = await getPositions("BTC-USDT-SWAP");
  const activePositions = positions.filter((p) => parseInt(p.pos) !== 0);
  if (!activePositions.length) {
    if (position.side !== null) {
      log(`[POS] Flat — no open positions`);
    }
    position = { ...FLAT_POSITION };
    return;
  }
  const pos = activePositions[0];
  const side =
    pos.posSide === "long" ? "long" :
    pos.posSide === "short" ? "short" :
    (parseInt(pos.pos) > 0 ? "long" : "short");
  const avgPx = parseFloat(pos.avgPx) || null;
  if (position.side !== side || position.entryPrice !== avgPx) {
    log(`[POS] ${side.toUpperCase()} | avgPx=${pos.avgPx} | sz=${pos.pos} | upl=${pos.upl}`);
    position.side = side;
    position.entryPrice = avgPx;
    position.entryTime = Date.now();
    position.orderId = null;
  }
}

// ─── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateSignal(): Promise<boolean> {
  // Poll Polymarket
  const pollResult = await pollPolymarket("btc", WINDOW_DURATION_MINUTES);
  if (!pollResult || pollResult.marketClosed) {
    return false;
  }
  const { slug, endTimestamp, upBid, downBid } = pollResult;
  if (upBid === null || downBid === null) return false;

  lastPollResult = { slug, endTimestamp, upBid, downBid };

  // Fetch BTC price
  const btcPrice = await fetchBtcPrice();
  if (btcPrice === null) return false;
  lastBtcPrice = btcPrice;

  // Fetch candles for regime detection
  const barLimit = WINDOW_DURATION_MINUTES <= 15 ? "1m" : "5m";
  const klines = await fetchOkxKlines(barLimit, 60).catch(() => []);
  lastCandles = klines.map(okxToBinanceCandle);

  return true;
}

// ─── Regime detection (simplified, for exit logic) ───────────────────────────

type Regime = "TREND_UP" | "TREND_DOWN" | "NEUTRAL";

function detectRegime(candles: Candle[]): Regime {
  if (candles.length < 20) return "NEUTRAL";
  const recent = candles.slice(-20);
  const ema = recent.reduce((sum, c) => sum + c.close, 0) / recent.length;
  const lastClose = recent[recent.length - 1].close;
  if (lastClose > ema * 1.005) return "TREND_UP";
  if (lastClose < ema * 0.995) return "TREND_DOWN";
  return "NEUTRAL";
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function tryOpenPosition(): Promise<boolean> {
  if (!lastPollResult) return false;
  const { upBid, endTimestamp } = lastPollResult;

  const pmUpProb = upBid; // upBid is the PM up probability
  const nowSec = Date.now() / 1000;
  const timeRemaining = endTimestamp - nowSec;
  const windowDurationSec = WINDOW_DURATION_MINUTES * 60;
  const timeRatio = timeRemaining / windowDurationSec;

  // Entry conditions:
  // 1. PM probability above threshold (crowd is too bullish → short)
  // 2. At least 1 min remaining in window (don't enter in last minute)
  // 3. Not already in a position
  if (pmUpProb < PM_THRESHOLD) {
    log(`[WAIT] PM=${pmUpProb.toFixed(3)} < threshold=${PM_THRESHOLD} | ratio=${timeRatio.toFixed(2)}`);
    return false;
  }

  if (timeRatio < 0.05) {
    log(`[SKIP] Window almost over (ratio=${timeRatio.toFixed(2)}), too risky to enter`);
    return false;
  }

  if (position.side !== null) {
    log(`[POS] Already ${position.side}, skipping contrarian open`);
    return false;
  }

  // Fee check: expected loss from a -2.73% mean reversion vs round-trip fees
  const btcRef = lastBtcPrice ?? 76000;
  const feeRoundTrip = btcRef * CONTRACT_SIZE * TAKER_FEE_RATE * 2;
  const expectedLoss = 0.0273 * btcRef * CONTRACT_SIZE; // mean reversion = -2.73%
  if (expectedLoss < feeRoundTrip) {
    log(`[SKIP] EV=${expectedLoss.toFixed(2)} < fee=${feeRoundTrip.toFixed(2)}`);
    return false;
  }

  const size = BASE_POSITION_SIZE.toString();

  if (!ENABLE_TRADING) {
    log(`[SIM] Would SHORT: PM=${pmUpProb.toFixed(3)} size=${size} BTC≈$${btcRef}`);
    return false;
  }

  log(`[TRADE] sellDown — contrarian SHORT | PM=${pmUpProb.toFixed(3)} size=${size}`);
  const result = await sellDown("BTC-USDT-SWAP", size);

  if (result?.sCode === "0") {
    position = {
      side: "short",
      entryPrice: lastBtcPrice,
      entryTime: Date.now(),
      windowEndTimestamp: endTimestamp,
      orderId: result.ordId,
      originalSize: BASE_POSITION_SIZE,
      lastStepIndex: -1,
      stopLossPct: STOP_LOSS_PCT,
      breakEvenActivated: false,
    };
    log(`[TRADE] Opened SHORT | ordId=${result.ordId} | BTC≈${lastBtcPrice} | PM=${pmUpProb.toFixed(3)} | stop=${STOP_LOSS_PCT}%`);
    return true;
  }

  log(`[WARN] sellDown failed: ${JSON.stringify(result)}`);
  return false;
}

// ─── Step-down exit ──────────────────────────────────────────────────────────

async function tryStepDownPosition(): Promise<void> {
  if (position.side === null || position.originalSize === null) return;

  const floatingPnlPct =
    position.entryPrice && lastBtcPrice
      ? (position.side === "long"
          ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
          : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
      : 0;

  let nextStepIndex = position.lastStepIndex + 1;
  if (nextStepIndex >= STEP_DOWN_LEVELS.length) return;
  const nextStep = STEP_DOWN_LEVELS[nextStepIndex];
  if (floatingPnlPct < nextStep.profitPct) return;

  const positions = await getPositions("BTC-USDT-SWAP");
  const pos = positions[0];
  if (!pos || parseInt(pos.pos) === 0) return;

  const currentSize = parseInt(pos.pos);
  const originalSize = position.originalSize ?? currentSize;
  const toClose = Math.min(
    currentSize,
    Math.max(1, Math.floor(originalSize * nextStep.closeFraction))
  );

  if (!ENABLE_TRADING) {
    log(`[SIM] Step-down #${nextStepIndex + 1}: would close ${toClose}/${currentSize} @ profit ${floatingPnlPct.toFixed(3)}%`);
    position.lastStepIndex = nextStepIndex;
    return;
  }

  const closed = await closePositionPartially("BTC-USDT-SWAP", toClose.toString());
  if (closed) {
    log(`[TRADE] Step-down #${nextStepIndex + 1}: closed ${closed}/${currentSize} @ profit ${floatingPnlPct.toFixed(3)}%`);
    position.lastStepIndex = nextStepIndex;
    const remaining = await getPositions("BTC-USDT-SWAP");
    if (!remaining.length || parseInt(remaining[0].pos) === 0) {
      const pnl =
        position.entryPrice && lastBtcPrice
          ? (position.side === "long"
              ? lastBtcPrice - position.entryPrice
              : position.entryPrice - lastBtcPrice) * CONTRACT_SIZE
          : 0;
      log(`[TRADE] All closed | PnL≈${pnl.toFixed(4)} USD`);
      position = { ...FLAT_POSITION };
    }
  }
}

// ─── Exit logic ───────────────────────────────────────────────────────────────

async function tryClosePosition(): Promise<boolean> {
  if (position.side === null) return false;

  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const holdDurationMs = position.entryTime ? Date.now() - position.entryTime : 0;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;

  const floatingPnlPct =
    position.entryPrice && lastBtcPrice
      ? (position.side === "long"
          ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
          : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
      : 0;
  const inProfit = floatingPnlPct >= FLOATING_PROFIT_THRESHOLD_PCT;

  // Break-even stop
  if (!position.breakEvenActivated && floatingPnlPct >= BREAK_EVEN_PCT) {
    position.breakEvenActivated = true;
    position.stopLossPct = 0;
    log(`[RISK] Break-even armed @ entry=${position.entryPrice} (profit=${floatingPnlPct.toFixed(3)}%)`);
  }

  const regime = detectRegime(lastCandles);
  const regimeAligned =
    (position.side === "long" && regime === "TREND_UP") ||
    (position.side === "short" && regime === "TREND_DOWN");
  const regimeShifted =
    (position.side === "long" && regime === "TREND_DOWN") ||
    (position.side === "short" && regime === "TREND_UP");

  const stopLossHit = floatingPnlPct <= -position.stopLossPct;
  const windowClosingSoon = remaining <= 0 || remaining < closeBeforeSec;
  const maxHoldingExceeded = holdDurationMs > MAX_HOLDING_MS;

  // Don't exit on max_holding if we're in profit and regime is aligned
  if (maxHoldingExceeded && inProfit && regimeAligned) {
    return false;
  }

  if (!stopLossHit && !windowClosingSoon && !regimeShifted && !maxHoldingExceeded) {
    return false;
  }

  const exitReason = stopLossHit ? `stop_loss(${floatingPnlPct.toFixed(3)}%)`
    : windowClosingSoon ? "window_closing"
    : regimeShifted ? "regime_shift"
    : "max_holding";

  if (!ENABLE_TRADING) {
    log(`[SIM] Would close: ${exitReason} remaining=${remaining.toFixed(0)}s hold=${(holdDurationMs/60000).toFixed(1)}m profit=${floatingPnlPct.toFixed(3)}%`);
    return false;
  }

  log(`[TRADE] closeAllPositions — reason=${exitReason} remaining=${remaining.toFixed(0)}s hold=${(holdDurationMs/60000).toFixed(1)}m profit=${floatingPnlPct.toFixed(3)}%`);
  await closeAllPositions("BTC-USDT-SWAP");

  const pnl =
    position.entryPrice && lastBtcPrice
      ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice) * CONTRACT_SIZE
      : 0;
  log(`[TRADE] Closed ${position.side?.toUpperCase()} | PnL≈${pnl.toFixed(4)} USD (BTC ${position.entryPrice}→${lastBtcPrice})`);

  position = { ...FLAT_POSITION };
  return true;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Contrarian runner starting`);
  log(`PM threshold: >${PM_THRESHOLD} | Size: ${BASE_POSITION_SIZE} contracts | Trading: ${ENABLE_TRADING}`);
  log(`Risk: stop_loss=${STOP_LOSS_PCT}% | break_even=${BREAK_EVEN_PCT}% | max_holding=${MAX_HOLDING_MS/60000}m`);

  // Sync initial position
  await syncPosition();

  // Test connectivity
  if (ENABLE_TRADING) {
    const balance = await getAccountBalance();
    if (balance && balance[0]) {
      const bal = balance[0];
      const usdtBal = (bal as any).details?.find((d: any) => d.ccy === "USDT");
      const availEq = usdtBal?.availEq ?? (bal as any).totalEq ?? "N/A";
      log(`Balance: availEq=${availEq} USDT`);
    }
  } else {
    log(`Balance: simulation mode (no OKX connection)`);
  }

  log(`Starting contrarian signal loop...`);

  while (true) {
    try {
      await syncPosition();

      const hasMarket = await evaluateSignal();
      if (!hasMarket) {
        await sleep(SIGNAL_INTERVAL_MS);
        continue;
      }

      const { upBid, endTimestamp } = lastPollResult!;
      const regime = detectRegime(lastCandles);
      const pmUpProb = upBid;

      log(
        `PM=${pmUpProb.toFixed(3)} | regime=${regime} | BTC≈$${lastBtcPrice}` +
        (position.side ? ` | POS=${position.side.toUpperCase()}` : " | FLAT")
      );

      if (position.side !== null) {
        // In position: manage exits
        await tryStepDownPosition();
        await tryClosePosition();
      } else {
        // Flat: check for contrarian entry
        await tryOpenPosition();
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
