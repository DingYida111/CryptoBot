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
 * Get current time in US/Eastern timezone using the IANA tz database.
 * Correctly handles DST transitions without hardcoded month arithmetic.
 * Returns an etDate whose UTC fields mirror ET wall-clock fields (for arithmetic),
 * plus etOffsetMs = etDate.getTime() - now.getTime() (i.e. ET_ms - UTC_ms).
 */
function getEasternDate(): { etDate: Date; etOffsetMs: number } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now)
      .filter(p => p.type !== "literal")
      .map(p => [p.type, p.value])
  );
  // Treat ET wall-clock as if it were UTC (for floor/interval arithmetic)
  const etDate = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`
  );
  const etOffsetMs = etDate.getTime() - now.getTime();
  return { etDate, etOffsetMs };
}

/**
 * Calculate the current time bucket for a given coin and duration.
 * The slug timestamp must match Polymarket's ET-based window start.
 */
export function getTimeBucket(coin: Coin, minutes: number): TimeBucket {
  const { etDate, etOffsetMs } = getEasternDate();

  if (minutes === 5) {
    const interval = 5 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    // Convert ET bucket start back to real UTC milliseconds, then to seconds
    const slugTs = Math.floor((etBucketMs - etOffsetMs) / 1000);
    return { slug: `${coin}-updown-5m-${slugTs}`, endTimestamp: slugTs + 5 * 60 };
  }

  if (minutes === 15) {
    const interval = 15 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    const slugTs = Math.floor((etBucketMs - etOffsetMs) / 1000);
    return { slug: `${coin}-updown-15m-${slugTs}`, endTimestamp: slugTs + 15 * 60 };
  }

  if (minutes === 60) {
    const etHourStart = new Date(etDate);
    etHourStart.setUTCMinutes(0, 0, 0);
    const slugTs = Math.floor((etHourStart.getTime() - etOffsetMs) / 1000);
    const slugPrefix = SLUG_PREFIX[coin][60];
    const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const month = monthNames[etHourStart.getUTCMonth()];
    const day = etHourStart.getUTCDate();
    const hour = etHourStart.getUTCHours();
    const timeStr = hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`;
    return { slug: `${slugPrefix}-${month}-${day}-${timeStr}-et`, endTimestamp: slugTs + 60 * 60 };
  }

  if (minutes === 240) {
    const interval = 4 * 60 * 60 * 1000;
    const etBucketMs = Math.floor(etDate.getTime() / interval) * interval;
    const slugTs = Math.floor((etBucketMs - etOffsetMs) / 1000);
    return { slug: `${coin}-updown-4h-${slugTs}`, endTimestamp: slugTs + 4 * 60 * 60 };
  }

  if (minutes === 1440) {
    const interval = 24 * 60 * 60 * 1000;
    const etDayStart = new Date(Math.floor(etDate.getTime() / interval) * interval);
    const slugTs = Math.floor((etDayStart.getTime() - etOffsetMs) / 1000);
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
 * Fetch prices for UP and DOWN tokens.
 *
 * Primary: use CLOB /prices endpoint with token_id.
 * Fallback: extract outcomePrices from Gamma API /events/slug response.
 * The CLOB /prices endpoint returns "Invalid payload" for certain token
 * types (e.g. share tokens) — Gamma API outcomePrices handles those cases.
 */
export async function fetchPrices(tokenIds: {
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
  slug: string;
}): Promise<{
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
} | null> {
  const { upTokenId, downTokenId } = tokenIds;

  // Try CLOB /prices first
  const [upPrices, downPrices] = await Promise.all([
    fetchClobPrices(upTokenId),
    fetchClobPrices(downTokenId),
  ]);

  if (upPrices && downPrices) {
    return {
      upBid: upPrices.bid,
      upAsk: upPrices.ask,
      downBid: downPrices.bid,
      downAsk: downPrices.ask,
    };
  }

  // Fallback: extract from Gamma API /events/slug (outcomePrices)
  // outcomePrices[0] = YES/Up, outcomePrices[1] = NO/Down
  try {
    const eventRes = await fetch(`${GAMMA_API}/events/slug/${tokenIds.slug}`);
    if (eventRes.ok) {
      const data = await eventRes.json() as any;
      const market = data.markets?.[0];
      if (market?.outcomePrices) {
        let prices: string[];
        if (typeof market.outcomePrices === "string") {
          prices = JSON.parse(market.outcomePrices);
        } else {
          prices = market.outcomePrices;
        }
        // outcomePrices format: ["0.505","0.495"] where [0]=Up, [1]=Down
        const upPrice = parseFloat(prices[0]);
        const downPrice = parseFloat(prices[1]);
        if (!isNaN(upPrice) && !isNaN(downPrice)) {
          return {
            upBid: upPrice,
            upAsk: upPrice,
            downBid: downPrice,
            downAsk: downPrice,
          };
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

async function fetchClobPrices(tokenId: string): Promise<{ bid: number; ask: number } | null> {
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

  // Check market closed state from Gamma API (needed for fetchPrices fallback too)
  let marketClosed = false;
  let eventData: any = null;
  try {
    const eventRes = await fetch(`${GAMMA_API}/events/slug/${bucket.slug}`);
    if (eventRes.ok) {
      eventData = await eventRes.json();
      marketClosed = eventData.closed === true;
    }
  } catch { /* ignore */ }

  const prices = await fetchPrices({ ...tokenIds, slug: bucket.slug });
  if (!prices) return null;

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