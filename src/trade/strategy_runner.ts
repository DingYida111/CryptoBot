/**
 * Phase 2: Strategy-driven trading runner
 *
 * Reads current position state, evaluates signals, manages entries/exits.
 * Run as a separate process alongside the collector.
 *
 * Usage: npx tsx src/trade/strategy_runner.ts
 */

import {
  getPositions,
  closeAllPositions,
  closePositionPartially,
  buyUp,
  sellDown,
  getAccountBalance,
} from "./okx_trade.js";
import { scoreStrategy, DEFAULT_SCORING_CONFIG } from "../strategy/scoring.js";
import { getKronosProb, isKronosReady } from "../strategy/kronos.js";
import { fetchOkxKlines, okxToBinanceCandle } from "../monitor/okx_klines.js";
import { fetchBtcPrice } from "../monitor/okx.js";
import { pollPolymarket } from "../monitor/polymarket.js";
import { config as dotenvConfig } from "dotenv";
import { APP_CONFIG, getStartupRiskSummary } from "../config.js";
import type { StrategySignal } from "../types.js";
import type { Candle } from "../monitor/binance.js";

dotenvConfig();

const WINDOW_DURATION_MINUTES = APP_CONFIG.windowDurationMinutes;
const SIGNAL_INTERVAL_MS = APP_CONFIG.signalIntervalMs;
const MAX_POSITION_SIZE = APP_CONFIG.maxPositionSize;
const ENABLE_TRADING = APP_CONFIG.enableTrading;
const CLOSE_BEFORE_MINS = APP_CONFIG.closeBeforeMins;
const MAX_HOLDING_MS = APP_CONFIG.maxHoldingMs;
const REGIME_MODE = APP_CONFIG.regimeMode;
const MIN_REGIME_SCORE = APP_CONFIG.minRegimeScore;
const TREND_WIDTH_MIN_PCT = APP_CONFIG.trendWidthMinPct;
const CHOP_WIDTH_MAX_PCT = APP_CONFIG.chopWidthMaxPct;

const CONTRACT_SIZE = 0.01;
const TAKER_FEE_RATE = 0.0005;
const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT ?? "0.3");
const BREAK_EVEN_PCT = parseFloat(process.env.BREAK_EVEN_PCT ?? "0.1");
const PM_CONTRARIAN_HIGH = parseFloat(process.env.PM_CONTRARIAN_HIGH ?? "0.75");
const PM_CONTRARIAN_LOW = parseFloat(process.env.PM_CONTRARIAN_LOW ?? "0.25");
const CONTRARIAN_STOP_LOSS_PCT = parseFloat(process.env.CONTRARIAN_STOP_LOSS_PCT ?? "0.4");
const CONTRARIAN_BREAK_EVEN_PCT = parseFloat(process.env.CONTRARIAN_BREAK_EVEN_PCT ?? "0.15");
const EXTREME_VOL_THRESHOLD = parseFloat(process.env.EXTREME_VOL_THRESHOLD ?? "0.003");
const MAX_POS_SIZE_PCT = parseFloat(process.env.MAX_POS_SIZE_PCT ?? "0.20");
const ENTRY_TIME_RATIO_MIN = parseFloat(process.env.ENTRY_TIME_RATIO_MIN ?? "0.2");

const STEP_DOWN_LEVELS: { profitPct: number; closeFraction: number }[] = [
  { profitPct: 1.0, closeFraction: 0.25 },
  { profitPct: 2.0, closeFraction: 0.25 },
];

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
  isContrarian: boolean;
  regimeSnapshot: StrategySignal["regimeSnapshot"] | null;
}

interface TradeDecision {
  direction: "up" | "down";
  source: "main" | "contrarian";
  stopLossPct: number;
  breakEvenPct: number;
  reason: string;
}

const FLAT_POSITION: PositionState = {
  side: null,
  entryPrice: null,
  entryTime: null,
  slug: null,
  windowEndTimestamp: null,
  orderId: null,
  originalSize: null,
  lastStepIndex: -1,
  stopLossPct: STOP_LOSS_PCT,
  breakEvenPct: BREAK_EVEN_PCT,
  breakEvenActivated: false,
  isContrarian: false,
  regimeSnapshot: null,
};

let position: PositionState = { ...FLAT_POSITION };
let lastBtcPrice: number | null = null;
let lastCandles: Candle[] = [];
let lastSignal: StrategySignal | null = null;
let cachedBalance: number | null = null;
let lastBalanceTs = 0;
const BALANCE_CACHE_MS = 30_000;

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetPosition(): void {
  position = { ...FLAT_POSITION };
}

