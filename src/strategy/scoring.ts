/**
 * Strategy scoring engine
 * Combines TA signals + Polymarket price + time awareness
 * Produces a model probability and decides whether to place a trade
 */

import type { Candle } from "../monitor/binance.js";
import {
  calcVwap,
  calcRsi,
  calcMacd,
  calcVwapSlope,
  calcHeikenAshi,
  priceVsVwap,
} from "./ta.js";
import { detectRegime } from "./regime.js";
import type { MarketRegime, TradeStage, StrategySignal } from "../types.js";

export interface ScoringConfig {
  // Entry thresholds
  entryTimeRatioMin: number;   // min remaining time ratio to consider entry
  entryPriceRatioMin: number;   // min |upBid - 0.5| / 0.5 to consider entry
  entryPriceRatioMax: number;   // max |upBid - 0.5| / 0.5 to consider entry
  entryEdgeThreshold: number;   // min edge (model - market) to place bet
  entryProbMin: number;         // min model probability to place bet
  // Exit thresholds
  exitPriceRatioRange: [number, number];  // [low, high] upPriceRatio to exit
  exitTimeRatio: number;       // time ratio to trigger forced exit
  // Stage thresholds (remaining time ratios)
  earlyTimeRatio: number;      // EARLY: > this
  lateTimeRatio: number;       // LATE: < this
}

/** Default scoring config */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  entryTimeRatioMin: 0.2,
  entryPriceRatioMin: 0.05,
  entryPriceRatioMax: 0.3,
  entryEdgeThreshold: 0.05,
  entryProbMin: 0.55,
  exitPriceRatioRange: [0.35, 0.5],
  exitTimeRatio: 0.85,
  earlyTimeRatio: 0.7,
  lateTimeRatio: 0.2,
};

/** Score a direction signal (1-3 per sub-signal) */
function scoreDirection(candles: Candle[]): {
  score: number;
  maxScore: number;
  breakdown: Record<string, number>;
} {
  if (candles.length < 20) {
    return { score: 0, maxScore: 0, breakdown: {} };
  }

  const breakdown: Record<string, number> = {};
  let score = 0;
  const maxScore = 18; // 6 sub-signals, each 1-3 → max total = 18

  const vwap = calcVwap(candles.slice(-30));
  const rsi = calcRsi(candles);
  const macd = calcMacd(candles);
  const vwapSlope = calcVwapSlope(candles);
  const ha = calcHeikenAshi(candles);
  const pricePos = priceVsVwap(candles[candles.length - 1], vwap);

  // 1. Price position vs VWAP
  breakdown.priceVwap = pricePos > 0.003 ? 3 : pricePos < -0.003 ? 1 : 2;
  score += breakdown.priceVwap;

  // 2. VWAP slope
  breakdown.vwapSlope = vwapSlope > 0.001 ? 3 : vwapSlope < -0.001 ? 1 : 2;
  score += breakdown.vwapSlope;

  // 3. RSI
  breakdown.rsi = rsi > 60 ? 3 : rsi < 40 ? 1 : 2;
  score += breakdown.rsi;

  // 4. MACD histogram
  breakdown.macd = macd.histogram > 0 ? 3 : macd.histogram < 0 ? 1 : 2;
  score += breakdown.macd;

  // 5. Heiken Ashi color
  breakdown.heiken = ha.isGreen ? 3 : 1;
  score += breakdown.heiken;

  // 6. Failed VWAP reclaim (price crossed back above VWAP after being below)
  // Simplified: price currently above and was below recently
  const prev = priceVsVwap(candles[candles.length - 2], vwap);
  breakdown.vwapReclaim = pricePos >= 0 && prev < 0 ? 3 : pricePos < 0 && prev >= 0 ? 1 : 2;
  score += breakdown.vwapReclaim;

  return { score, maxScore, breakdown };
}

/**
 * Calculate upPriceRatio: how much the UP price deviates from 50%
 * upPriceRatio = |upBid - 0.5| / 0.5
 * 0.05 = 5% deviation from fair
 */
