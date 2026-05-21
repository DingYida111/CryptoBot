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
import type { Position as OkxPosition } from "./okx_trade.js";
import { getChopGridSnapshot, getChopGridStats, maybeRunChopGrid, primeChopGridPosition } from "./chop_grid.js";
import { logTradeEvent } from "./trade_logger.js";
import { scoreStrategy, DEFAULT_SCORING_CONFIG } from "../strategy/scoring.js";
import { getKronosProb, isKronosReady } from "../strategy/kronos.js";
import { fetchOkxKlines, okxToBinanceCandle } from "../monitor/okx_klines.js";
import { fetchBtcPrice, fetchBtcSwapMeta } from "../monitor/okx.js";
import { pollPolymarket } from "../monitor/polymarket.js";
import { config as dotenvConfig } from "dotenv";
import { APP_CONFIG, getStartupRiskSummary } from "../config.js";
import type { StrategySignal } from "../types.js";
import type { Candle } from "../monitor/binance.js";
import { insertPortfolioResidual, insertPortfolioShadowLog, insertPortfolioSnapshot } from "../monitor/storage.js";
import { chopGridMetadata } from "../portfolio/adapters/chop_grid_adapter.js";
import { buildPortfolioStateFromRunner, okxPositionsToInstrumentPositions } from "../portfolio/adapters/strategy_runner_adapter.js";
import { STRATEGY_BASIS_SPECS, decomposeTradeIncrement } from "../portfolio/basis.js";
import { computeExposure, toInstrumentSpecMap } from "../portfolio/exposure.js";
import { buildBtcSwapInstrumentSpecFromMeta, OKX_BTC_USDT_SWAP } from "../portfolio/instrument_spec.js";
import { buildOptimizationRequest } from "../portfolio/optimizer_request.js";
import { runOptimizerStub } from "../portfolio/optimizer_stub.js";
import type { DecisionIntent } from "../portfolio/portfolio_types.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX } from "../portfolio/security_spec.js";
import { buildResidualPosition } from "../portfolio/residual.js";
import { PORTFOLIO_SHADOW_VERSION } from "../portfolio/version.js";

dotenvConfig();

const WINDOW_DURATION_MINUTES = APP_CONFIG.windowDurationMinutes;
const SIGNAL_INTERVAL_MS = APP_CONFIG.signalIntervalMs;
const MAX_POSITION_SIZE = APP_CONFIG.maxPositionSize;
const ENABLE_TRADING = APP_CONFIG.enableTrading;
const CLOSE_BEFORE_MINS = APP_CONFIG.closeBeforeMins;
const MAX_HOLDING_MS = APP_CONFIG.maxHoldingMs;
const CHOP_GRID_CONFIG = {
  layers: APP_CONFIG.chopGridLayers,
  spacingPct: APP_CONFIG.chopGridSpacingPct,
  orderSize: APP_CONFIG.chopGridOrderSize,
  seedMultiplier: APP_CONFIG.chopGridSeedMultiplier,
  maxInventory: APP_CONFIG.chopGridMaxInventory,
  recenterPct: APP_CONFIG.chopGridRecenterPct,
  breakoutPct: APP_CONFIG.chopGridBreakoutPct,
  cooldownMs: APP_CONFIG.chopGridCooldownMs,
  reentryCooldownMs: APP_CONFIG.chopGridReentryCooldownMs,
  lossReentryCooldownMs: APP_CONFIG.chopGridLossReentryCooldownMs,
  sameWindowReentryBlock: APP_CONFIG.chopGridSameWindowReentryBlock,
} as const;
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
  { profitPct: 0.3, closeFraction: 0.25 },
  { profitPct: 0.7, closeFraction: 0.25 },
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
  isGrid: boolean;
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
  isGrid: false,
  regimeSnapshot: null,
};

let position: PositionState = { ...FLAT_POSITION };
let lastBtcPrice: number | null = null;
let lastCandles: Candle[] = [];
let lastSignal: StrategySignal | null = null;
let cachedBalance: number | null = null;
let lastBalanceTs = 0;
let lastOkxPositions: OkxPosition[] = [];
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

function currentSignedContracts(): number {
  const rows = okxPositionsToInstrumentPositions(lastOkxPositions);
  return rows[0]?.quantity ?? 0;
}

function currentAbsContracts(): number {
  return Math.abs(currentSignedContracts());
}

function floatingPnlPctFor(side: "long" | "short", entryPrice: number, btcPrice: number): number {
  return side === "long"
    ? (btcPrice - entryPrice) / entryPrice * 100
    : (entryPrice - btcPrice) / entryPrice * 100;
}