function regimeMaxHoldingMs(signal: StrategySignal | null): number {
  if (!signal) return MAX_HOLDING_MS;
  if (signal.profile === "TREND_FOLLOW" || signal.regime === "TREND_UP" || signal.regime === "TREND_DOWN") {
    return Math.max(MAX_HOLDING_MS, WINDOW_DURATION_MINUTES * 60 * 1000);
  }
  return Math.min(MAX_HOLDING_MS, WINDOW_DURATION_MINUTES * 30 * 1000);
}

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
  } catch {
    /* ignore */
  }
  return null;
}

function calcKellySize(rewardUsd: number, riskUsd: number, balance: number, btcPrice: number): number {
  if (riskUsd <= 0) return 0;
  const rawKelly = Math.min(rewardUsd / riskUsd, 1.0);
  const cappedKelly = Math.min(rawKelly, MAX_POS_SIZE_PCT);
  const usdBudget = balance * cappedKelly;
  return Math.max(1, Math.round(usdBudget / (btcPrice * CONTRACT_SIZE)));
}

function isExtremeVolatility(candles: Candle[], btcPrice: number): boolean {
  const last5 = candles.slice(-5);
  if (last5.length < 3) return false;
  const high = Math.max(...last5.map((c) => c.high));
  const low = Math.min(...last5.map((c) => c.low));
  return (high - low) / btcPrice > EXTREME_VOL_THRESHOLD;
}

function makeTradeDecision(signal: StrategySignal, upBid: number, candles: Candle[]): TradeDecision | null {
  const btcRef = lastBtcPrice ?? 76000;

  if (upBid > PM_CONTRARIAN_HIGH) {
    if (signal.regime === "TREND_UP" || isExtremeVolatility(candles, btcRef)) {
      return null;
    }
    return {
      direction: "down",
      source: "contrarian",
      stopLossPct: CONTRARIAN_STOP_LOSS_PCT,
      breakEvenPct: CONTRARIAN_BREAK_EVEN_PCT,
      reason: `contrarian_short|PM=${upBid.toFixed(3)}|regime=${signal.regime}`,
    };
  }

  if (upBid < PM_CONTRARIAN_LOW) {
    if (signal.regime === "TREND_DOWN" || isExtremeVolatility(candles, btcRef)) {
      return null;
    }
    return {
      direction: "up",
      source: "contrarian",
      stopLossPct: CONTRARIAN_STOP_LOSS_PCT,
      breakEvenPct: CONTRARIAN_BREAK_EVEN_PCT,
      reason: `contrarian_long|PM=${upBid.toFixed(3)}|regime=${signal.regime}`,
    };
  }

  if (signal.direction === "none") return null;
  return {
    direction: signal.direction,
    source: "main",
    stopLossPct: STOP_LOSS_PCT,
    breakEvenPct: BREAK_EVEN_PCT,
    reason: signal.reason,
  };
}

async function syncPosition(): Promise<void> {
  const positions = await getPositions("BTC-USDT-SWAP");
  const activePositions = positions.filter((p) => parseInt(p.pos) !== 0);
  if (!activePositions.length) {
    if (position.side !== null) log(`[POS] Flat — no open positions on OKX`);
    resetPosition();
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
    position.originalSize = sz;
    position.lastStepIndex = -1;
    position.breakEvenActivated = false;
  }
}

async function evaluateSignal(): Promise<{ signal: StrategySignal; btcPrice: number; upBid: number; endTimestamp: number } | null> {
  const pollResult = await pollPolymarket("btc", WINDOW_DURATION_MINUTES);
  if (!pollResult || pollResult.marketClosed) return null;

  const { endTimestamp, upBid, downBid } = pollResult;
  if (upBid === null || downBid === null) return null;

  const btcPrice = await fetchBtcPrice();
  if (btcPrice === null) return null;
  lastBtcPrice = btcPrice;

  const barLimit = WINDOW_DURATION_MINUTES <= 15 ? "1m" : "5m";
  const klines = await fetchOkxKlines(barLimit, 60).catch(() => []);
  const candles = klines.map(okxToBinanceCandle);
  lastCandles = candles;

  const kronosResult = await getKronosProb(lastCandles);
  if (kronosResult) {
    log(`[Kronos] prob_up=${kronosResult.probUp.toFixed(3)} delta=${kronosResult.deltaPercent.toFixed(4)}% latency=${kronosResult.latencyMs}ms`);
  }

  const signal = scoreStrategy(
    candles,
    upBid,
    endTimestamp,
    {
      ...DEFAULT_SCORING_CONFIG,
      regimeMode: REGIME_MODE,
      minRegimeScore: MIN_REGIME_SCORE,
      trendWidthMinPct: TREND_WIDTH_MIN_PCT,
      chopWidthMaxPct: CHOP_WIDTH_MAX_PCT,
    },
    WINDOW_DURATION_MINUTES * 60,
    kronosResult !== null ? kronosResult.probUp : null,
  );

  return { signal, btcPrice, upBid, endTimestamp };
}

