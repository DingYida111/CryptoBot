/**
 * Unified strategy runner — Phase 2
 *
 * Two signal sources, one process, one shared position:
 *
 *   1. MAIN signal  : TA (VWAP/RSI/MACD/HA) + Kronos ML + PM price → edge trade
 *   2. CONTRARIAN   : PM extreme (>HIGH or <LOW) → fade the crowd
 *      - blocked when regime is strongly aligned with the crowd
 *      - blocked during extreme volatility (circuit breaker)
 *
 * Priority: contrarian takes over when PM is in extreme zone; otherwise main signal.
 *
 * Usage: npx tsx src/trade/strategy_runner.ts
 */

import {
  getPositions, closeAllPositions, closePositionPartially,
  buyUp, sellDown, getAccountBalance,
} from "./okx_trade.js";
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

const WINDOW_DURATION_MINUTES  = parseInt(process.env.WINDOW_DURATION_MINUTES ?? "15");
const SIGNAL_INTERVAL_MS       = parseInt(process.env.SIGNAL_INTERVAL_MS ?? "10000");
const ENABLE_TRADING           = process.env.ENABLE_TRADING !== "false";
const CLOSE_BEFORE_MINS        = parseFloat(process.env.CLOSE_BEFORE_MINS ?? "0.5");
const MAX_HOLDING_MS           = parseInt(process.env.MAX_HOLDING_MS ?? (25 * 60 * 1000).toString());
const FLOATING_PROFIT_THRESHOLD_PCT = parseFloat(process.env.FLOATING_PROFIT_THRESHOLD_PCT ?? "0.5");

// OKX contract constants
const CONTRACT_SIZE   = 0.01;    // BTC-USDT-SWAP: 1 contract = 0.01 BTC
const TAKER_FEE_RATE  = 0.0005;  // 0.05% per side

// Main strategy risk
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT   ?? "0.3");  // hard stop -0.3%
const BREAK_EVEN_PCT  = parseFloat(process.env.BREAK_EVEN_PCT  ?? "0.1");  // move stop to entry at +0.1%

// Contrarian strategy parameters
const PM_CONTRARIAN_HIGH       = parseFloat(process.env.PM_CONTRARIAN_HIGH ?? "0.75");  // fade extreme bullishness
const PM_CONTRARIAN_LOW        = parseFloat(process.env.PM_CONTRARIAN_LOW  ?? "0.25");  // fade extreme bearishness
const CONTRARIAN_STOP_LOSS_PCT = parseFloat(process.env.CONTRARIAN_STOP_LOSS_PCT ?? "0.4"); // wider stop for contrarian
const CONTRARIAN_BREAK_EVEN_PCT= parseFloat(process.env.CONTRARIAN_BREAK_EVEN_PCT ?? "0.15");
// Circuit breaker: pause contrarian if 5-candle high-low range / price > this threshold
const EXTREME_VOL_THRESHOLD    = parseFloat(process.env.EXTREME_VOL_THRESHOLD ?? "0.003"); // 0.3%

// Entry timing: wait until this fraction of the window has elapsed before entering
const ENTRY_TIME_RATIO_MIN = parseFloat(process.env.ENTRY_TIME_RATIO_MIN ?? "0.2");

// Step-down exit: lock in profits progressively
const STEP_DOWN_LEVELS: { profitPct: number; closeFraction: number }[] = [
  { profitPct: 0.3, closeFraction: 0.25 }, // at +0.3%: close 25% of original
  { profitPct: 0.7, closeFraction: 0.25 }, // at +0.7%: close another 25%
];

// Position sizing
const MAX_POS_SIZE_PCT = parseFloat(process.env.MAX_POS_SIZE_PCT ?? "0.20"); // cap at 20% of balance per trade

// ─── Types ────────────────────────────────────────────────────────────────────

interface PositionState {
  side: "long" | "short" | null;
  entryPrice: number | null;
  entryTime: number | null;
  slug: string | null;
  windowEndTimestamp: number | null;
  orderId: string | null;
  originalSize: number | null;
  lastStepIndex: number;
  stopLossPct: number;
  breakEvenPct: number;
  breakEvenActivated: boolean;
  isContrarian: boolean;  // true = opened via contrarian signal
}

