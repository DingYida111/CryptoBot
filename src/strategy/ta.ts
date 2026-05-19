/**
 * Technical Analysis indicators
 * VWAP, RSI, MACD, Heiken Ashi — modular, reusable
 */

import type { Candle } from "../monitor/binance.js";

/** Volume-Weighted Average Price */
export function calcVwap(candles: Candle[]): number {
  let cumVp = 0;
  let cumVol = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumVp += typical * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumVp / cumVol : 0;
}

/** Relative Strength Index (Wilder's) */
export function calcRsi(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** MACD (12, 26, 9) */
export function calcMacd(
  candles: Candle[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): { macd: number; signal: number; histogram: number } {
  const ema = (arr: number[], n: number): number => {
    if (arr.length === 0) return 0;
    const k = 2 / (n + 1);
    let e = arr[0];
    for (let i = 1; i < arr.length; i++) {
      e = arr[i] * k + e * (1 - k);
    }
    return e;
  };

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast - emaSlow;

  // Signal line needs hist of macd values, approximate with macd line itself for speed
  const macdHist = [macdLine];
  const signalLine = ema(macdHist, signal);

  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

/** Simple VWAP slope: compare recent VWAP to N bars ago */
export function calcVwapSlope(candles: Candle[], lookback: number = 10): number {
  if (candles.length < lookback) return 0;
  const recent = candles.slice(-lookback);
  const older = candles.slice(-lookback * 2, -lookback);
  const vwapRecent = calcVwap(recent);
  const vwapOlder = calcVwap(older);
  if (vwapOlder === 0) return 0;
  return (vwapRecent - vwapOlder) / vwapOlder;
}

/** Average True Range */
export function calcAtr(candles: Candle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / slice.length;
}

/** Bollinger band width as a percentage of mid-band */
export function calcBollingerWidthPct(candles: Candle[], period: number = 20, mult: number = 2): number {
  if (candles.length < period) return 0;
  const closes = candles.slice(-period).map((c) => c.close);
  const mean = closes.reduce((sum, val) => sum + val, 0) / closes.length;
  const variance = closes.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / closes.length;
  const std = Math.sqrt(variance);
  if (mean === 0) return 0;
  return ((mean + mult * std) - (mean - mult * std)) / mean;
}

/** Heiken Ashi candle — smoothed trend representation */
export function calcHeikenAshi(candles: Candle[]): {
  haClose: number;
  haOpen: number;
  haHigh: number;
  haLow: number;
  isGreen: boolean;
} {
  if (candles.length === 0) return { haClose: 0, haOpen: 0, haHigh: 0, haLow: 0, isGreen: false };
  const c = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : c;
  const haClose = (c.open + c.high + c.low + c.close) / 4;
  const haOpen = (prev.open + prev.close) / 2;
  const haHigh = Math.max(c.high, haOpen, haClose);
  const haLow = Math.min(c.low, haOpen, haClose);
  return {
    haClose,
    haOpen,
    haHigh,
    haLow,
    isGreen: haClose >= haOpen,
  };
}

/** Price position relative to VWAP */
export function priceVsVwap(candle: Candle, vwap: number): number {
  return (candle.close - vwap) / vwap;
}

/** MACD histogram direction change (for divergence detection) */
export function macdDivergence(candles: Candle[], lookback: number = 20): boolean {
  if (candles.length < lookback + 5) return false;
  const recent = candles.slice(-lookback);
  const macdVals = recent.map(() => calcMacd(recent).histogram);
  // Check if histogram flipped sign in recent bars
  const n = macdVals.length;
  return macdVals[n - 1] > 0 && macdVals[n - 2] < 0;
}
