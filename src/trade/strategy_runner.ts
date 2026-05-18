/**
 * Phase 2: Strategy-driven trading runner
 *
 * Reads current position state, evaluates signals, manages entries/exits.
 * Run as a separate process alongside the collector.
 *
 * Usage: npx tsx src/trade/strategy_runner.ts
 */

import { getPositions, closeAllPositions, closePositionPartially, buyUp, sellDown, getAccountBalance } from "./okx_trade.js";
import { scoreStrategy, DEFAULT_SCORING_CONFIG, calcTimeRatio } from "../strategy/scoring.js";
import { getKronosProb, isKronosReady } from "../strategy/kronos.js";
import { fetchOkxKlines, okxToBinanceCandle } from "../monitor/okx_klines.js";
import { fetchBtcPrice } from "../monitor/okx.js";
import { pollPolymarket } from "../monitor/polymarket.js";
import { config as dotenvConfig } from "dotenv";
import type { StrategySignal } from "../types.js";
import type { Candle } from "../monitor/binance.js";

dotenvConfig();

// ─── Config ───────────────────────────────────────────────────────────────────

const WINDOW_DURATION_MINUTES = parseInt(process.env.WINDOW_DURATION_MINUTES ?? "15");
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS ?? "10000");
const MAX_POSITION_SIZE = parseInt(process.env.MAX_POSITION_SIZE ?? "1");
const ENABLE_TRADING = process.env.ENABLE_TRADING !== "false"; // default true for paper trading
const CLOSE_BEFORE_MINS = parseFloat(process.env.CLOSE_BEFORE_MINS ?? "0.5"); // close N mins before expiry
const MAX_HOLDING_MS = parseInt(process.env.MAX_HOLDING_MS ?? (25 * 60 * 1000).toString()); // safety max holding time
const FLOATING_PROFIT_THRESHOLD_PCT = parseFloat(process.env.FLOATING_PROFIT_THRESHOLD_PCT ?? "0.5"); // % of entry price
const CONTRACT_SIZE = 0.01;        // BTC-USDT-SWAP: 1 contract = 0.01 BTC
const TAKER_FEE_RATE = 0.0005;     // OKX taker fee 0.05% per side

// Risk management
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT ?? "0.3");       // hard stop: -0.3% of entry
const BREAK_EVEN_PCT = parseFloat(process.env.BREAK_EVEN_PCT ?? "0.1");     // activate break-even stop once +0.1% profit

// Step-down exit: lock in profits progressively
// Each step closes a fraction of the ORIGINAL position
const STEP_DOWN_LEVELS: { profitPct: number; closeFraction: number }[] = [
  { profitPct: 0.3, closeFraction: 0.25 }, // at 1% profit: close 25% of original
  { profitPct: 0.7, closeFraction: 0.25 }, // at 2% profit: close 25% of original (remaining 50% follows normal exit)
];

// ─── State ────────────────────────────────────────────────────────────────────

interface PositionState {
  side: "long" | "short" | null;  // null = flat
  entryPrice: number | null;
  entryTime: number | null;
  slug: string | null;
  windowEndTimestamp: number | null;
  orderId: string | null;
  originalSize: number | null;   // track original size for step-down calc
  lastStepIndex: number;          // last step-down level triggered (-1 = none)
  stopLossPct: number;            // current stop-loss threshold (may be 0 after break-even)
  breakEvenActivated: boolean;    // true once break-even stop has been armed
}

const FLAT_POSITION: PositionState = {
  side: null, entryPrice: null, entryTime: null, slug: null,
  windowEndTimestamp: null, orderId: null, originalSize: null,
  lastStepIndex: -1, stopLossPct: STOP_LOSS_PCT, breakEvenActivated: false,
};