/** A resolved trade decision: which direction, why, and which risk parameters */
interface TradeDecision {
  direction: "up" | "down";
  source: "main" | "contrarian";
  stopLossPct: number;
  breakEvenPct: number;
  reason: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

const FLAT_POSITION: PositionState = {
  side: null, entryPrice: null, entryTime: null, slug: null,
  windowEndTimestamp: null, orderId: null, originalSize: null,
  lastStepIndex: -1, stopLossPct: STOP_LOSS_PCT, breakEvenPct: BREAK_EVEN_PCT,
  breakEvenActivated: false, isContrarian: false,
};

let position: PositionState = { ...FLAT_POSITION };
let lastBtcPrice: number | null = null;
let lastCandles: Candle[] = [];

// Cached balance to avoid hammering OKX on every signal
let cachedBalance: number | null = null;
let lastBalanceTs: number = 0;
const BALANCE_CACHE_MS = 30_000; // refresh every 30s

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Balance helper ───────────────────────────────────────────────────────────

async function fetchBalance(): Promise<number | null> {
  if (cachedBalance !== null && Date.now() - lastBalanceTs < BALANCE_CACHE_MS) {
    return cachedBalance;
  }
  try {
    const balance = await getAccountBalance();
    if (balance?.[0]) {
      const usdtBal = (balance[0] as any).details?.find((d: any) => d.ccy === "USDT");
      const availEq = parseFloat(usdtBal?.availEq ?? (balance[0] as any).totalEq ?? "0");
      cachedBalance = availEq;
      lastBalanceTs = Date.now();
      return availEq;
    }
  } catch (_) { /* ignore */ }
  return null;
}

// ─── Kelly sizing ─────────────────────────────────────────────────────────────

/**
 * Simple return-risk optimal position sizing.
 *
 * reward = expected price move in USD terms
 * risk   = maximum adverse excursion in USD terms (stop-loss distance)
 * kelly  = reward / risk  (capped at 1.0)
 *
 * Final size = min(Kelly fraction, MAX_POS_SIZE_PCT) × balance
 *              expressed in contracts (1 contract = 0.01 BTC)
 */
function calcKellySize(
  rewardUsd: number,   // expected profit if price moves in your direction
  riskUsd: number,      // maximum loss if price moves against you (stop-loss dist)
  balance: number,
  btcPrice: number,
): number {
  if (riskUsd <= 0) return 0;

  const rawKelly = Math.min(rewardUsd / riskUsd, 1.0);        // Kelly fraction
  const cappedKelly = Math.min(rawKelly, MAX_POS_SIZE_PCT);    // apply 20% cap

  const usdBudget = balance * cappedKelly;
  const contracts = Math.max(1, Math.round(usdBudget / (btcPrice * CONTRACT_SIZE)));
  return contracts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Circuit breaker: returns true if recent price action is too volatile for
 * contrarian bets. Uses 5-candle high-low range as a % of current price.
 */
function isExtremeVolatility(candles: Candle[], btcPrice: number): boolean {
  const last5 = candles.slice(-5);
  if (last5.length < 3) return false;
  const high  = Math.max(...last5.map(c => c.high));
  const low   = Math.min(...last5.map(c => c.low));
  const rangePct = (high - low) / btcPrice;
  return rangePct > EXTREME_VOL_THRESHOLD;
}

/**
 * Compute trade decision based on both signal sources.
 *
 * Contrarian takes priority when PM is in extreme zone — but is blocked by:
 *   - Strong trend aligned with crowd (regime guard)
 *   - Extreme volatility (circuit breaker)
 *
 * Falls back to main TA/Kronos signal otherwise.
 */
function makeTradeDecision(
  signal: StrategySignal,
  upBid: number,
  candles: Candle[],
): TradeDecision | null {
  const btcRef = lastBtcPrice ?? 76000;

  // ── Contrarian zone ────────────────────────────────────────────────────────
  if (upBid > PM_CONTRARIAN_HIGH) {
    // Crowd is extremely bullish → fade with SHORT
    if (signal.regime === "TREND_UP") {
      log(`[CONTRA] Blocked short: regime=TREND_UP | PM=${upBid.toFixed(3)}`);
    } else if (isExtremeVolatility(candles, btcRef)) {
      log(`[CONTRA] Blocked short: extreme volatility | PM=${upBid.toFixed(3)}`);
    } else {
      return {
        direction: "down",
        source: "contrarian",
        stopLossPct: CONTRARIAN_STOP_LOSS_PCT,
        breakEvenPct: CONTRARIAN_BREAK_EVEN_PCT,
        reason: `contrarian_short|PM=${upBid.toFixed(3)}|regime=${signal.regime}`,
      };
    }
    return null;
  }

  if (upBid < PM_CONTRARIAN_LOW) {
    // Crowd is extremely bearish → fade with LONG
    if (signal.regime === "TREND_DOWN") {
      log(`[CONTRA] Blocked long: regime=TREND_DOWN | PM=${upBid.toFixed(3)}`);
    } else if (isExtremeVolatility(candles, btcRef)) {
      log(`[CONTRA] Blocked long: extreme volatility | PM=${upBid.toFixed(3)}`);
    } else {
      return {
        direction: "up",
        source: "contrarian",
        stopLossPct: CONTRARIAN_STOP_LOSS_PCT,
        breakEvenPct: CONTRARIAN_BREAK_EVEN_PCT,
        reason: `contrarian_long|PM=${upBid.toFixed(3)}|regime=${signal.regime}`,
      };
    }
    return null;
  }

  // ── Main signal zone ───────────────────────────────────────────────────────
  if (signal.direction === "none") return null;

  return {
    direction: signal.direction as "up" | "down",
    source: "main",
    stopLossPct: STOP_LOSS_PCT,
    breakEvenPct: BREAK_EVEN_PCT,
    reason: signal.reason,
  };
}

// ─── Position sync ────────────────────────────────────────────────────────────

async function syncPosition(): Promise<void> {
  const positions = await getPositions("BTC-USDT-SWAP");
  const activePositions = positions.filter(p => parseInt(p.pos) !== 0);
  if (!activePositions.length) {
    if (position.side !== null) log(`[POS] Flat — no open positions on OKX`);
    position = { ...FLAT_POSITION };
    return;
  }

  const pos = activePositions[0];
  const side = pos.posSide === "short" ? "short" : "long";
  const avgPx = parseFloat(pos.avgPx);
  const sz = parseFloat(pos.pos);

  if (position.side !== side || position.entryPrice !== avgPx) {
    log(`[POS] Synced: ${side.toUpperCase()} | avgPx=${avgPx} | sz=${sz} | unrealized=${pos.upl}`);
    position.side = side;
    position.entryPrice = avgPx;
    position.entryTime = Date.now();
    position.orderId = null;
    position.windowEndTimestamp = null;
    position.originalSize = sz;
    position.lastStepIndex = -1;
    position.breakEvenActivated = false;
  }
}

// ─── Evaluate signal ─────────────────────────────────────────────────────────

async function evaluateSignal() {
  const btcPrice = await fetchBtcPrice();
  if (!btcPrice) { log(`[WARN] No BTC price`); return null; }
  lastBtcPrice = btcPrice;

  const candles = await fetchOkxKlines("15m", 60);
  if (candles.length > 0) {
    lastCandles = candles.map(okxToBinanceCandle);
  }

  const pmResult = await pollPolymarket("btc", WINDOW_DURATION_MINUTES); const upBid = pmResult?.upBid ?? 0.5;
  const kronosResult = await getKronosProb(lastCandles);
  

  if (kronosResult) {
    log(`[Kronos] prob_up=${kronosResult.probUp.toFixed(3)} delta=${kronosResult.deltaPercent.toFixed(4)}% latency=${kronosResult.latencyMs}ms`);
  }

  const signal = scoreStrategy(lastCandles, upBid, Date.now() + WINDOW_DURATION_MINUTES * 60 * 1000, {
    ...DEFAULT_SCORING_CONFIG,
  }, WINDOW_DURATION_MINUTES * 60, kronosResult !== null ? kronosResult.probUp : null);

  return { signal, btcPrice, upBid, endTimestamp: Date.now() + WINDOW_DURATION_MINUTES * 60 * 1000 };
}

// ─── Entry logic ──────────────────────────────────────────────────────────────

async function tryOpenPosition(decision: TradeDecision, signalEdge: number, endTimestamp: number): Promise<boolean> {
  // Entry timing guard: wait until enough of the window has elapsed
  const timeRatio = calcTimeRatio(endTimestamp, WINDOW_DURATION_MINUTES * 60);
  if (timeRatio < ENTRY_TIME_RATIO_MIN) {
    return false;
  }

  const btcRef = lastBtcPrice ?? 76000;

  // ── EV gate (main signal only) ─────────────────────────────────────────────
  if (decision.source === "main") {
    const feeRoundTrip = btcRef * CONTRACT_SIZE * TAKER_FEE_RATE * 2;

    const last15 = lastCandles.slice(-15);
    const range15min = last15.length >= 5
      ? Math.max(...last15.map(c => c.high)) - Math.min(...last15.map(c => c.low))
      : btcRef * 0.002;

    // Fixed EV: directionalEdge × range × BTC_price × CONTRACT_SIZE = USD expected profit
    const directionalEdge = Math.abs(signalEdge);
    const expectedProfit = directionalEdge * range15min * btcRef * CONTRACT_SIZE;

    if (expectedProfit < feeRoundTrip) {
      log(`[SKIP] EV≈${expectedProfit.toFixed(2)} < fee=${feeRoundTrip.toFixed(2)} | range=${range15min.toFixed(0)} | edge=${directionalEdge.toFixed(3)}`);
      return false;
    }
  }

  if (position.side !== null) {
    log(`[POS] Already ${position.side}, skipping open`);
    return false;
  }

  if (!ENABLE_TRADING) {
    log(`[SIM] Would open ${decision.direction.toUpperCase()} [${decision.source}] | ${decision.reason}`);
    return false;
  }

  // ── Dynamic position sizing ────────────────────────────────────────────────
  const balance = await fetchBalance();
  const stopLossPct = decision.stopLossPct;

  // reward: expected move = edge × range (in BTC terms) × price = USD
  const last15 = lastCandles.slice(-15);
  const range15min = last15.length >= 5
    ? Math.max(...last15.map(c => c.high)) - Math.min(...last15.map(c => c.low))
    : btcRef * 0.002;
  const rewardUsd = Math.abs(signalEdge) * range15min * btcRef;

  // risk: stop-loss distance × position size = USD loss per contract
  const riskPerContract = stopLossPct / 100 * btcRef * CONTRACT_SIZE;

  const size = balance !== null && balance > 0
    ? calcKellySize(rewardUsd, riskPerContract, balance, btcRef)
    : 1;

  const sizeStr = String(Math.min(size, 100)); // hard ceiling at 100 contracts for safety

  let result = null;

  if (decision.direction === "up") {
    log(`[TRADE] buyUp [${decision.source}] | ${decision.reason} | size=${sizeStr} | bal=${balance !== null ? balance.toFixed(0) : "N/A"} USDT`);
    result = await buyUp("BTC-USDT-SWAP", sizeStr);
  } else {
    log(`[TRADE] sellDown [${decision.source}] | ${decision.reason} | size=${sizeStr} | bal=${balance !== null ? balance.toFixed(0) : "N/A"} USDT`);
    result = await sellDown("BTC-USDT-SWAP", sizeStr);
  }

  if (result?.sCode === "0") {
    position = {
      side: decision.direction === "up" ? "long" : "short",
      entryPrice: lastBtcPrice,
      entryTime: Date.now(),
      slug: null,
      windowEndTimestamp: endTimestamp,
      orderId: result.ordId,
      originalSize: size,
      lastStepIndex: -1,
      stopLossPct: decision.stopLossPct,
      breakEvenPct: decision.breakEvenPct,
      breakEvenActivated: false,
      isContrarian: decision.source === "contrarian",
    };
    log(`[TRADE] Opened ${position.side!.toUpperCase()} | ordId=${result.ordId} | BTC≈${lastBtcPrice} | size=${size} contracts | stop=${decision.stopLossPct}% [${decision.source}]`);
    return true;
  }

  log(`[WARN] Order failed: ${JSON.stringify(result)}`);
  return false;
}

// ─── Step-down exit ───────────────────────────────────────────────────────────

async function tryStepDownPosition(): Promise<void> {
  if (position.side === null || position.originalSize === null) return;

  const floatingPnlPct = position.entryPrice && lastBtcPrice
    ? (position.side === "long"
        ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
    : 0;

  const nextStepIndex = position.lastStepIndex + 1;
  if (nextStepIndex >= STEP_DOWN_LEVELS.length) return;

  const nextStep = STEP_DOWN_LEVELS[nextStepIndex];
  if (floatingPnlPct < nextStep.profitPct) return;

  const closeFrac = nextStep.closeFraction;
  const closeSz = Math.max(1, Math.round(position.originalSize * closeFrac));
  log(`[EXIT] Step-down ${(closeFrac * 100).toFixed(0)}% (${closeSz} contracts) at +${floatingPnlPct.toFixed(2)}% [${position.isContrarian ? "contrarian" : "main"}]`);
  await closePositionPartially("BTC-USDT-SWAP", String(closeSz));
  position.lastStepIndex = nextStepIndex;
}

// ─── Close logic ──────────────────────────────────────────────────────────────

async function tryClosePosition(signal: StrategySignal): Promise<void> {
  if (position.side === null || position.entryPrice === null || position.originalSize === null) return;

  const btcRef = lastBtcPrice ?? 76000;
  const elapsedMs = Date.now() - (position.entryTime ?? 0);
  const pnlPct = position.side === "long"
    ? (btcRef - position.entryPrice) / position.entryPrice * 100
    : (position.entryPrice - btcRef) / position.entryPrice * 100;

  // ── Time-based close ────────────────────────────────────────────────────────
  const windowEndTs = position.windowEndTimestamp ?? 0;
  const remainingMins = (windowEndTs - Date.now()) / 60000;
  if (remainingMins <= CLOSE_BEFORE_MINS && position.side !== null) {
    log(`[EXIT] window_near_end (${remainingMins.toFixed(1)}m left) | pnl=${pnlPct.toFixed(2)}% | closing`);
    await closeAllPositions("BTC-USDT-SWAP");
    position = { ...FLAT_POSITION };
    return;
  }

  // ── Max holding close ───────────────────────────────────────────────────────
  if (elapsedMs >= MAX_HOLDING_MS) {
    log(`[EXIT] max_holding (${(elapsedMs / 60000).toFixed(1)}m) | pnl=${pnlPct.toFixed(2)}% | closing`);
    await closeAllPositions("BTC-USDT-SWAP");
    position = { ...FLAT_POSITION };
    return;
  }

  // ── Stop-loss ──────────────────────────────────────────────────────────────
  const stopTriggered = position.side === "long"
    ? btcRef <= position.entryPrice * (1 - position.stopLossPct / 100)
    : btcRef >= position.entryPrice * (1 + position.stopLossPct / 100);

  if (stopTriggered) {
    log(`[EXIT] stop_loss | pnl=${pnlPct.toFixed(2)}% | hit=${position.stopLossPct}% [${position.isContrarian ? "contrarian" : "main"}]`);
    await closeAllPositions("BTC-USDT-SWAP");
    position = { ...FLAT_POSITION };
    return;
  }

  // ── Break-even ──────────────────────────────────────────────────────────────
  if (!position.breakEvenActivated && pnlPct >= position.breakEvenPct) {
    position.breakEvenActivated = true;
    position.stopLossPct = 0; // lock in profit
    log(`[RISK] Break-even activated at ${pnlPct.toFixed(2)}% [${position.isContrarian ? "contrarian" : "main"}]`);
  }

  // ── Regime-aligned exit (contrarian only) ───────────────────────────────────
  if (position.isContrarian) {
    const regime = signal.regime;
    const pm = signal.confidence; // upBid proxy
    const shouldExit =
      (position.side === "long" && regime === "TREND_DOWN") ||
      (position.side === "short" && regime === "TREND_UP");
    if (shouldExit) {
      log(`[EXIT] regime_shift | pnl=${pnlPct.toFixed(2)}% | regime=${regime} | closing contrarian`);
      await closeAllPositions("BTC-USDT-SWAP");
      position = { ...FLAT_POSITION };
    }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Strategy runner starting (unified: main + contrarian)`);
  log(`Window: ${WINDOW_DURATION_MINUTES}min | Interval: ${SIGNAL_INTERVAL_MS}ms | Trading: ${ENABLE_TRADING}`);
  log(`Risk main: stop=${STOP_LOSS_PCT}% | break_even=${BREAK_EVEN_PCT}%`);
  log(`Risk contrarian: stop=${CONTRARIAN_STOP_LOSS_PCT}% | break_even=${CONTRARIAN_BREAK_EVEN_PCT}% | PM_H=${PM_CONTRARIAN_HIGH} | PM_L=${PM_CONTRARIAN_LOW} | vol_threshold=${EXTREME_VOL_THRESHOLD}`);
  log(`Sizing: MAX_POS_SIZE_PCT=${(MAX_POS_SIZE_PCT * 100).toFixed(0)}% | Kelly formula`);

  await syncPosition();

  const balance = await fetchBalance();
  if (balance !== null) {
    log(`Balance: availEq=${balance.toFixed(0)} USDT`);
  } else {
    log(`WARNING: Could not fetch OKX balance — using size=1`);
  }

  const kronosReady = await isKronosReady();
  log(`Kronos service: ${kronosReady ? "OK (ML signals enabled)" : "unavailable (TA-only fallback)"}`);
  log(`Starting signal loop...`);

  while (true) {
    try {
      await syncPosition();

      const evalResult = await evaluateSignal();
      if (!evalResult) {
        await sleep(SIGNAL_INTERVAL_MS);
        continue;
      }

      const { signal, btcPrice, upBid, endTimestamp } = evalResult;
      position.windowEndTimestamp = endTimestamp;

      // ── Status log ──────────────────────────────────────────────────────────
      const dir  = signal.direction === "none" ? "—" : signal.direction.toUpperCase();
      const edge = signal.edge >= 0 ? `+${signal.edge.toFixed(3)}` : signal.edge.toFixed(3);
      const pmTag = upBid > PM_CONTRARIAN_HIGH ? " ⚡CONTRA_SHORT"
        : upBid < PM_CONTRARIAN_LOW  ? " ⚡CONTRA_LONG"
        : "";
      log(`${dir} | edge=${edge} | conf=${signal.confidence.toFixed(3)} | PM=${upBid.toFixed(3)}${pmTag} | regime=${signal.regime} | BTC=$${btcPrice}`);

      // ── Position management ─────────────────────────────────────────────────
      if (position.side !== null) {
        await tryStepDownPosition();
        await tryClosePosition(signal);
      } else {
        const decision = makeTradeDecision(signal, upBid, lastCandles);
        if (decision) {
          await tryOpenPosition(decision, signal.edge, endTimestamp);
        }
      }

    } catch (err) {
      log(`ERROR: ${err}`);
    }

    await sleep(SIGNAL_INTERVAL_MS);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  log(`Shutting down...`);
  if (position.side !== null) {
    log(`Closing open position before exit...`);
    await closeAllPositions("BTC-USDT-SWAP");
  }
  process.exit(0);
});

main().catch(err => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