async function tryOpenPosition(
  decision: TradeDecision,
  signal: StrategySignal,
  endTimestamp: number
): Promise<boolean> {
  if (!ENABLE_TRADING) {
    log(`[SIM] Would open: ${decision.direction} source=${decision.source} reason=${decision.reason}`);
    return false;
  }

  if (position.side !== null) {
    log(`[POS] Already ${position.side}, skipping open`);
    return false;
  }

  const btcRef = lastBtcPrice ?? 76000;
  const balance = await fetchBalance();
  const stopLossPct = decision.stopLossPct;
  const breakEvenPct = decision.breakEvenPct;

  const last15 = lastCandles.slice(-15);
  const range15min = last15.length >= 5 ? Math.max(...last15.map((c) => c.high)) - Math.min(...last15.map((c) => c.low)) : btcRef * 0.002;
  const rewardUsd = Math.abs(signal.edge) * range15min * btcRef;
  const riskPerContract = stopLossPct / 100 * btcRef * CONTRACT_SIZE;
  const size = balance !== null && balance > 0 ? calcKellySize(rewardUsd, riskPerContract, balance, btcRef) : 1;
  const sizeStr = String(Math.min(size, 100));

  let result = null;
  if (decision.direction === "up") {
    log(`[TRADE] buyUp | source=${decision.source} | ${decision.reason}`);
    result = await buyUp("BTC-USDT-SWAP", sizeStr);
  } else if (decision.direction === "down") {
    log(`[TRADE] sellDown | source=${decision.source} | ${decision.reason}`);
    result = await sellDown("BTC-USDT-SWAP", sizeStr);
  }

  if (result?.sCode === "0") {
    const openedSide = decision.direction === "up" ? "LONG" : "SHORT";
    position = {
      side: decision.direction === "up" ? "long" : "short",
      entryPrice: lastBtcPrice,
      entryTime: Date.now(),
      slug: null,
      windowEndTimestamp: endTimestamp,
      orderId: result.ordId,
      originalSize: size,
      lastStepIndex: -1,
      stopLossPct,
      breakEvenPct,
      breakEvenActivated: false,
      isContrarian: decision.source === "contrarian",
      regimeSnapshot: signal.regimeSnapshot ?? signal.regime,
    };
    log(`[TRADE] Opened ${openedSide} | ordId=${result.ordId} | BTC≈${lastBtcPrice} | size=${sizeStr} contracts`);
    return true;
  }

  log(`[WARN] Order failed: ${JSON.stringify(result)}`);
  return false;
}

async function tryStepDownPosition(signal: StrategySignal): Promise<void> {
  if (position.side === null || position.originalSize === null) return;
  if (signal.profile === "MEAN_REVERT") return;

  const floatingPnlPct = position.entryPrice && lastBtcPrice
    ? (position.side === "long"
      ? (lastBtcPrice - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - lastBtcPrice) / position.entryPrice * 100)
    : 0;

  const hardStopLossPct = position.regimeSnapshot === "CHOP" || position.regimeSnapshot === "RANGE" ? -1.0 : -1.5;
  if (floatingPnlPct <= hardStopLossPct) {
    if (!ENABLE_TRADING) {
      log(`[SIM] Hard stop triggered: pnl=${floatingPnlPct.toFixed(3)}% regime=${position.regimeSnapshot ?? "n/a"}`);
      return;
    }
    log(`[TRADE] Hard stop triggered: pnl=${floatingPnlPct.toFixed(3)}% regime=${position.regimeSnapshot ?? "n/a"}`);
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  const nextStepIndex = position.lastStepIndex + 1;
  if (nextStepIndex >= STEP_DOWN_LEVELS.length) return;

  const nextStep = STEP_DOWN_LEVELS[nextStepIndex];
  if (floatingPnlPct < nextStep.profitPct) return;

  const positions = await getPositions("BTC-USDT-SWAP");
  const pos = positions[0];
  if (!pos || parseInt(pos.pos) === 0) return;

  const currentSize = parseInt(pos.pos);
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
    const remaining = await getPositions("BTC-USDT-SWAP");
    if (!remaining.length || parseInt(remaining[0].pos) === 0) {
      const pnl = position.entryPrice && lastBtcPrice
        ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice)
        : 0;
      log(`[TRADE] All closed | PnL≈${pnl.toFixed(2)} (BTC ${position.entryPrice}→${lastBtcPrice})`);
      resetPosition();
    }
  }
}

