/**
 * Strategy scoring engine
 * Combines TA signals + Kronos ML model + Polymarket price + time awareness
 * Produces a blended model probability and decides whether to place a trade
 */

import type { Candle } from "../monitor/binance.js";
import {
  calcVwap,
  calcRsi,
  calcMacd,
  calcVwapSlope,
  calcHeikenAshi,
  calcBollingerWidthPct,
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
  kronosWeight: number;
  regimeMode: "adaptive" | "trend_only" | "chop_only";
  minRegimeScore: number;
  trendWidthMinPct: number;
  chopWidthMaxPct: number;
}

/** Default scoring config */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  entryTimeRatioMin: 0.2,
  entryPriceRatioMin: 0.01,
  entryPriceRatioMax: 0.40,
  entryEdgeThreshold: 0.05,
  entryProbMin: 0.65,
  exitPriceRatioRange: [0.35, 0.5],
  exitTimeRatio: 0.85,
  earlyTimeRatio: 0.7,
  lateTimeRatio: 0.2,
  kronosWeight: 0.4,
  regimeMode: "adaptive",
  minRegimeScore: 0.6,
  trendWidthMinPct: 0.04,
  chopWidthMaxPct: 0.035,
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
 * kronosProb: optional 0-1 probability from Kronos ML model (null = TA-only fallback)
 */
export function scoreStrategy(
  candles: Candle[],
  upBid: number,
  windowEndTimestamp: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
  windowDurSeconds: number = 15 * 60,
  kronosProb: number | null = null,
): StrategySignal {
  const { score, maxScore, breakdown } = scoreDirection(candles);
  const taProb = maxScore > 0 ? score / maxScore : 0.5;

  // Blend TA + Kronos if available
  // Dynamic Kronos weight: scale down when Kronos has no view (prob ≈ 0.5)
  const kronosConfidence = (kronosProb !== null) ? Math.abs(kronosProb - 0.5) / 0.5 : 0;
  const w = (kronosProb !== null && kronosConfidence > 0.1)
    ? config.kronosWeight * Math.min(1, kronosConfidence * 2)
    : 0;
  const blendedProb = (w > 0)
    ? (1 - w) * taProb + w * kronosProb!
    : taProb;

  // Time-aware probability
  const decayProb = applyTimeAwareness(blendedProb, windowEndTimestamp, windowDurSeconds);

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
  let profile: "TREND_FOLLOW" | "MEAN_REVERT" | "FILTERED" = "FILTERED";

  const reasons: string[] = [];
  const widthPct = calcBollingerWidthPct(candles.slice(-20), Math.min(20, candles.length));

  // Entry conditions
  const timeRatio = calcTimeRatio(windowEndTimestamp, windowDurSeconds);
  const trendAllowed = regime === "TREND_UP" || regime === "TREND_DOWN";
  const chopAllowed = regime === "CHOP" || regime === "RANGE";
  const regimeStrongEnough = regimeInfo.score >= config.minRegimeScore;
  const modeAllowsTrend = config.regimeMode !== "chop_only";
  const modeAllowsChop = config.regimeMode !== "trend_only";

  if (modeAllowsTrend && trendAllowed && regimeStrongEnough && widthPct >= config.trendWidthMinPct && timeRatio > config.entryTimeRatioMin && upPriceRatio >= config.entryPriceRatioMin && upPriceRatio <= config.entryPriceRatioMax) {
    if (edge > config.entryEdgeThreshold && decayProb > config.entryProbMin) {
      direction = "up";
      profile = "TREND_FOLLOW";
      reasons.push(`edge=${edge.toFixed(3)}`);
    } else if (-edge > config.entryEdgeThreshold && (1 - decayProb) > config.entryProbMin) {
      direction = "down";
      profile = "TREND_FOLLOW";
      reasons.push(`edge=${(-edge).toFixed(3)}`);
    }
  } else if (modeAllowsChop && chopAllowed && regimeStrongEnough && widthPct <= config.chopWidthMaxPct && timeRatio > config.entryTimeRatioMin) {
    const fairPrice = 0.5;
    const mispricing = upBid - fairPrice;
    if (upPriceRatio >= config.entryPriceRatioMin) {
      if (mispricing >= config.entryEdgeThreshold) {
        direction = "down";
        profile = "MEAN_REVERT";
        reasons.push(`chop_revert=down edge=${mispricing.toFixed(3)}`);
      } else if (mispricing <= -config.entryEdgeThreshold) {
        direction = "up";
        profile = "MEAN_REVERT";
        reasons.push(`chop_revert=up edge=${Math.abs(mispricing).toFixed(3)}`);
      }
    }
  }

  // Exit conditions (check if in a position)
  // For now, mark signal with stage/regime for downstream use
  const kronosTag = kronosProb !== null ? `|kr=${kronosProb.toFixed(3)}` : "|kr=N/A";
  if (direction !== "none") {
    reasons.push(`regime=${regime}`);
    reasons.push(`regimeScore=${regimeInfo.score.toFixed(2)}`);
    reasons.push(`regimeReason=${regimeInfo.reason}`);
    reasons.push(`regimeMode=${config.regimeMode}`);
    reasons.push(`stage=${stage}`);
    reasons.push(`upPriceRatio=${upPriceRatio.toFixed(3)}`);
    reasons.push(`prob=${decayProb.toFixed(3)}(ta=${taProb.toFixed(3)}${kronosTag})`);
    reason = reasons.join(" ");
  } else {
    reason = `no_signal|edge=${edge.toFixed(3)}|upRatio=${upPriceRatio.toFixed(3)}|timeRatio=${timeRatio.toFixed(2)}|stage=${stage}|ta=${taProb.toFixed(3)}${kronosTag}`;
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
    regimeScore: regimeInfo.score,
    regimeReason: regimeInfo.reason,
    profile,
    regimeSnapshot: regime,
  };
}