let position: PositionState = { ...FLAT_POSITION };
let lastSignal: StrategySignal | null = null;
let lastBtcPrice: number | null = null;
let lastCandles: Candle[] = [];

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
  // Filter out ghost sz=0 records that OKX retains after closing
  const activePositions = positions.filter(p => parseInt(p.pos) !== 0);
  if (!activePositions.length) {
    if (position.side !== null) {
      log(`[POS] Flat — no open positions on OKX`);
    }
    position = { ...FLAT_POSITION };
    return;
  }
  const pos = activePositions[0];
  const side = pos.posSide === "long" ? "long" : pos.posSide === "short" ? "short" : (parseInt(pos.pos) > 0 ? "long" : "short");
  const avgPx = parseFloat(pos.avgPx) || null;  // guard against empty avgPx → NaN
  if (position.side !== side || position.entryPrice !== avgPx) {
    log(`[POS] ${side.toUpperCase()} | avgPx=${pos.avgPx} | sz=${pos.pos} | upl=${pos.upl} | liqPx=${pos.liqPx}`);
    position.side = side;
    position.entryPrice = avgPx;
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
  endTimestamp: number;
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
  lastCandles = candles;

  // Get Kronos ML signal (non-blocking, falls back to null if unavailable)
  const kronosResult = await getKronosProb(candles);
  const kronosProb = kronosResult?.probUp ?? null;
  if (kronosResult) {
    log(`[Kronos] prob_up=${kronosResult.probUp.toFixed(3)} delta=${kronosResult.deltaPercent.toFixed(4)}% latency=${kronosResult.latencyMs}ms`);
  }

  // Score the strategy (blends TA + Kronos)
  const signal = scoreStrategy(candles, upBid, endTimestamp, {
    ...DEFAULT_SCORING_CONFIG,
  }, WINDOW_DURATION_MINUTES * 60, kronosProb);

  return { signal, btcPrice, endTimestamp };
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function tryOpenPosition(signal: StrategySignal, endTimestamp: number): Promise<boolean> {
  // Fee-spread gate: skip if expected profit < round-trip fees
  const feeRoundTrip = (lastBtcPrice ?? 76000) * CONTRACT_SIZE * TAKER_FEE_RATE * 2;
  const last15 = lastCandles.slice(-15);
  const range15min = last15.length >= 5
    ? Math.max(...last15.map(c => c.high)) - Math.min(...last15.map(c => c.low))
    : (lastBtcPrice ?? 76000) * 0.002;
  const directionalEdge = Math.max(0, (signal.confidence - 0.5) * 2);
  const expectedProfit = directionalEdge * range15min * CONTRACT_SIZE;
  if (expectedProfit < feeRoundTrip) {
    log(`[SKIP] EV≈${expectedProfit.toFixed(4)} < fee_spread=${feeRoundTrip.toFixed(4)} | conf=${signal.confidence.toFixed(3)} range=${range15min.toFixed(0)}`);
    return false;
  }

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
        windowEndTimestamp: endTimestamp ?? null,
        orderId: result.ordId,
        originalSize: 1,
        lastStepIndex: -1,
        stopLossPct: STOP_LOSS_PCT,
        breakEvenActivated: false,
      };
      log(`[TRADE] Opened LONG | ordId=${result.ordId} | BTC≈${lastBtcPrice} | stop=${STOP_LOSS_PCT}%`);
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
        windowEndTimestamp: endTimestamp ?? null,
        orderId: result.ordId,
        originalSize: 1,
        lastStepIndex: -1,
        stopLossPct: STOP_LOSS_PCT,
        breakEvenActivated: false,
      };
      log(`[TRADE] Opened SHORT | ordId=${result.ordId} | BTC≈${lastBtcPrice} | stop=${STOP_LOSS_PCT}%`);
      return true;
    }
  }
  return false;
}

// ─── Step-down exit ──────────────────────────────────────────────────────────

