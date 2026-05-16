/**
 * OKX price fetcher for BTC perpetuals
 * Uses OKX public REST API (no auth required for market data)
 */

const OKX_PUBLIC_API = "https://www.okx.com";

/**
 * Fetch current BTC/USDT perpetual swap price from OKX
 * Returns the last traded price
 */
export async function fetchBtcPrice(): Promise<number | null> {
  try {
    // OKX public endpoint for BTC/USDT perpetuals ticker
    const url = `${OKX_PUBLIC_API}/api/v5/market/ticker?instId=BTC-USDT-SWAP`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json() as any;
    if (data.code !== "0" || !data.data?.length) return null;

    const ticker = data.data[0];
    const last = parseFloat(ticker.last);
    if (!Number.isFinite(last) || last <= 0) return null;

    return last;
  } catch {
    return null;
  }
}

/**
 * Fetch OHLCV k-line data for BTC perpetuals
 * Useful for backtesting and analysis
 */
export async function fetchKlines(
  bar: "1m" | "3m" | "5m" | "15m" | "1H" | "2H" | "4H" | "6H" | "12H" | "1D" | "2D" | "3D" | "1W" = "15m",
  limit: number = 100
): Promise<Array<{
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> | null> {
  try {
    const url = `${OKX_PUBLIC_API}/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=${bar}&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json() as any;
    if (data.code !== "0" || !data.data) return null;

    // OKX returns newest first, we want chronological order
    return data.data.map((k: any[]) => ({
      timestamp: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    })).reverse();
  } catch {
    return null;
  }
}