async function tryClosePosition(signal: StrategySignal): Promise<void> {
  if (position.side === null || position.entryPrice === null || position.originalSize === null) return;

  const btcRef = lastBtcPrice ?? 76000;
  const elapsedMs = Date.now() - (position.entryTime ?? 0);
  const pnlPct = position.side === "long"
    ? (btcRef - position.entryPrice) / position.entryPrice * 100
    : (position.entryPrice - btcRef) / position.entryPrice * 100;

  const nowSec = Date.now() / 1000;
  const windowEndTsSec = position.windowEndTimestamp ?? 0;
  const remainingSec = windowEndTsSec - nowSec;
  const remainingMins = remainingSec / 60;
  if (remainingSec > 0 && remainingMins <= CLOSE_BEFORE_MINS && position.side !== null) {
    log(`[EXIT] window_near_end (${remainingMins.toFixed(1)}m left) | pnl=${pnlPct.toFixed(2)}% | closing`);
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  if (elapsedMs >= MAX_HOLDING_MS) {
    log(`[EXIT] max_holding (${(elapsedMs / 60000).toFixed(1)}m) | pnl=${pnlPct.toFixed(2)}% | closing`);
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  const stopTriggered = position.side === "long"
    ? btcRef <= position.entryPrice * (1 - position.stopLossPct / 100)
    : btcRef >= position.entryPrice * (1 + position.stopLossPct / 100);
  if (stopTriggered) {
    log(`[EXIT] stop_loss | pnl=${pnlPct.toFixed(2)}% | hit=${position.stopLossPct}% [${position.isContrarian ? "contrarian" : "main"}]`);
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  if (!position.breakEvenActivated && pnlPct >= position.breakEvenPct) {
    position.breakEvenActivated = true;
    position.stopLossPct = 0;
    log(`[RISK] Break-even activated at ${pnlPct.toFixed(2)}% [${position.isContrarian ? "contrarian" : "main"}]`);
  }

  if (position.isContrarian) {
    const regime = signal.regime;
    const shouldExit =
      (position.side === "long" && regime === "TREND_DOWN") ||
      (position.side === "short" && regime === "TREND_UP");
    if (shouldExit) {
      log(`[EXIT] regime_shift | pnl=${pnlPct.toFixed(2)}% | regime=${regime} | closing contrarian`);
      await closeAllPositions("BTC-USDT-SWAP");
      resetPosition();
      return;
    }
  }
}

async function tryClosePositionNoSignal(): Promise<boolean> {
  if (position.side === null) return false;

  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const holdDurationMs = position.entryTime ? Date.now() - position.entryTime : 0;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;
  const windowClosingSoon = remaining < closeBeforeSec && remaining > 0;
  const maxHoldingExceeded = holdDurationMs > regimeMaxHoldingMs(lastSignal);

  if (!windowClosingSoon && !maxHoldingExceeded) return false;

  const reason = windowClosingSoon ? "window_closing_no_signal" : "max_holding_no_signal";
  if (!ENABLE_TRADING) {
    log(`[SIM] Would close without signal: reason=${reason}`);
    return false;
  }

  log(`[TRADE] closeAllPositions — reason=${reason}`);
  await closeAllPositions("BTC-USDT-SWAP");
  resetPosition();
  return true;
}

async function main(): Promise<void> {
  log(`Strategy runner starting (main + contrarian)`);
  log(`Window: ${WINDOW_DURATION_MINUTES}min | Interval: ${SIGNAL_INTERVAL_MS}ms | Trading: ${ENABLE_TRADING}`);
  log(`Config: ${getStartupRiskSummary().join(" | ")}`);
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
        await tryClosePositionNoSignal();
        await sleep(SIGNAL_INTERVAL_MS);
        continue;
      }

      const { signal, btcPrice, upBid, endTimestamp } = evalResult;
      lastSignal = signal;
      position.windowEndTimestamp = endTimestamp;

      const dir = signal.direction === "none" ? "—" : signal.direction.toUpperCase();
      const edge = signal.edge >= 0 ? `+${signal.edge.toFixed(3)}` : signal.edge.toFixed(3);
      log(`${dir} | edge=${edge} | conf=${signal.confidence.toFixed(3)} | regime=${signal.regime} | stage=${signal.stage} | profile=${signal.profile ?? "FILTERED"} | BTC=$${btcPrice}`);
      if (signal.regimeScore !== undefined) {
        log(`[REGIME] score=${signal.regimeScore.toFixed(2)} reason=${signal.regimeReason ?? "n/a"} mode=${REGIME_MODE}`);
      }

      if (position.side !== null) {
        await tryStepDownPosition(signal);
        await tryClosePosition(signal);
      } else {
        const decision = makeTradeDecision(signal, upBid, lastCandles);
        if (decision) {
          log(`[DECISION] ${decision.source} | ${decision.reason}`);
          await tryOpenPosition(decision, signal, endTimestamp);
        }
      }
    } catch (err) {
      log(`ERROR: ${err}`);
    }

    await sleep(SIGNAL_INTERVAL_MS);
  }
}

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
