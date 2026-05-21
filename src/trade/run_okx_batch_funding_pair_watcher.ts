import { computeFundingArbitrageOpportunity, type FundingArbitrageConfig } from "../carry/funding_arbitrage.js";
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

function buildCarryConfig(): FundingArbitrageConfig {
  return {
    entryLeadMs: envNumber("BATCH_FUNDING_ARB_ENTRY_LEAD_MS", 120_000),
    maxPackageSizeBtc: envNumber("BATCH_FUNDING_ARB_MAX_PACKAGE_BTC", 0.01),
    minUsefulPackageSizeBtc: envNumber("BATCH_FUNDING_ARB_MIN_PACKAGE_BTC", 0.01),
    spotFeeRate: envNumber("BATCH_FUNDING_ARB_SPOT_FEE_RATE", 0.001),
    perpFeeRate: envNumber("BATCH_FUNDING_ARB_PERP_FEE_RATE", 0.0005),
    spotSlippageBps: envNumber("BATCH_FUNDING_ARB_SPOT_SLIPPAGE_BPS", 5),
    perpSlippageBps: envNumber("BATCH_FUNDING_ARB_PERP_SLIPPAGE_BPS", 5),
    basisRiskBufferBps: envNumber("BATCH_FUNDING_ARB_BASIS_BUFFER_BPS", 8),
    safetyBufferUsd: envNumber("BATCH_FUNDING_ARB_SAFETY_BUFFER_USD", 1),
    requirePositiveFunding: true,
    forceValidationEntry: false,
  };
}

async function executeBatchPackage(contracts: number, holdMs: number) {
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
    throw new Error("Missing market metadata for batch funding arbitrage execution");
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

  return {
    phase: "batch_funding_pair_execution",
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
  };
}

async function main(): Promise<void> {
  const carryConfig = buildCarryConfig();
  const holdMs = Math.max(1_000, envNumber("BATCH_FUNDING_ARB_HOLD_MS", 3_000));
  const outsideWindowPollMs = Math.max(5_000, envNumber("BATCH_FUNDING_ARB_POLL_MS", 60_000));
  const insideWindowPollMs = Math.max(2_000, envNumber("BATCH_FUNDING_ARB_WINDOW_POLL_MS", 5_000));
  const postFundingGraceMs = Math.max(10_000, envNumber("BATCH_FUNDING_ARB_POST_FUNDING_GRACE_MS", 60_000));

  while (true) {
    const [spotTicker, perpTicker, spotMeta, swapMeta, funding] = await Promise.all([
      fetchBtcSpotTicker(),
      fetchBtcSwapTicker(),
      fetchBtcSpotMeta(),
      fetchBtcSwapMeta(),
      fetchBtcFundingRate(),
    ]);

    if (!spotTicker || !perpTicker || !spotMeta || !swapMeta?.ctVal || !funding) {
      console.log(JSON.stringify({
        phase: "watch",
        status: "market_data_unavailable",
        at: new Date().toISOString(),
      }));
      await sleep(outsideWindowPollMs);
      continue;
    }

    const snapshot = {
      asOfMs: Date.now(),
      spotInstId: "BTC-USDT",
      perpInstId: "BTC-USDT-SWAP",
      spotBidPx: spotTicker.bidPx,
      spotAskPx: spotTicker.askPx,
      spotBidSz: spotTicker.bidSz,
      spotAskSz: spotTicker.askSz,
      perpBidPx: perpTicker.bidPx,
      perpAskPx: perpTicker.askPx,
      perpBidSzContracts: perpTicker.bidSz,
      perpAskSzContracts: perpTicker.askSz,
      fundingRate: funding.fundingRate,
      nextFundingTimeMs: funding.nextFundingTimeMs,
      swapCtValBtc: swapMeta.ctVal,
      swapLotSzContracts: swapMeta.lotSz,
      spotLotSzBtc: spotMeta.lotSz,
    } as const;
    const opportunity = computeFundingArbitrageOpportunity(snapshot, carryConfig);

    console.log(JSON.stringify({
      phase: "watch",
      at: new Date(snapshot.asOfMs).toISOString(),
      fundingRate: opportunity.fundingRate,
      nextFundingTimeMs: opportunity.nextFundingTimeMs,
      entryWindowOpen: opportunity.entryWindowOpen,
      shouldEnter: opportunity.shouldEnter,
      reason: opportunity.reason,
      candidateBtcSize: opportunity.candidateBtcSize,
      candidateSwapContracts: opportunity.candidateSwapContracts,
      expectedFundingUsd: opportunity.expectedFundingUsd,
      netCarryEdgeUsd: opportunity.netCarryEdgeUsd,
    }));

    if (opportunity.shouldEnter && opportunity.candidateSwapContracts > 0) {
      const result = await executeBatchPackage(opportunity.candidateSwapContracts, holdMs);
      console.log(JSON.stringify({
        phase: "executed",
        opportunity,
        result,
      }, null, 2));
      return;
    }

    if (
      opportunity.nextFundingTimeMs !== null
      && snapshot.asOfMs > opportunity.nextFundingTimeMs + postFundingGraceMs
    ) {
      console.log(JSON.stringify({
        phase: "missed_or_no_opportunity",
        at: new Date(snapshot.asOfMs).toISOString(),
        nextFundingTimeMs: opportunity.nextFundingTimeMs,
        reason: opportunity.reason,
      }, null, 2));
      return;
    }

    await sleep(opportunity.entryWindowOpen ? insideWindowPollMs : outsideWindowPollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
