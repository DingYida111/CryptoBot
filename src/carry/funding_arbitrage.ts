export interface FundingArbitrageMarketSnapshot {
  readonly asOfMs: number;
  readonly spotInstId: string;
  readonly perpInstId: string;
  readonly spotBidPx: number;
  readonly spotAskPx: number;
  readonly spotBidSz: number;
  readonly spotAskSz: number;
  readonly perpBidPx: number;
  readonly perpAskPx: number;
  readonly perpBidSzContracts: number;
  readonly perpAskSzContracts: number;
  readonly fundingRate: number;
  readonly nextFundingTimeMs: number | null;
  readonly swapCtValBtc: number;
  readonly swapLotSzContracts: number;
  readonly spotLotSzBtc: number;
}

export interface FundingArbitrageConfig {
  readonly entryLeadMs: number;
  readonly maxPackageSizeBtc: number;
  readonly minUsefulPackageSizeBtc: number;
  readonly spotFeeRate: number;
  readonly perpFeeRate: number;
  readonly spotSlippageBps: number;
  readonly perpSlippageBps: number;
  readonly basisRiskBufferBps: number;
  readonly safetyBufferUsd: number;
  readonly requirePositiveFunding: boolean;
  readonly forceValidationEntry: boolean;
}

export interface FundingArbitrageOpportunity {
  readonly spotInstId: string;
  readonly perpInstId: string;
  readonly asOfMs: number;
  readonly nextFundingTimeMs: number | null;
  readonly entryWindowOpen: boolean;
  readonly forceValidationEntry: boolean;
  readonly fundingRate: number;
  readonly spotMidPx: number;
  readonly perpMidPx: number;
  readonly basisUsd: number;
  readonly basisBps: number;
  readonly candidateBtcSize: number;
  readonly candidateSwapContracts: number;
  readonly expectedFundingUsd: number;
  readonly expectedFeesUsd: number;
  readonly expectedSlippageUsd: number;
  readonly expectedBasisRiskBufferUsd: number;
  readonly netCarryEdgeUsd: number;
  readonly shouldEnter: boolean;
  readonly reason: string;
}

function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || value <= 0 || step <= 0) return 0;
  const units = Math.floor((value + 1e-12) / step);
  return units * step;
}

function roundContractsDown(value: number, lotSzContracts: number): number {
  return floorToStep(value, lotSzContracts);
}

export function computeBasisBps(spotMidPx: number, perpMidPx: number): number {
  if (!Number.isFinite(spotMidPx) || spotMidPx <= 0 || !Number.isFinite(perpMidPx) || perpMidPx <= 0) {
    return 0;
  }
  return ((perpMidPx - spotMidPx) / spotMidPx) * 10_000;
}

export function computeFundingArbitrageOpportunity(
  snapshot: FundingArbitrageMarketSnapshot,
  config: FundingArbitrageConfig
): FundingArbitrageOpportunity {
  const spotMidPx = (snapshot.spotBidPx + snapshot.spotAskPx) / 2;
  const perpMidPx = (snapshot.perpBidPx + snapshot.perpAskPx) / 2;
  const basisUsd = perpMidPx - spotMidPx;
  const basisBps = computeBasisBps(spotMidPx, perpMidPx);

  const entryWindowOpen = snapshot.nextFundingTimeMs !== null
    && snapshot.asOfMs >= snapshot.nextFundingTimeMs - config.entryLeadMs
    && snapshot.asOfMs <= snapshot.nextFundingTimeMs;

  const spotDepthLimitedBtc = Math.max(0, snapshot.spotAskSz);
  const perpDepthLimitedBtc = Math.max(0, snapshot.perpBidSzContracts) * snapshot.swapCtValBtc;
  const targetBtc = Math.min(config.maxPackageSizeBtc, spotDepthLimitedBtc, perpDepthLimitedBtc);
  const candidateSwapContracts = roundContractsDown(
    targetBtc / snapshot.swapCtValBtc,
    snapshot.swapLotSzContracts
  );
  const candidateBtcViaSwap = candidateSwapContracts * snapshot.swapCtValBtc;
  const candidateSpotBtc = floorToStep(candidateBtcViaSwap, snapshot.spotLotSzBtc);
  const candidateBtcSize = Math.min(candidateBtcViaSwap, candidateSpotBtc);

  const expectedFundingUsd = candidateBtcSize * perpMidPx * snapshot.fundingRate;
  const expectedFeesUsd =
    candidateBtcSize * spotMidPx * config.spotFeeRate
    + candidateBtcSize * perpMidPx * config.perpFeeRate;
  const expectedSlippageUsd =
    candidateBtcSize * spotMidPx * (config.spotSlippageBps / 10_000)
    + candidateBtcSize * perpMidPx * (config.perpSlippageBps / 10_000);
  const expectedBasisRiskBufferUsd =
    candidateBtcSize * perpMidPx * (config.basisRiskBufferBps / 10_000);
  const netCarryEdgeUsd =
    expectedFundingUsd - expectedFeesUsd - expectedSlippageUsd - expectedBasisRiskBufferUsd;

  const reasons: string[] = [];
  if (!entryWindowOpen && !config.forceValidationEntry) {
    reasons.push("outside_entry_window");
  }
  if (config.requirePositiveFunding && snapshot.fundingRate <= 0) {
    reasons.push("funding_not_positive");
  }
  if (candidateBtcSize < config.minUsefulPackageSizeBtc) {
    reasons.push("package_below_min_size");
  }
  if (netCarryEdgeUsd <= config.safetyBufferUsd) {
    reasons.push("net_edge_below_buffer");
  }

  const shouldEnter = reasons.length === 0
    || (config.forceValidationEntry
      && candidateBtcSize >= config.minUsefulPackageSizeBtc
      && snapshot.fundingRate > -0.01);

  return {
    spotInstId: snapshot.spotInstId,
    perpInstId: snapshot.perpInstId,
    asOfMs: snapshot.asOfMs,
    nextFundingTimeMs: snapshot.nextFundingTimeMs,
    entryWindowOpen,
    forceValidationEntry: config.forceValidationEntry,
    fundingRate: snapshot.fundingRate,
    spotMidPx,
    perpMidPx,
    basisUsd,
    basisBps,
    candidateBtcSize,
    candidateSwapContracts,
    expectedFundingUsd,
    expectedFeesUsd,
    expectedSlippageUsd,
    expectedBasisRiskBufferUsd,
    netCarryEdgeUsd,
    shouldEnter,
    reason: shouldEnter
      ? (reasons.length === 0 ? "enter" : `validation_override:${reasons.join("|")}`)
      : reasons.join("|"),
  };
}
