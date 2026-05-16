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
 * Calculate the current time bucket for a given coin and duration.
 * The slug timestamp must match Polymarket's ET-based window start.
 */
export function getTimeBucket(coin: Coin, minutes: number): TimeBucket {
  const now = new Date();

  // Convert to ET (UTC-4 during EDT, UTC-5 during EST)
  // Simple approach: subtract 4 or 5 hours and check which gives a valid date
  const isDst = now.getUTCMonth() + 1 > 3 && now.getUTCMonth() + 1 < 11;
  const etOffsetHours = isDst ? -4 : -5;
  const etMs = now.getTime() + etOffsetHours * 3600 * 1000;
  const etDate = new Date(etMs);

  if (minutes === 5) {
    const interval = 5 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    // Convert ET bucket start back to UTC timestamp for slug
    const slugTs = Math.floor((etBucketMs - etOffsetHours * 3600 * 1000) / 1000);
    return { slug: `${coin}-updown-5m-${slugTs}`, endTimestamp: slugTs + 5 * 60 };
  }

  if (minutes === 15) {
    const interval = 15 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    const slugTs = Math.floor((etBucketMs - etOffsetHours * 3600 * 1000) / 1000);
    return { slug: `${coin}-updown-15m-${slugTs}`, endTimestamp: slugTs + 15 * 60 };
  }

  if (minutes === 60) {
    const etHourStart = new Date(etDate);
    etHourStart.setUTCMinutes(0, 0, 0);
    const slugTs = Math.floor((etHourStart.getTime() - etOffsetHours * 3600 * 1000) / 1000);
    const slugPrefix = SLUG_PREFIX[coin][60];
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const month = monthNames[etHourStart.getUTCMonth()];
    const day = etHourStart.getUTCDate();
    let hour = etHourStart.getUTCHours();
    let timeStr = hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
    return { slug: `${slugPrefix}-${month}-${day}-${timeStr}-et`, endTimestamp: slugTs + 60 * 60 };
  }

  if (minutes === 240) {
    const interval = 4 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    const slugTs = Math.floor((etBucketMs - etOffsetHours * 3600 * 1000) / 1000);
    return { slug: `${coin}-updown-4h-${slugTs}`, endTimestamp: slugTs + 4 * 60 * 60 };
  }

  if (minutes === 1440) {
    const interval = 24 * 60 * 60 * 1000;
    const etDayStart = new Date(Math.floor(etDate.getTime() / interval) * interval);
    const slugTs = Math.floor((etDayStart.getTime() - etOffsetHours * 3600 * 1000) / 1000);
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    return {
      slug: `${SLUG_PREFIX[coin][1440]}-${monthNames[etDayStart.getUTCMonth()]}-${etDayStart.getUTCDate()}`,
      endTimestamp: slugTs + 24 * 60 * 60,
    };
  }

  throw new Error(`Unsupported minutes: ${minutes}`);
}

/**
 * Fetch token IDs for a given market slug via Gamma API
 * Tries /markets/slug/{slug} first, falls back to /events/slug/{slug}
 */
export async function fetchTokenIdsForSlug(slug: string): Promise<{
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
} | null> {
  // Try /markets/slug/{slug} first
  const url = `${GAMMA_API}/markets/slug/${slug}`;
  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as any;
      if (data.clobTokenIds && data.outcomes) {
        const outcomes: string[] = data.outcomes;
        const tokenIds: string[] = data.clobTokenIds;
        const upIdx = outcomes.indexOf("Up");
        const downIdx = outcomes.indexOf("Down");
        if (upIdx >= 0 && downIdx >= 0 && tokenIds[upIdx] && tokenIds[downIdx]) {
          return {
            upTokenId: tokenIds[upIdx],
            downTokenId: tokenIds[downIdx],
            conditionId: data.conditionId,
          };
        }
      }
    }
  } catch { /* fall through */ }

  // Fallback: try /events/slug/{slug} which embeds market data
  const eventUrl = `${GAMMA_API}/events/slug/${slug}`;
  try {
    const response = await fetch(eventUrl);
    if (response.ok) {
      const data = await response.json() as any;
      const market = data.markets?.[0];
      if (market?.clobTokenIds) {
        let tokenIds: string[];
        if (typeof market.clobTokenIds === "string") {
          tokenIds = JSON.parse(market.clobTokenIds);
        } else {
          tokenIds = market.clobTokenIds;
        }
        const outcomes: string[] = typeof market.outcomes === "string"
          ? JSON.parse(market.outcomes)
          : market.outcomes;
        const upIdx = outcomes.indexOf("Up");
        const downIdx = outcomes.indexOf("Down");
        if (upIdx >= 0 && downIdx >= 0 && tokenIds[upIdx] && tokenIds[downIdx]) {
          return {
            upTokenId: tokenIds[upIdx],
            downTokenId: tokenIds[downIdx],
            conditionId: market.conditionId,
          };
        }
      }
    }
  } catch { /* return null */ }

  return null;
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
 * Poll Polymarket prices for a specific coin + duration.
 * Returns prices or null if market not available or closed.
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
  marketClosed: boolean;
} | null> {
  const bucket = getTimeBucket(coin, minutes);
  const tokenIds = await fetchTokenIdsForSlug(bucket.slug);
  if (!tokenIds) return null;

  const prices = await fetchPrices(tokenIds);
  if (!prices) return null;

  // Also check if market is closed via Gamma API
  let marketClosed = false;
  try {
    const eventRes = await fetch(`${GAMMA_API}/events/slug/${bucket.slug}`);
    if (eventRes.ok) {
      const eventData = await eventRes.json() as any;
      marketClosed = eventData.closed === true;
    }
  } catch { /* ignore */ }

  return {
    slug: bucket.slug,
    endTimestamp: bucket.endTimestamp,
    upBid: prices.upBid,
    upAsk: prices.upAsk,
    downBid: prices.downBid,
    downAsk: prices.downAsk,
    marketClosed,
  };
}