function buildDecisionIntent(
  mode: DecisionIntent["mode"],
  route: DecisionIntent["route"],
  proposedDqContracts: number,
  reason: string,
  metadata: Readonly<Record<string, string | number | boolean>> = {}
): DecisionIntent {
  return {
    mode,
    route,
    proposedDqContracts,
    basis: decomposeTradeIncrement(proposedDqContracts),
    reason,
    metadata,
  };
}

function computeSuggestedOpenContracts(
  decision: TradeDecision,
  signal: StrategySignal,
  btcRef: number,
  balance: number | null
): number {
  const stopLossPct = decision.stopLossPct;
  const last15 = lastCandles.slice(-15);
  const range15min = last15.length >= 5
    ? Math.max(...last15.map((c) => c.high)) - Math.min(...last15.map((c) => c.low))
    : btcRef * 0.002;
  const rewardUsd = Math.abs(signal.edge) * range15min * btcRef;
  const riskPerContract = stopLossPct / 100 * btcRef * CONTRACT_SIZE;
  const size = balance !== null && balance > 0 ? calcKellySize(rewardUsd, riskPerContract, balance, btcRef) : 1;
  return Math.min(size, 100);
}

function previewStepDownIntent(signal: StrategySignal, btcPrice: number): DecisionIntent | null {
  if (position.side === null || position.originalSize === null || position.entryPrice === null) return null;
  if (signal.profile === "MEAN_REVERT") return null;

  const floatingPnlPct = floatingPnlPctFor(position.side, position.entryPrice, btcPrice);
  const hardStopLossPct =
    position.regimeSnapshot === "CHOP" || position.regimeSnapshot === "RANGE" ? -1.0 : -1.5;
  if (floatingPnlPct <= hardStopLossPct) {
    const dq = -currentSignedContracts();
    return buildDecisionIntent("trade", position.side === "long" ? "close_long" : "close_short", dq, "hard_stop");
  }

  const nextStepIndex = position.lastStepIndex + 1;
  if (nextStepIndex >= STEP_DOWN_LEVELS.length) return null;
  const nextStep = STEP_DOWN_LEVELS[nextStepIndex];
  if (floatingPnlPct < nextStep.profitPct) return null;

  const currentSize = currentAbsContracts();
  if (currentSize <= 0) return null;
  const originalSize = position.originalSize ?? currentSize;
  const toClose = Math.min(currentSize, Math.max(1, Math.floor(originalSize * nextStep.closeFraction)));
  if (toClose <= 0) return null;

  const dq = position.side === "long" ? -toClose : toClose;
  return buildDecisionIntent(
    "trade",
    position.side === "long" ? "partial_close_long" : "partial_close_short",
    dq,
    `step_down_${nextStepIndex + 1}`,
    { profitPct: floatingPnlPct }
  );
}

function previewCloseIntent(signal: StrategySignal, btcPrice: number): DecisionIntent | null {
  if (position.side === null || position.entryPrice === null || position.originalSize === null) return null;
  if (position.isGrid) return null;

  const pnlPct = floatingPnlPctFor(position.side, position.entryPrice, btcPrice);
  const nowSec = Date.now() / 1000;
  const windowEndTsSec = position.windowEndTimestamp ?? 0;
  const remainingSec = windowEndTsSec - nowSec;
  const remainingMins = remainingSec / 60;
  const closeRoute = position.side === "long" ? "close_long" : "close_short";
  const closeDq = -currentSignedContracts();

  if (remainingSec <= 0) {
    return buildDecisionIntent("trade", closeRoute, closeDq, "window_expired", { pnlPct, remainingMins });
  }

  if (remainingMins <= CLOSE_BEFORE_MINS) {
    return buildDecisionIntent("trade", closeRoute, closeDq, "window_near_end", { pnlPct, remainingMins });
  }

  const elapsedMs = Date.now() - (position.entryTime ?? 0);
  if (elapsedMs >= MAX_HOLDING_MS) {
    return buildDecisionIntent("trade", closeRoute, closeDq, "max_holding", { pnlPct });
  }

  const stopTriggered = position.side === "long"
    ? btcPrice <= position.entryPrice * (1 - position.stopLossPct / 100)
    : btcPrice >= position.entryPrice * (1 + position.stopLossPct / 100);
  if (stopTriggered) {
    return buildDecisionIntent("trade", closeRoute, closeDq, "stop_loss", { pnlPct });
  }

  if (position.isContrarian) {
    const shouldExit =
      (position.side === "long" && signal.regime === "TREND_DOWN") ||
      (position.side === "short" && signal.regime === "TREND_UP");
    if (shouldExit) {
      return buildDecisionIntent("trade", closeRoute, closeDq, "regime_shift", { pnlPct, regime: signal.regime });
    }
  }

  return null;
}