export function calcUpPriceRatio(upBid: number): number {
  return Math.abs(upBid - 0.5) / 0.5;
}

/**
 * Calculate remaining time ratio (0=new market, 1=about to close)
 */
export function calcTimeRatio(windowEndTimestamp: number, windowDurSeconds: number = 15 * 60): number {
  const nowSec = Date.now() / 1000;
  const remaining = windowEndTimestamp - nowSec;
  const total = windowDurSeconds;
  return Math.max(0, Math.min(1, 1 - remaining / total));
}

/**
 * Determine trade stage based on remaining time
 */
export function calcTradeStage(
  windowEndTimestamp: number,
  config: ScoringConfig,
  windowDurSeconds: number = 15 * 60
): TradeStage {
  const ratio = calcTimeRatio(windowEndTimestamp, windowDurSeconds);
  if (ratio < config.lateTimeRatio) return "LATE";
  if (ratio < config.earlyTimeRatio) return "MID";
  return "EARLY";
}

/**
 * Apply time decay to model probability
 * As market approaches close, model probability is pulled toward 0.5
 */
export function applyTimeAwareness(
  modelProb: number,
  windowEndTimestamp: number,
  windowDurSeconds: number = 15 * 60
): number {
  const ratio = calcTimeRatio(windowEndTimestamp, windowDurSeconds);
  // Decay: probability moves toward 0.5 as time runs out
  const decay = 1 - Math.pow(ratio, 2);
  return modelProb * decay + 0.5 * (1 - decay);
}

/**
 * Main strategy scoring function
 * Returns a StrategySignal with direction, confidence, edge
 */
export function scoreStrategy(
  candles: Candle[],
  upBid: number,
  windowEndTimestamp: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  windowDurSeconds: number = 15 * 60
): StrategySignal {
  const { score, maxScore, breakdown } = scoreDirection(candles);
  const modelProb = score / maxScore;

  // Time-aware probability
  const decayProb = applyTimeAwareness(modelProb, windowEndTimestamp, windowDurSeconds);

  // Market probability
  const marketProb = upBid;
  const edge = decayProb - marketProb;

  // upPriceRatio
  const upPriceRatio = calcUpPriceRatio(upBid);

  // Regime
  const regimeInfo = detectRegime(candles);
  const { regime } = regimeInfo;

  // Stage
  const stage = calcTradeStage(windowEndTimestamp, config, windowDurSeconds);

  // Direction
  let direction: "up" | "down" | "none" = "none";
  let reason = "";

  const reasons: string[] = [];

  // Entry conditions
  const timeRatio = calcTimeRatio(windowEndTimestamp, windowDurSeconds);
  if (timeRatio > config.entryTimeRatioMin && upPriceRatio >= config.entryPriceRatioMin && upPriceRatio <= config.entryPriceRatioMax) {
    if (edge > config.entryEdgeThreshold && decayProb > config.entryProbMin) {
      direction = "up";
      reasons.push(`edge=${edge.toFixed(3)}`);
    } else if (-edge > config.entryEdgeThreshold && (1 - decayProb) > config.entryProbMin) {
      direction = "down";
      reasons.push(`edge=${(-edge).toFixed(3)}`);
    }
  }

  // Exit conditions (check if in a position)
  // For now, mark signal with stage/regime for downstream use
  if (direction !== "none") {
    reasons.push(`regime=${regime}`);
    reasons.push(`stage=${stage}`);
    reasons.push(`upPriceRatio=${upPriceRatio.toFixed(3)}`);
    reasons.push(`prob=${decayProb.toFixed(3)}`);
    reason = reasons.join(" ");
  } else {
    reason = `no_signal|edge=${edge.toFixed(3)}|upRatio=${upPriceRatio.toFixed(3)}|timeRatio=${timeRatio.toFixed(2)}|stage=${stage}`;
  }

  return {
    coin: "btc",
    direction,
    confidence: decayProb,
    edge,
    upPriceRatio,
    reason,
    regime,
    stage,
  };
}