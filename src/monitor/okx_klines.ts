/**
 * OKX REST API for K-line (OHLCV) data
 * Fallback when Binance is geo-restricted (e.g. from Silicon Valley node)
 * OKX public API — no auth required
 */

import { retryWithInstantRetry } from "../utils/retry.js";

const OKX_API = "https://www.okx.com";

export interface OkxCandle {
  ts: number;      // open time (ms)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch klines for BTC-USDT perpetual swap
 * bar: 1m, 3m, 5m, 15m, 1h, 4h, 1d
 * limit: max 100
 */
export async function fetchOkxKlines(
  bar: string = "1m",
  limit: number = 100
): Promise<OkxCandle[]> {
  return retryWithInstantRetry(
    async () => {
      const url = `${OKX_API}/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=${bar}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
      const data = await res.json() as { data?: string[][]; code?: string };
      if (data.code && data.code !== "0") throw new Error(`OKX API ${data.code}`);
      return (data.data ?? []).map((d) => ({
        ts: parseInt(d[0]),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
      }));
    },
    "fetchOkxKlines",
    { maxAttempts: 3, initialDelayMs: 500 }
  );
}

/**
 * Convert OKX candle to Binance-compatible format for TA module
 */
export function okxToBinanceCandle(okx: OkxCandle) {
  return {
    openTime: okx.ts,
    open: okx.open,
    high: okx.high,
    low: okx.low,
    close: okx.close,
    volume: okx.volume,
    closeTime: okx.ts + 60000,
  };
}