/**
 * Market regime detection
 * Based on price/VWAP position, slope, cross count, volume
 */

import type { Candle } from "../monitor/binance.js";
import { calcVwap, calcVwapSlope, priceVsVwap } from "./ta.js";
import type { MarketRegime } from "../types.js";

export interface RegimeInfo {
  regime: MarketRegime;
  score: number;    // confidence 0-1
  reason: string;
}

/**
 * Detect market regime from recent candles
 */
export function detectRegime(candles: Candle[], lookback: number = 30): RegimeInfo {
  if (candles.length < 10) {
    return { regime: "CHOP", score: 0.5, reason: "insufficient_data" };
  }

  const recent = candles.slice(-lookback);
  const vwap = calcVwap(recent);
  const vwapSlope = calcVwapSlope(recent, 10);
  const pricePos = priceVsVwap(recent[recent.length - 1], vwap);

  // Count how many times price crossed VWAP
  let crosses = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = priceVsVwap(recent[i - 1], vwap);
    const curr = priceVsVwap(recent[i], vwap);
    if ((prev < 0 && curr >= 0) || (prev >= 0 && curr < 0)) crosses++;
  }

  const closes = recent.map((c) => c.close);
  const trendStrength = Math.abs(closes[closes.length - 1] - closes[0]) / closes[0];

  // TREND_UP: price above VWAP, positive slope, few crosses
  if (pricePos > 0.005 && vwapSlope > 0.001 && crosses <= 2 && trendStrength > 0.005) {
    return { regime: "TREND_UP", score: Math.min(0.9, 0.6 + vwapSlope * 50), reason: "above_vwap_positive_slope" };
  }

  // TREND_DOWN: price below VWAP, negative slope, few crosses
  if (pricePos < -0.005 && vwapSlope < -0.001 && crosses <= 2 && trendStrength > 0.005) {
    return { regime: "TREND_DOWN", score: Math.min(0.9, 0.6 + Math.abs(vwapSlope) * 50), reason: "below_vwap_negative_slope" };
  }

  // RANGE: price oscillating around VWAP, low trend strength
  if (crosses >= 3 && crosses <= 6 && trendStrength < 0.008) {
    return { regime: "RANGE", score: 0.7, reason: `oscillating_vwap_crosses_${crosses}` };
  }

  // CHOP: high frequency crosses or unclear
  return { regime: "CHOP", score: 0.6, reason: `choppy_crosses_${crosses}` };
}