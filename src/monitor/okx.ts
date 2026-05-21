/**
 * OKX public market data helpers
 * Uses OKX public REST API (no auth required for market data)
 */

const OKX_PUBLIC_API = "https://www.okx.com";

export interface OkxTicker {
  instId: string;
  last: number;
  bidPx: number;
  askPx: number;
  bidSz: number;
  askSz: number;
  ts: number;
}

export interface OkxInstrumentMeta {
  tickSz: number;
  lotSz: number;
  minSz: number;
  ctVal?: number;
}

export interface OkxFundingRate {
  instId: string;
  fundingRate: number;
  nextFundingRate?: number | null;
  fundingTimeMs: number | null;
  nextFundingTimeMs: number | null;
  tsMs: number | null;
}

const instrumentMetaCache = new Map<string, { at: number; meta: OkxInstrumentMeta | null }>();

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function toNumberOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return null;
}

export async function fetchTicker(instId: string): Promise<OkxTicker | null> {
  try {
    const url = `${OKX_PUBLIC_API}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json() as any;
    const item = data?.data?.[0];
    if (data?.code !== "0" || !item) return null;

    const last = toPositiveNumber(item.last);
    const bidPx = toPositiveNumber(item.bidPx);
    const askPx = toPositiveNumber(item.askPx);
    if (last === null || bidPx === null || askPx === null) return null;

    return {
      instId,
      last,
      bidPx,
      askPx,
      bidSz: toNumberOrZero(item.bidSz),
      askSz: toNumberOrZero(item.askSz),
      ts: toNullableTimestampMs(item.ts) ?? Date.now(),
    };
  } catch {
    return null;
  }
}

export async function fetchFundingRate(instId: string): Promise<OkxFundingRate | null> {
  try {
    const url = `${OKX_PUBLIC_API}/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json() as any;
    const item = data?.data?.[0];
    if (data?.code !== "0" || !item) return null;

    return {
      instId,
      fundingRate: toNumberOrZero(item.fundingRate),
      nextFundingRate: item.nextFundingRate === undefined ? null : toNumberOrZero(item.nextFundingRate),
      fundingTimeMs: toNullableTimestampMs(item.fundingTime),
      nextFundingTimeMs: toNullableTimestampMs(item.nextFundingTime),
      tsMs: toNullableTimestampMs(item.ts),
    };
  } catch {
    return null;
  }
}

export async function fetchInstrumentMeta(
  instType: "SPOT" | "SWAP",
  instId: string
): Promise<OkxInstrumentMeta | null> {
  const cacheKey = `${instType}:${instId}`;
  const cached = instrumentMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) {
    return cached.meta;
  }

  try {
    const url = `${OKX_PUBLIC_API}/api/v5/public/instruments?instType=${instType}&instId=${encodeURIComponent(instId)}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json() as any;
    const item = data?.data?.[0];
    if (data?.code !== "0" || !item) return null;

    const meta: OkxInstrumentMeta = {
      tickSz: toPositiveNumber(item.tickSz) ?? 0,
      lotSz: toPositiveNumber(item.lotSz) ?? 0,
      minSz: toPositiveNumber(item.minSz) ?? 0,
      ctVal: instType === "SWAP" ? toPositiveNumber(item.ctVal) ?? undefined : undefined,
    };
    if (![meta.tickSz, meta.lotSz, meta.minSz].every((v) => Number.isFinite(v) && v > 0)) return null;
    if (instType === "SWAP" && (!meta.ctVal || !Number.isFinite(meta.ctVal) || meta.ctVal <= 0)) return null;

    instrumentMetaCache.set(cacheKey, { at: Date.now(), meta });
    return meta;
  } catch {
    return null;
  }
}

/**
 * Fetch current BTC/USDT perpetual swap price from OKX
 * Returns the last traded price
 */
export async function fetchBtcPrice(): Promise<number | null> {
  const ticker = await fetchTicker("BTC-USDT-SWAP");
  return ticker?.last ?? null;
}

export async function fetchBtcSwapMeta(): Promise<OkxInstrumentMeta | null> {
  return fetchInstrumentMeta("SWAP", "BTC-USDT-SWAP");
}

export async function fetchBtcSpotMeta(): Promise<OkxInstrumentMeta | null> {
  return fetchInstrumentMeta("SPOT", "BTC-USDT");
}

export async function fetchBtcSpotTicker(): Promise<OkxTicker | null> {
  return fetchTicker("BTC-USDT");
}

export async function fetchBtcSwapTicker(): Promise<OkxTicker | null> {
  return fetchTicker("BTC-USDT-SWAP");
}

export async function fetchBtcFundingRate(): Promise<OkxFundingRate | null> {
  return fetchFundingRate("BTC-USDT-SWAP");
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
