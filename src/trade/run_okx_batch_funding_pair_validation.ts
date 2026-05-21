import { fetchBtcFundingRate, fetchBtcSpotMeta, fetchBtcSpotTicker, fetchBtcSwapMeta, fetchBtcSwapTicker } from "../monitor/okx.js";
import { getAssetBalance, getPositions, getRecentFills, placeBatchOrders } from "./okx_trade.js";

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortContractsFromPositions(rows: Awaited<ReturnType<typeof getPositions>>): number {
  return rows
    .filter((row) => row.posSide === "short" || row.posSide === "net")
    .reduce((sum, row) => sum + Math.max(0, Number(row.pos) || 0), 0);
}

async function main(): Promise<void> {
  const contracts = Math.max(1, Math.floor(envNumber("BATCH_FUNDING_ARB_CONTRACTS", 1)));
  const holdMs = Math.max(1_000, envNumber("BATCH_FUNDING_ARB_HOLD_MS", 3_000));

  const [spotTicker, perpTicker, spotMeta, swapMeta, fundingBefore, btcBalanceBefore, perpPositionsBefore] = await Promise.all([
    fetchBtcSpotTicker(),
    fetchBtcSwapTicker(),
    fetchBtcSpotMeta(),
    fetchBtcSwapMeta(),
    fetchBtcFundingRate(),
    getAssetBalance("BTC"),
    getPositions("BTC-USDT-SWAP"),
  ]);

  if (!spotTicker || !perpTicker || !spotMeta || !swapMeta?.ctVal) {
    throw new Error("Missing market metadata for batch funding arbitrage validation");
  }

  const btcQty = contracts * swapMeta.ctVal;
  const spotQty = Math.floor((btcQty / spotMeta.lotSz) + 1e-12) * spotMeta.lotSz;
  if (spotQty <= 0) {
    throw new Error("Spot quantity rounded to zero");
  }

  const openOrders = [
    {
      instId: "BTC-USDT",
      tdMode: "cash" as const,
      side: "buy" as const,
      ordType: "market" as const,
      sz: String(spotQty),
      tgtCcy: "base_ccy" as const,
    },
    {
      instId: "BTC-USDT-SWAP",
      tdMode: "cross" as const,
      side: "sell" as const,
      posSide: "short" as const,
      ordType: "market" as const,
      sz: String(contracts),
    },
  ];

  const openAck = await placeBatchOrders(openOrders);
  if (!openAck || openAck.length !== 2) {
    throw new Error("Batch open failed");
  }

  await sleep(holdMs);

  const [btcBalanceMid, perpPositionsMid, spotFills, perpFills] = await Promise.all([
    getAssetBalance("BTC"),
    getPositions("BTC-USDT-SWAP"),
    getRecentFills("BTC-USDT", 5),
    getRecentFills("BTC-USDT-SWAP", 5),
  ]);

  const preEntrySpotAvail = btcBalanceBefore?.availBal ?? 0;
  const preEntryShortContracts = shortContractsFromPositions(perpPositionsBefore);
  const liveSpotQty = Math.max(
    0,
    Math.min(spotQty, (btcBalanceMid?.availBal ?? 0) - preEntrySpotAvail) - 0.00000001,
  );
  const liveShortContracts = Math.max(
    0,
    shortContractsFromPositions(perpPositionsMid) - preEntryShortContracts,
  );
  const closeOrders = [
    ...(liveSpotQty > 0
      ? [{
          instId: "BTC-USDT",
          tdMode: "cash" as const,
          side: "sell" as const,
          ordType: "market" as const,
          sz: liveSpotQty.toFixed(8),
          tgtCcy: "base_ccy" as const,
        }]
      : []),
    ...(liveShortContracts > 0
      ? [{
          instId: "BTC-USDT-SWAP",
          tdMode: "cross" as const,
          side: "buy" as const,
          posSide: "short" as const,
          ordType: "market" as const,
          sz: String(liveShortContracts),
          reduceOnly: true,
        }]
      : []),
  ];

  const closeAck = closeOrders.length > 0 ? await placeBatchOrders(closeOrders) : [];
  if (closeOrders.length > 0 && !closeAck) {
    throw new Error("Batch close failed");
  }

  await sleep(holdMs);

  const [btcBalanceAfter, perpPositionsAfter, fundingAfter] = await Promise.all([
    getAssetBalance("BTC"),
    getPositions("BTC-USDT-SWAP"),
    fetchBtcFundingRate(),
  ]);

  console.log(JSON.stringify({
    phase: "batch_funding_pair_validation",
    contracts,
    spotQty,
    market: {
      spotBidPx: spotTicker.bidPx,
      spotAskPx: spotTicker.askPx,
      perpBidPx: perpTicker.bidPx,
      perpAskPx: perpTicker.askPx,
      fundingBefore,
      fundingAfter,
    },
    balances: {
      btcBefore: btcBalanceBefore,
      btcMid: btcBalanceMid,
      btcAfter: btcBalanceAfter,
    },
    positions: {
      perpBefore: perpPositionsBefore,
      perpMid: perpPositionsMid,
      perpAfter: perpPositionsAfter,
    },
    openAck,
    closeOrders,
    closeAck,
    recentFills: {
      spotFills,
      perpFills,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