async function tryStepDownPosition(signal: StrategySignal): Promise<void> {
  if (position.side === null || position.originalSize === null) return;

  const floatingPnlPct = position.entryPrice && lastBtcPrice
    ? (position.side === "long"
        ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
    : 0;

  // Find next step to trigger
  let nextStepIndex = position.lastStepIndex + 1;
  if (nextStepIndex >= STEP_DOWN_LEVELS.length) return;

  const nextStep = STEP_DOWN_LEVELS[nextStepIndex];
  if (floatingPnlPct < nextStep.profitPct) return;

  // Get current position size from OKX to calculate partial close
  const positions = await getPositions("BTC-USDT-SWAP");
  const pos = positions[0];
  if (!pos || parseInt(pos.pos) === 0) return;

  const currentSize = parseInt(pos.pos);
  // Calculate size based on ORIGINAL position, not current (which may be reduced already)
  const originalSize = position.originalSize ?? currentSize;
  const toClose = Math.min(currentSize, Math.max(1, Math.floor(originalSize * nextStep.closeFraction)));

  if (!ENABLE_TRADING) {
    log(`[SIM] Step-down #${nextStepIndex + 1}: would close ${toClose} of ${currentSize} @ profit ${floatingPnlPct.toFixed(3)}%`);
    position.lastStepIndex = nextStepIndex;
    return;
  }

  const closed = await closePositionPartially("BTC-USDT-SWAP", toClose.toString());
  if (closed) {
    log(`[TRADE] Step-down #${nextStepIndex + 1}: closed ${closed}/${currentSize} contracts @ profit ${floatingPnlPct.toFixed(3)}%`);
    position.lastStepIndex = nextStepIndex;

    // If no positions left, reset
    const remaining = await getPositions("BTC-USDT-SWAP");
    if (!remaining.length || parseInt(remaining[0].pos) === 0) {
      const pnl = position.entryPrice && lastBtcPrice
        ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice) * CONTRACT_SIZE
        : 0;
      log(`[TRADE] All closed | PnL≈${pnl.toFixed(4)} USD (BTC ${position.entryPrice}→${lastBtcPrice})`);
      position = { ...FLAT_POSITION };
    }
  }
}

// ─── Exit logic ───────────────────────────────────────────────────────────────