function previewNoSignalIntent(): DecisionIntent {
  if (position.side === null || position.isGrid) {
    return buildDecisionIntent("hold", "noop", 0, "no_signal_no_action");
  }

  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const holdDurationMs = position.entryTime ? Date.now() - position.entryTime : 0;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;
  const windowClosingSoon = remaining <= closeBeforeSec;
  const maxHoldingExceeded = holdDurationMs > regimeMaxHoldingMs(lastSignal);

  if (!windowClosingSoon && !maxHoldingExceeded) {
    return buildDecisionIntent("hold", "noop", 0, "no_signal_hold");
  }

  const reason = windowClosingSoon ? "window_closing_no_signal" : "max_holding_no_signal";
  return buildDecisionIntent(
    "trade",
    position.side === "long" ? "close_long" : "close_short",
    -currentSignedContracts(),
    reason
  );
}

async function previewRunnerIntent(
  signal: StrategySignal,
  upBid: number,
  btcPrice: number,
  endTimestamp: number
): Promise<DecisionIntent> {
  if (position.side !== null && position.isGrid) {
    if (!isChopLike(signal)) {
      return buildDecisionIntent("grid", "grid_exit", -currentAbsContracts(), "grid_regime_shift", {
        regime: signal.regime,
      });
    }
    return buildDecisionIntent("grid", "grid_hold", 0, "grid_manage", { regime: signal.regime });
  }

  if (position.side !== null) {
    const stepDownIntent = previewStepDownIntent(signal, btcPrice);
    const closeIntent = previewCloseIntent(signal, btcPrice);
    if (closeIntent) {
      return closeIntent;
    }
    if (stepDownIntent) {
      return stepDownIntent;
    }
    return buildDecisionIntent("hold", "noop", 0, "position_hold");
  }

  if (isChopLike(signal)) {
    const seedSize = Math.max(1, CHOP_GRID_CONFIG.orderSize * Math.max(1, CHOP_GRID_CONFIG.seedMultiplier));
    return buildDecisionIntent("grid", "grid_seed", seedSize, `grid_seed_${signal.regime}`, {
      regime: signal.regime,
      endTimestamp,
    });
  }

  const decision = makeTradeDecision(signal, upBid, lastCandles);
  if (!decision) {
    return buildDecisionIntent("hold", "noop", 0, "filtered_no_trade", { regime: signal.regime });
  }

  const btcRef = lastBtcPrice ?? btcPrice ?? 76000;
  const balance = await fetchBalance();
  const suggestedSize = computeSuggestedOpenContracts(decision, signal, btcRef, balance);
  return buildDecisionIntent(
    "trade",
    decision.direction === "up" ? "open_long" : "open_short",
    decision.direction === "up" ? suggestedSize : -suggestedSize,
    decision.reason,
    { source: decision.source, regime: signal.regime }
  );
}

async function buildShadowIntent(
  signal: StrategySignal,
  upBid: number,
  btcPrice: number,
  endTimestamp: number
): Promise<DecisionIntent> {
  const decision = position.side === null && !isChopLike(signal)
    ? makeTradeDecision(signal, upBid, lastCandles)
    : null;
  const btcRef = lastBtcPrice ?? btcPrice ?? 76000;
  const balance = await fetchBalance();
  const recommendedOpenContracts = isChopLike(signal)
    ? Math.max(1, CHOP_GRID_CONFIG.orderSize * Math.max(1, CHOP_GRID_CONFIG.seedMultiplier))
    : decision
      ? computeSuggestedOpenContracts(decision, signal, btcRef, balance)
      : 0;
  const stepDownIntent = previewStepDownIntent(signal, btcPrice);
  const closeIntent = previewCloseIntent(signal, btcPrice);
  const shadowReason = closeIntent?.reason ?? stepDownIntent?.reason ?? decision?.reason ?? `shadow_${signal.regime}`;

  return runOptimizerStub({
    currentContracts: currentSignedContracts(),
    currentSide: position.side,
    hasPosition: position.side !== null,
    isGridPosition: position.isGrid,
    signalDirection: decision?.direction ?? "none",
    signalRegime: signal.regime,
    recommendedOpenContracts,
    shouldCloseForExit: closeIntent !== null || (stepDownIntent?.route === "close_long" || stepDownIntent?.route === "close_short"),
    shouldPartialClose: stepDownIntent?.route === "partial_close_long" || stepDownIntent?.route === "partial_close_short",
    partialCloseContracts: stepDownIntent ? Math.abs(stepDownIntent.proposedDqContracts) : 0,
    shouldEnterGrid: position.side === null && isChopLike(signal),
    shouldExitGrid: position.isGrid && !isChopLike(signal),
    reason: shadowReason,
  });
}

