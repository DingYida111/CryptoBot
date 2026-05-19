/**
 * Market regime detection
 * Dual-regime profile for CryptoBot:
 * - TREND: directional momentum is strong enough to justify trading
 * - CHOP: mean-reversion / range-bound / low-edge environment
 */

import type { Candle } from "../monitor/binance.js";
import { calcVwap, calcVwapSlope, priceVsVwap, calcAtr, calcBollingerWidthPct } from "./ta.js";
import type { MarketRegime } from "../types.js";

export interface RegimeInfo {
  regime: MarketRegime;
  score: number;    // confidence 0-1
  reason: string;
  widthPct: number;
  atrPct: number;
}

function calcCrosses(candles: Candle[], vwap: number): number {
  let crosses = 0;
  for (let i = 1; i < candles.length; i++) {
    const prev = priceVsVwap(candles[i - 1], vwap);
    const curr = priceVsVwap(candles[i], vwap);
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) crosses++;
  }
  return crosses;
}

/**
 * Detect market regime from recent candles
 */
export function detectRegime(candles: Candle[], lookback: number = 30): RegimeInfo {
  if (candles.length < 12) {
    return { regime: "CHOP", score: 0.5, reason: "insufficient_data", widthPct: 0, atrPct: 0 };
  }

  const recent = candles.slice(-lookback);
  const vwap = calcVwap(recent);
  const vwapSlope = calcVwapSlope(recent, 10);
  const pricePos = priceVsVwap(recent[recent.length - 1], vwap);
  const crosses = calcCrosses(recent, vwap);
  const closes = recent.map((c) => c.close);
  const trendStrength = Math.abs(closes[closes.length - 1] - closes[0]) / closes[0];
  const atr = calcAtr(recent, Math.min(14, Math.max(5, Math.floor(recent.length / 2))));
  const atrPct = closes[closes.length - 1] > 0 ? atr / closes[closes.length - 1] : 0;
  const widthPct = calcBollingerWidthPct(recent, Math.min(20, recent.length));

  const trendScore =
    (pricePos > 0 ? 0.2 : 0) +
    (Math.abs(vwapSlope) > 0.001 ? 0.2 : 0) +
    (crosses <= 2 ? 0.2 : 0) +
    (trendStrength > 0.005 ? 0.2 : 0) +
    (widthPct > 0.04 ? 0.2 : 0);

  const chopScore =
    (crosses >= 3 ? 0.25 : 0) +
    (trendStrength < 0.008 ? 0.25 : 0) +
    (widthPct < 0.035 ? 0.25 : 0) +
    (atrPct < 0.01 ? 0.25 : 0);

  if (pricePos > 0.004 && vwapSlope > 0.0008 && crosses <= 2 && trendStrength > 0.004) {
    return {
      regime: "TREND_UP",
      score: Math.min(0.95, 0.65 + trendScore / 3),
      reason: `above_vwap_positive_slope_crosses_${crosses}`,
      widthPct,
      atrPct,
    };
  }

  if (pricePos < -0.004 && vwapSlope < -0.0008 && crosses <= 2 && trendStrength > 0.004) {
    return {
      regime: "TREND_DOWN",
      score: Math.min(0.95, 0.65 + trendScore / 3),
      reason: `below_vwap_negative_slope_crosses_${crosses}`,
      widthPct,
      atrPct,
    };
  }

  if (crosses >= 3 || (widthPct < 0.035 && atrPct < 0.01)) {
    return {
      regime: "CHOP",
      score: Math.min(0.9, 0.55 + chopScore / 2),
      reason: `range_or_chop_crosses_${crosses}`,
      widthPct,
      atrPct,
    };
  }

  return {
    regime: "RANGE",
    score: 0.7,
    reason: `oscillating_vwap_crosses_${crosses}`,
    widthPct,
    atrPct,
  };
}
