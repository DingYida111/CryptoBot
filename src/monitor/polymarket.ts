/**
 * Polymarket CLOB price fetcher
 * Uses public endpoints - no authentication required for price data
 */

import type { Coin, TimeBucket } from "../types.js";

// Polymarket API endpoints
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// Known slug prefixes per coin
const SLUG_PREFIX: Record<Coin, Record<number, string>> = {
  btc: {
    5: "btc-updown-5m",
    15: "btc-updown-15m",
    60: "bitcoin-up-or-down",
    240: "btc-updown-4h",
    1440: "bitcoin-up-or-down-on",
  },
  eth: {
    15: "eth-updown-15m",
    60: "ethereum-up-or-down",
    240: "eth-updown-4h",
    1440: "ethereum-up-or-down-on",
  },
  sol: {
    15: "sol-updown-15m",
    60: "solana-up-or-down",
    240: "sol-updown-4h",
    1440: "solana-up-or-down-on",
  },
  xrp: {
    15: "xrp-updown-15m",
    60: "xrp-up-or-down",
    240: "xrp-updown-4h",
    1440: "xrp-up-or-down-on",
  },
};

/**
 * Calculate the current time bucket for a given coin and duration
 */
export function getTimeBucket(coin: Coin, minutes: number): TimeBucket {
  const now = Math.floor(Date.now() / 1000);

  if (minutes === 5) {
    const interval = 5 * 60;
    const start = Math.floor(now / interval) * interval;
    return { slug: `${coin}-updown-5m-${start}`, endTimestamp: start + interval };
  }

  if (minutes === 15) {
    const interval = 15 * 60;
    const start = Math.floor(now / interval) * interval;
    return { slug: `${coin}-updown-15m-${start}`, endTimestamp: start + interval };
  }

  if (minutes === 60) {
    const interval = 60 * 60;
    const nowDate = new Date();
    const isDst = nowDate.getUTCMonth() + 1 > 3 && nowDate.getUTCMonth() + 1 < 11;
    const offsetHours = isDst ? -4 : -5;
    const etTime = new Date(nowDate.getTime() + offsetHours * 3600 * 1000);
    const etHourStart = new Date(etTime);
    etHourStart.setUTCMinutes(0, 0, 0);
    const utcHourStart = new Date(etHourStart.getTime() - offsetHours * 3600 * 1000);
    const start = Math.floor(utcHourStart.getTime() / 1000);
    const slugPrefix = SLUG_PREFIX[coin][60];
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const month = monthNames[etHourStart.getUTCMonth()];
    const day = etHourStart.getUTCDate();
    let hour = etHourStart.getUTCHours();
    let timeStr = hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
    return { slug: `${slugPrefix}-${month}-${day}-${timeStr}-et`, endTimestamp: start + interval };
  }

  if (minutes === 240) {
    const interval = 4 * 60 * 60;
    const offset = 1 * 60 * 60;
    const adjusted = now - offset;
    const start = Math.floor(adjusted / interval) * interval + offset;
    return { slug: `${coin}-updown-4h-${start}`, endTimestamp: start + interval };
  }

  if (minutes === 1440) {
    const interval = 24 * 60 * 60;
    const start = Math.floor(now / interval) * interval;
    const nowDate = new Date(start * 1000);
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    return {
      slug: `${SLUG_PREFIX[coin][1440]}-${monthNames[nowDate.getUTCMonth()]}-${nowDate.getUTCDate()}`,
      endTimestamp: start + interval,
    };
  }

  throw new Error(`Unsupported minutes: ${minutes}`);
}

/**
 * Fetch token IDs for a given market slug via Gamma API
 */
export async function fetchTokenIdsForSlug(slug: string): Promise<{
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
} | null> {
  const url = `${GAMMA_API}/markets/slug/${slug}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json() as any;
  if (!data.clobTokenIds || !data.outcomes) return null;

  const outcomes: string[] = data.outcomes;
  const tokenIds: string[] = data.clobTokenIds;
  const upIdx = outcomes.indexOf("Up");
  const downIdx = outcomes.indexOf("Down");
  if (upIdx < 0 || downIdx < 0) return null;
  if (!tokenIds[upIdx] || !tokenIds[downIdx]) return null;

  return {
    upTokenId: tokenIds[upIdx],
    downTokenId: tokenIds[downIdx],
    conditionId: data.conditionId,
  };
}

/**
 * Fetch current prices for UP and DOWN tokens
 */
export async function fetchPrices(tokenIds: {
  upTokenId: string;
  downTokenId: string;
}): Promise<{
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
} | null> {
  const { upTokenId, downTokenId } = tokenIds;

  // Fetch both prices in parallel
  const [upPrices, downPrices] = await Promise.all([
    fetchTokenPrices(upTokenId),
    fetchTokenPrices(downTokenId),
  ]);

  if (!upPrices && !downPrices) return null;

  return {
    upBid: upPrices?.bid ?? null,
    upAsk: upPrices?.ask ?? null,
    downBid: downPrices?.bid ?? null,
    downAsk: downPrices?.ask ?? null,
  };
}

async function fetchTokenPrices(tokenId: string): Promise<{ bid: number; ask: number } | null> {
  try {
    const url = `${CLOB_API}/prices?token_id=${tokenId}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json() as any;
    if (!data.bids?.length || !data.asks?.length) return null;
    return {
      bid: parseFloat(data.bids[0].price),
      ask: parseFloat(data.asks[0].price),
    };
  } catch {
    return null;
  }
}

/**
 * Poll Polymarket prices for a specific coin + duration
 * Returns prices or null if market not available
 */
export async function pollPolymarket(
  coin: Coin,
  minutes: number
): Promise<{
  slug: string;
  endTimestamp: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
} | null> {
  const bucket = getTimeBucket(coin, minutes);
  const tokenIds = await fetchTokenIdsForSlug(bucket.slug);
  if (!tokenIds) return null;

  const prices = await fetchPrices(tokenIds);
  if (!prices) return null;

  return {
    slug: bucket.slug,
    endTimestamp: bucket.endTimestamp,
    ...prices,
  };
}