function buildShadowIntentNoSignal(): DecisionIntent {
  const nowSec = Date.now() / 1000;
  const remaining = (position.windowEndTimestamp ?? 0) - nowSec;
  const holdDurationMs = position.entryTime ? Date.now() - position.entryTime : 0;
  const closeBeforeSec = CLOSE_BEFORE_MINS * 60;
  const windowClosingSoon = remaining <= closeBeforeSec;
  const maxHoldingExceeded = holdDurationMs > regimeMaxHoldingMs(lastSignal);
  const shouldClose = position.side !== null && !position.isGrid && (windowClosingSoon || maxHoldingExceeded);
  return runOptimizerStub({
    currentContracts: currentSignedContracts(),
    currentSide: position.side,
    hasPosition: position.side !== null,
    isGridPosition: position.isGrid,
    signalDirection: "none",
    signalRegime: "NONE",
    recommendedOpenContracts: 0,
    shouldCloseForExit: shouldClose,
    shouldPartialClose: false,
    partialCloseContracts: 0,
    shouldEnterGrid: false,
    shouldExitGrid: false,
    reason: shouldClose ? "shadow_no_signal_close" : "shadow_no_signal_hold",
  });
}

async function persistPortfolioArtifacts(
  signal: StrategySignal | null,
  btcPrice: number | null,
  actualIntent: DecisionIntent,
  shadowIntent: DecisionIntent
): Promise<void> {
  const meta = await fetchBtcSwapMeta();
  const instrumentSpec = buildBtcSwapInstrumentSpecFromMeta(meta);
  const instrumentPositions = okxPositionsToInstrumentPositions(lastOkxPositions);
  const exposures = computeExposure(instrumentPositions, toInstrumentSpecMap([instrumentSpec]));
  const now = Date.now();
  const gridSnapshot = getChopGridSnapshot();
  const portfolioState = buildPortfolioStateFromRunner({
    asOfMs: now,
    instrumentPositions,
    securityExposures: exposures,
    cashBalances: cachedBalance === null ? {} : { USDT: cachedBalance },
    residualPositions: shadowIntent.basis.residualDqContracts === 0
      ? []
      : [
          buildResidualPosition(
            OKX_BTC_USDT_SWAP,
            shadowIntent.basis.residualDqContracts,
            "UNROUTED_DECISION"
          ),
        ],
    signalDirection: signal?.direction ?? "none",
    signalRegime: signal?.regime ?? "NONE",
    btcPrice: btcPrice ?? 0,
    actualIntent,
    shadowIntent,
    positionSnapshot: {
      side: position.side,
      isGrid: position.isGrid,
      entryPrice: position.entryPrice,
      windowEndTimestamp: position.windowEndTimestamp,
    },
    gridMetadata: chopGridMetadata(gridSnapshot),
  });

  const optimizationRequest = buildOptimizationRequest({
    portfolioState,
    basisSpecs: STRATEGY_BASIS_SPECS,
    objectiveScores: signal ? { signalEdge: signal.edge, confidence: signal.confidence } : {},
    instrumentBounds: {
      [OKX_BTC_USDT_SWAP]: [-MAX_POSITION_SIZE, MAX_POSITION_SIZE],
    },
    securityBounds: {
      [BTC_DELTA]: [-MAX_POSITION_SIZE * CONTRACT_SIZE, MAX_POSITION_SIZE * CONTRACT_SIZE],
      [BTC_PERP_FUNDING_OKX]: [-MAX_POSITION_SIZE * CONTRACT_SIZE, MAX_POSITION_SIZE * CONTRACT_SIZE],
    },
  });

  insertPortfolioSnapshot({
    source: "strategy_runner",
    shadowVersion: PORTFOLIO_SHADOW_VERSION,
    instId: "BTC-USDT-SWAP",
    positionContracts: currentSignedContracts(),
    btcDelta: portfolioState.securityExposures[BTC_DELTA] ?? 0,
    fundingExposure: portfolioState.securityExposures[BTC_PERP_FUNDING_OKX] ?? 0,
    regime: signal?.regime ?? null,
    rawJson: JSON.stringify({
      portfolioState,
      optimizationRequest,
    }),
    createdAt: now,
  });

  const actualAbs = Math.abs(actualIntent.proposedDqContracts);
  const shadowAbs = Math.abs(shadowIntent.proposedDqContracts);
  const denom = Math.max(actualAbs, shadowAbs, 1);
  const diffPct = Math.abs(actualIntent.proposedDqContracts - shadowIntent.proposedDqContracts) / denom * 100;
  insertPortfolioShadowLog({
    source: "strategy_runner",
    shadowVersion: PORTFOLIO_SHADOW_VERSION,
    actualRoute: actualIntent.route,
    shadowRoute: shadowIntent.route,
    actualDqContracts: actualIntent.proposedDqContracts,
    shadowDqContracts: shadowIntent.proposedDqContracts,
    actualBasisId: actualIntent.basis.basisId,
    shadowBasisId: shadowIntent.basis.basisId,
    actualResidualContracts: actualIntent.basis.residualDqContracts,
    shadowResidualContracts: shadowIntent.basis.residualDqContracts,
    shadowResidualReason: shadowIntent.basis.residualReasonCode,
    diffPct,
    rawJson: JSON.stringify({
      actualIntent,
      shadowIntent,
      optimizationRequest,
      signal: signal ? {
        direction: signal.direction,
        regime: signal.regime,
        stage: signal.stage,
        edge: signal.edge,
        confidence: signal.confidence,
      } : null,
    }),
    createdAt: now,
  });

  if (shadowIntent.basis.residualDqContracts !== 0) {
    insertPortfolioResidual({
      source: "strategy_runner",
      shadowVersion: PORTFOLIO_SHADOW_VERSION,
      instId: "BTC-USDT-SWAP",
      quantity: shadowIntent.basis.residualDqContracts,
      reasonCode: shadowIntent.basis.residualReasonCode ?? "UNROUTED_DECISION",
      rawJson: JSON.stringify({
        shadowIntent,
        signal: signal ? {
          direction: signal.direction,
          regime: signal.regime,
        } : null,
      }),
      createdAt: now,
    });
  }
}

