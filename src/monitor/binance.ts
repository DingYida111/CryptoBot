/**
 * Binance REST API for K-line (OHLCV) data
 * Used for technical analysis indicators (VWAP, RSI, MACD, etc.)
 */

import { retryWithInstantRetry } from "../utils/retry.js";

const BINANCE_API = "https://api.binance.com";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/**
 * Fetch klines (OHLCV) for BTCUSDT
 * interval: 1m, 3m, 5m, 15m, 1h, 4h, 1d
 * limit: max 1000
 */
export async function fetchKlines(
  interval: string = "1m",
  limit: number = 100
): Promise<Candle[]> {
  return retryWithInstantRetry(
    async () => {
      const url = `${BINANCE_API}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
      const data = await res.json() as any[][];
      return data.map((d) => ({
        openTime: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
        closeTime: d[6],
      }));
    },
    "fetchKlines",
    { maxAttempts: 3, initialDelayMs: 500 }
  );
}

/**
 * Fetch latest BTCUSDT price
 */
export async function fetchBtcPrice(): Promise<number | null> {
  try {
    const url = `${BINANCE_API}/api/v3/ticker/price?symbol=BTCUSDT`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { price: string };
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

/**
 * Fetch recent klines and return the most recent close price
 */
export async function getRecentClose(interval: string = "1m", count: number = 1): Promise<number[]> {
  const candles = await fetchKlines(interval, count);
  return candles.map((c) => c.close);
}