async function tryClosePosition(signal: StrategySignal): Promise<boolean> {
  if (position.side === null) return false;

  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const holdDurationMs = position.entryTime ? Date.now() - position.entryTime : 0;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;

  // Floating PnL
  const floatingPnlPct = position.entryPrice && lastBtcPrice
    ? (position.side === "long"
        ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
    : 0;
  const inProfit = floatingPnlPct >= FLOATING_PROFIT_THRESHOLD_PCT;

  // ── P2: Break-even stop — arm once floatingPnl crosses BREAK_EVEN_PCT ──────
  if (!position.breakEvenActivated && floatingPnlPct >= BREAK_EVEN_PCT) {
    position.breakEvenActivated = true;
    position.stopLossPct = 0;  // stop moves to entry price
    log(`[RISK] Break-even stop armed @ entry=${position.entryPrice} (profit=${floatingPnlPct.toFixed(3)}%)`);
  }

  // ── P1: Hard stop-loss ────────────────────────────────────────────────────
  const stopLossHit = floatingPnlPct <= -position.stopLossPct;

  // Regime aligned: trend direction matches our position
  const regimeAligned = (position.side === "long" && signal.regime === "TREND_UP")
                      || (position.side === "short" && signal.regime === "TREND_DOWN");

  // Exit conditions (priority order):
  // 1. Stop-loss hit — always exit immediately
  // 2. Signal reversal — model explicitly calls opposite direction
  // 3. Regime shifted against us — exit
  // 4. Window expired with no continuing signal — exit (avoid naked hold)
  // 5. Max holding time exceeded — safety net
  const regimeShifted = (position.side === "long" && signal.regime === "TREND_DOWN")
                     || (position.side === "short" && signal.regime === "TREND_UP");
  const maxHoldingExceeded = holdDurationMs > MAX_HOLDING_MS;

  // Signal reversal: model explicitly calls the opposite direction
  const signalReversed = (position.side === "long" && signal.direction === "down")
                      || (position.side === "short" && signal.direction === "up");

  // Cross-window: only close at window expiry if signal has gone flat (no direction).
  // If signal continues in the same direction, hold through the new window — avoids
  // paying round-trip fees just to re-open the same position a tick later.
  const windowExpired = remaining <= 0 || remaining < closeBeforeSec;
  const signalContinues = (position.side === "long" && signal.direction === "up")
                       || (position.side === "short" && signal.direction === "down");
  const windowExpiredNoSignal = windowExpired && !signalContinues;

  // Skip exit if max holding exceeded but we're in profit AND regime still aligned — let it ride
  if (maxHoldingExceeded && inProfit && regimeAligned) {
    return false;
  }

  if (!stopLossHit && !windowExpiredNoSignal && !regimeShifted && !signalReversed && !maxHoldingExceeded) {
    return false;
  }

  const exitReason = stopLossHit          ? `stop_loss(${floatingPnlPct.toFixed(3)}%)`
    : signalReversed        ? `signal_reversed(${signal.direction})`
    : windowExpiredNoSignal ? `window_expired(no_signal)`
    : regimeShifted         ? "regime_shift"
    : "max_holding";

  if (!ENABLE_TRADING) {
    log(`[SIM] Would close: reason=${exitReason} remaining=${remaining.toFixed(0)}s holdDuration=${(holdDurationMs/60000).toFixed(1)}m profit=${floatingPnlPct.toFixed(3)}%`);
    return false;
  }

  log(`[TRADE] closeAllPositions — reason=${exitReason} remaining=${remaining.toFixed(0)}s holdDuration=${(holdDurationMs/60000).toFixed(1)}m profit=${floatingPnlPct.toFixed(3)}%`);
  await closeAllPositions("BTC-USDT-SWAP");

  const pnl = position.entryPrice && lastBtcPrice
    ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice) * CONTRACT_SIZE
    : 0;
  log(`[TRADE] Closed ${position.side?.toUpperCase()} | PnL≈${pnl.toFixed(4)} USD (BTC ${position.entryPrice}→${lastBtcPrice})`);

  position = { ...FLAT_POSITION };
  return true;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Strategy runner starting`);
  log(`Window: ${WINDOW_DURATION_MINUTES}min | Interval: ${SIGNAL_INTERVAL_MS}ms | Trading: ${ENABLE_TRADING}`);
  log(`Risk: stop_loss=${STOP_LOSS_PCT}% | break_even=${BREAK_EVEN_PCT}%`);

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

  // Check Kronos service
  const kronosReady = await isKronosReady();
  log(`Kronos service: ${kronosReady ? "OK (ML signals enabled)" : "unavailable (TA-only fallback)"}`);

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
      position.windowEndTimestamp = evalResult.endTimestamp;

      // Log signal every tick
      const dir = signal.direction === "none" ? "—" : signal.direction.toUpperCase();
      const edge = signal.edge >= 0 ? `+${signal.edge.toFixed(3)}` : signal.edge.toFixed(3);
      log(`${dir} | edge=${edge} | conf=${signal.confidence.toFixed(3)} | regime=${signal.regime} | stage=${signal.stage} | ratio=${signal.upPriceRatio.toFixed(3)} | BTC=$${btcPrice}`);

      if (position.side !== null) {
        // Try step-down exits first (lock in partial profits)
        await tryStepDownPosition(signal);
        // Then try to close if in a position
        const closed = await tryClosePosition(signal);
        if (closed) {
          // Position just closed — don't open a new one immediately
        }
      } else {
        // Try to open if flat
        if (signal.direction !== "none") {
          await tryOpenPosition(signal, evalResult.endTimestamp);
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