function isExtremeVolatility(candles: Candle[], btcPrice: number): boolean {
  const last5 = candles.slice(-5);
  if (last5.length < 3) return false;
  const high = Math.max(...last5.map((c) => c.high));
  const low = Math.min(...last5.map((c) => c.low));
  return (high - low) / btcPrice > EXTREME_VOL_THRESHOLD;
}

function isChopLike(signal: StrategySignal): signal is StrategySignal & { regime: "CHOP" | "RANGE" } {
  return signal.regime === "CHOP" || signal.regime === "RANGE";
}

function makeTradeDecision(signal: StrategySignal, upBid: number, candles: Candle[]): TradeDecision | null {
  if (isChopLike(signal)) return null;
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
  await primeChopGridPosition("BTC-USDT-SWAP");
  const positions = await getPositions("BTC-USDT-SWAP");
  const activePositions = positions.filter((p) => parseInt(p.pos) !== 0);
  lastOkxPositions = activePositions;
  if (!activePositions.length) {
    if (position.side !== null) log(`[POS] Flat — no open positions on OKX`);
    resetPosition();
    return;
  }

  const pos = activePositions[0];
  const side = pos.posSide === "short" ? "short" : "long";
  const avgPx = parseFloat(pos.avgPx);
  const sz = parseFloat(pos.pos);
  const gridSnapshot = getChopGridSnapshot();
  const isGridPosition = gridSnapshot.active && side === "long";
  position.isGrid = isGridPosition;

  if (position.side !== side || position.entryPrice !== avgPx) {
    log(`[POS] Synced: ${side.toUpperCase()} | avgPx=${avgPx} | sz=${sz} | unrealized=${pos.upl}`);
    position.side = side;
    position.entryPrice = avgPx;
    position.entryTime = Date.now();
    position.orderId = null;
    position.originalSize = sz;
    position.lastStepIndex = -1;
    position.breakEvenActivated = false;
    logTradeEvent("TRADE", "position_synced", {
      side,
      avgPx,
      size: sz,
      grid: isGridPosition,
      source: isGridPosition ? "grid" : "normal",
    });
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
  const size = computeSuggestedOpenContracts(decision, signal, btcRef, balance);
  const sizeStr = String(Math.min(size, 100));

  let result = null;
  if (decision.direction === "up") {
    log(`[TRADE] buyUp | source=${decision.source} | ${decision.reason}`);
    logTradeEvent("TRADE", "open_submit", {
      direction: decision.direction,
      source: decision.source,
      reason: decision.reason,
      size,
      contracts: sizeStr,
      btcRef,
      stopLossPct,
      breakEvenPct,
      regime: signal.regime,
    });
    result = await buyUp("BTC-USDT-SWAP", sizeStr);
  } else if (decision.direction === "down") {
    log(`[TRADE] sellDown | source=${decision.source} | ${decision.reason}`);
    logTradeEvent("TRADE", "open_submit", {
      direction: decision.direction,
      source: decision.source,
      reason: decision.reason,
      size,
      contracts: sizeStr,
      btcRef,
      stopLossPct,
      breakEvenPct,
      regime: signal.regime,
    });
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
      isGrid: false,
      regimeSnapshot: signal.regimeSnapshot ?? signal.regime,
    };
    log(`[TRADE] Opened ${openedSide} | ordId=${result.ordId} | BTC≈${lastBtcPrice} | size=${sizeStr} contracts`);
    logTradeEvent("TRADE", "open_filled", {
      side: position.side,
      source: decision.source,
      reason: decision.reason,
      ordId: result.ordId,
      entryPrice: position.entryPrice,
      size: size,
      contracts: sizeStr,
      stopLossPct,
      breakEvenPct,
      regime: signal.regime,
    });
    return true;
  }

  log(`[WARN] Order failed: ${JSON.stringify(result)}`);
  logTradeEvent("TRADE", "open_failed", {
    direction: decision.direction,
    source: decision.source,
    reason: decision.reason,
    size,
    contracts: sizeStr,
    btcRef,
    result,
  });
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
    logTradeEvent("TRADE", "partial_close", {
      side: position.side,
      stepIndex: nextStepIndex + 1,
      closed,
      currentSize,
      profitPct: floatingPnlPct,
      entryPrice: position.entryPrice,
      lastPrice: lastBtcPrice,
    });
    position.lastStepIndex = nextStepIndex;
    const remaining = await getPositions("BTC-USDT-SWAP");
    if (!remaining.length || parseInt(remaining[0].pos) === 0) {
      const pnl = position.entryPrice && lastBtcPrice
        ? (position.side === "long" ? lastBtcPrice - position.entryPrice : position.entryPrice - lastBtcPrice)
        : 0;
      log(`[TRADE] All closed | PnL≈${pnl.toFixed(2)} (BTC ${position.entryPrice}→${lastBtcPrice})`);
      logTradeEvent("TRADE", "position_fully_closed", {
        side: position.side,
        reason: "step_down",
        pnl,
        entryPrice: position.entryPrice,
        exitPrice: lastBtcPrice,
      });
      resetPosition();
    }
  }
}

async function tryClosePosition(signal: StrategySignal): Promise<void> {
  if (position.side === null || position.entryPrice === null || position.originalSize === null) return;

  if (position.isGrid) {
    return;
  }

  const btcRef = lastBtcPrice ?? 76000;
  const elapsedMs = Date.now() - (position.entryTime ?? 0);
  const pnlPct = position.side === "long"
    ? (btcRef - position.entryPrice) / position.entryPrice * 100
    : (position.entryPrice - btcRef) / position.entryPrice * 100;

  const nowSec = Date.now() / 1000;
  const windowEndTsSec = position.windowEndTimestamp ?? 0;
  const remainingSec = windowEndTsSec - nowSec;
  const remainingMins = remainingSec / 60;
  if (remainingSec <= 0) {
    log(`[EXIT] window_expired (${remainingMins.toFixed(1)}m from end) | pnl=${pnlPct.toFixed(2)}% | closing`);
    logTradeEvent("TRADE", "position_exit", {
      side: position.side,
      reason: "window_expired",
      pnlPct,
      entryPrice: position.entryPrice,
      exitPrice: btcRef,
      remainingMins,
      isGrid: position.isGrid,
    });
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  if (remainingMins <= CLOSE_BEFORE_MINS && position.side !== null) {
    log(`[EXIT] window_near_end (${remainingMins.toFixed(1)}m left) | pnl=${pnlPct.toFixed(2)}% | closing`);
    logTradeEvent("TRADE", "position_exit", {
      side: position.side,
      reason: "window_near_end",
      pnlPct,
      entryPrice: position.entryPrice,
      exitPrice: btcRef,
      remainingMins,
      isGrid: position.isGrid,
    });
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  if (elapsedMs >= MAX_HOLDING_MS) {
    log(`[EXIT] max_holding (${(elapsedMs / 60000).toFixed(1)}m) | pnl=${pnlPct.toFixed(2)}% | closing`);
    logTradeEvent("TRADE", "position_exit", {
      side: position.side,
      reason: "max_holding",
      pnlPct,
      entryPrice: position.entryPrice,
      exitPrice: btcRef,
      holdMinutes: elapsedMs / 60000,
      isGrid: position.isGrid,
    });
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  const stopTriggered = position.side === "long"
    ? btcRef <= position.entryPrice * (1 - position.stopLossPct / 100)
    : btcRef >= position.entryPrice * (1 + position.stopLossPct / 100);
  if (stopTriggered) {
    log(`[EXIT] stop_loss | pnl=${pnlPct.toFixed(2)}% | hit=${position.stopLossPct}% [${position.isContrarian ? "contrarian" : "main"}]`);
    logTradeEvent("TRADE", "position_exit", {
      side: position.side,
      reason: "stop_loss",
      pnlPct,
      entryPrice: position.entryPrice,
      exitPrice: btcRef,
      stopLossPct: position.stopLossPct,
      source: position.isContrarian ? "contrarian" : "main",
      isGrid: position.isGrid,
    });
    await closeAllPositions("BTC-USDT-SWAP");
    resetPosition();
    return;
  }

  if (!position.breakEvenActivated && pnlPct >= position.breakEvenPct) {
    position.breakEvenActivated = true;
    position.stopLossPct = 0;
    log(`[RISK] Break-even activated at ${pnlPct.toFixed(2)}% [${position.isContrarian ? "contrarian" : "main"}]`);
    logTradeEvent("TRADE", "break_even_armed", {
      side: position.side,
      pnlPct,
      breakEvenPct: position.breakEvenPct,
      source: position.isContrarian ? "contrarian" : "main",
      isGrid: position.isGrid,
    });
  }

  if (position.isContrarian) {
    const regime = signal.regime;
    const shouldExit =
      (position.side === "long" && regime === "TREND_DOWN") ||
      (position.side === "short" && regime === "TREND_UP");
    if (shouldExit) {
      log(`[EXIT] regime_shift | pnl=${pnlPct.toFixed(2)}% | regime=${regime} | closing contrarian`);
      logTradeEvent("TRADE", "position_exit", {
        side: position.side,
        reason: "regime_shift",
        pnlPct,
        entryPrice: position.entryPrice,
        exitPrice: btcRef,
        regime,
        source: "contrarian",
        isGrid: position.isGrid,
      });
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
  const windowClosingSoon = remaining <= closeBeforeSec;
  const maxHoldingExceeded = holdDurationMs > regimeMaxHoldingMs(lastSignal);

  if (!windowClosingSoon && !maxHoldingExceeded) return false;

  const reason = windowClosingSoon ? "window_closing_no_signal" : "max_holding_no_signal";
  if (!ENABLE_TRADING) {
    log(`[SIM] Would close without signal: reason=${reason}`);
    return false;
  }

  if (position.isGrid) return false;

  log(`[TRADE] closeAllPositions — reason=${reason}`);
  logTradeEvent("TRADE", "position_exit", {
    side: position.side,
    reason,
    isGrid: position.isGrid,
    remainingMins: remaining / 60,
    holdMinutes: holdDurationMs / 60000,
  });
  await closeAllPositions("BTC-USDT-SWAP");
  resetPosition();
  return true;
}

async function tryManageGridPosition(signal: StrategySignal, btcPrice: number, endTimestamp: number): Promise<boolean> {
  if (!position.isGrid) return false;

  const shouldExitGrid = !isChopLike(signal);
  if (shouldExitGrid) {
    log(`[GRID] Regime shifted to ${signal.regime} — closing grid inventory`);
    logTradeEvent("GRID", "grid_exit", {
      reason: "regime_shift",
      regime: signal.regime,
      btcPrice,
      windowEnd: endTimestamp,
    });
    await maybeRunChopGrid("BTC-USDT-SWAP", CHOP_GRID_CONFIG, "CHOP", btcPrice, true, endTimestamp);
    resetPosition();
    return true;
  }

  if (position.windowEndTimestamp !== endTimestamp) {
    position.windowEndTimestamp = endTimestamp;
    log(`[GRID] window_rollover — carrying inventory into next window`);
    logTradeEvent("GRID", "window_rollover", {
      btcPrice,
      endTimestamp,
      inventory: position.originalSize,
    });
  }

  const gridResult = await maybeRunChopGrid("BTC-USDT-SWAP", CHOP_GRID_CONFIG, signal.regime, btcPrice, false, endTimestamp);
  if (!gridResult.active) {
    resetPosition();
    return true;
  }
  return true;
}

async function main(): Promise<void> {
  log(`Strategy runner starting (main + contrarian)`);
  log(`Window: ${WINDOW_DURATION_MINUTES}min | Interval: ${SIGNAL_INTERVAL_MS}ms | Trading: ${ENABLE_TRADING}`);
  log(`Config: ${getStartupRiskSummary().join(" | ")}`);
  log(`Risk main: stop=${STOP_LOSS_PCT}% | break_even=${BREAK_EVEN_PCT}%`);
  log(`Risk contrarian: stop=${CONTRARIAN_STOP_LOSS_PCT}% | break_even=${CONTRARIAN_BREAK_EVEN_PCT}% | PM_H=${PM_CONTRARIAN_HIGH} | PM_L=${PM_CONTRARIAN_LOW} | vol_threshold=${EXTREME_VOL_THRESHOLD}`);
  log(`Risk chop-grid: layers=${CHOP_GRID_CONFIG.layers} | spacing=${(CHOP_GRID_CONFIG.spacingPct * 100).toFixed(2)}% | orderSize=${CHOP_GRID_CONFIG.orderSize} | seedMultiplier=${CHOP_GRID_CONFIG.seedMultiplier} | maxInventory=${CHOP_GRID_CONFIG.maxInventory} | recenter=${(CHOP_GRID_CONFIG.recenterPct * 100).toFixed(2)}% | breakout=${(CHOP_GRID_CONFIG.breakoutPct * 100).toFixed(2)}%`);
  log(`Sizing: MAX_POS_SIZE_PCT=${(MAX_POS_SIZE_PCT * 100).toFixed(0)}% | Kelly formula`);
  const gridStats = getChopGridStats();
  log(`Grid stats: roundTrips=${gridStats.roundTripCount} | wins=${gridStats.winCount} | losses=${gridStats.lossCount} | gross=${gridStats.grossPnl.toFixed(4)} | fee=${gridStats.fee.toFixed(4)} | net=${gridStats.netPnl.toFixed(4)} | feeRatio=${gridStats.avgFeeRatio === null ? "n/a" : gridStats.avgFeeRatio.toFixed(3)}`);

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
        const actualIntent = previewNoSignalIntent();
        const shadowIntent = buildShadowIntentNoSignal();
        await tryClosePositionNoSignal();
        if (actualIntent.proposedDqContracts !== 0 && ENABLE_TRADING) {
          await syncPosition();
        }
        await persistPortfolioArtifacts(null, lastBtcPrice, actualIntent, shadowIntent);
        await sleep(SIGNAL_INTERVAL_MS);
        continue;
      }

      const { signal, btcPrice, upBid, endTimestamp } = evalResult;
      const actualIntent = await previewRunnerIntent(signal, upBid, btcPrice, endTimestamp);
      const shadowIntent = await buildShadowIntent(signal, upBid, btcPrice, endTimestamp);
      lastSignal = signal;
      if (position.side === null || position.windowEndTimestamp === null) {
        position.windowEndTimestamp = endTimestamp;
      }
      if (position.side !== null && position.isGrid) {
        position.windowEndTimestamp = endTimestamp;
      }

      const dir = signal.direction === "none" ? "—" : signal.direction.toUpperCase();
      const edge = signal.edge >= 0 ? `+${signal.edge.toFixed(3)}` : signal.edge.toFixed(3);
      log(`${dir} | edge=${edge} | conf=${signal.confidence.toFixed(3)} | regime=${signal.regime} | stage=${signal.stage} | profile=${signal.profile ?? "FILTERED"} | BTC=$${btcPrice}`);
      if (signal.regimeScore !== undefined) {
        log(`[REGIME] score=${signal.regimeScore.toFixed(2)} reason=${signal.regimeReason ?? "n/a"} mode=${REGIME_MODE}`);
      }

      if (position.side !== null && position.isGrid) {
        await tryManageGridPosition(signal, btcPrice, endTimestamp);
      } else if (position.side !== null) {
        await tryStepDownPosition(signal);
        await tryClosePosition(signal);
      } else {
        if (isChopLike(signal)) {
          if (!ENABLE_TRADING) {
            log(`[SIM][GRID] Would run long-inventory chop grid | regime=${signal.regime} | BTC=$${btcPrice}`);
          } else {
            const gridResult = await maybeRunChopGrid("BTC-USDT-SWAP", CHOP_GRID_CONFIG, signal.regime, btcPrice, false, endTimestamp);
            log(`[GRID] ${gridResult.reason} | active=${gridResult.active}`);
            if (gridResult.openedSeed) {
              position = {
                side: "long",
                entryPrice: btcPrice,
                entryTime: Date.now(),
                slug: null,
                windowEndTimestamp: endTimestamp,
                orderId: null,
                originalSize: CHOP_GRID_CONFIG.orderSize,
                lastStepIndex: -1,
                stopLossPct: 0,
                breakEvenPct: 0,
                breakEvenActivated: false,
                isContrarian: false,
                isGrid: true,
                regimeSnapshot: signal.regime,
              };
              logTradeEvent("GRID", "seed_position_registered", {
                regime: signal.regime,
                entryPrice: btcPrice,
                windowEnd: endTimestamp,
                inventory: CHOP_GRID_CONFIG.orderSize,
              });
            }
          }
          await sleep(SIGNAL_INTERVAL_MS);
          continue;
        }

        const decision = makeTradeDecision(signal, upBid, lastCandles);
        if (decision) {
          log(`[DECISION] ${decision.source} | ${decision.reason}`);
          await tryOpenPosition(decision, signal, endTimestamp);
        }
      }

      if (actualIntent.proposedDqContracts !== 0 && ENABLE_TRADING) {
        await syncPosition();
      }
      await persistPortfolioArtifacts(signal, btcPrice, actualIntent, shadowIntent);
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
    if (position.isGrid) {
      await maybeRunChopGrid("BTC-USDT-SWAP", CHOP_GRID_CONFIG, "CHOP", lastBtcPrice, true);
    } else {
      await closeAllPositions("BTC-USDT-SWAP");
    }
  }
  process.exit(0);
});

main().catch((err) => {
  log(`FATAL: ${err}`);
  process.exit(1);
});
