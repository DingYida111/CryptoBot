import { computeFundingArbitrageOpportunity, type FundingArbitrageConfig, type FundingArbitrageOpportunity } from "../carry/funding_arbitrage.js";
import { fetchFundingRate, fetchInstrumentMeta, fetchTicker } from "../monitor/okx.js";
import { insertFundingArbEvent, insertFundingArbOpportunity, insertPortfolioSnapshot } from "../monitor/storage.js";
import { computeExposure, toInstrumentSpecMap } from "../portfolio/exposure.js";
import { buildBtcSpotInstrumentSpecFromMeta, buildBtcSwapInstrumentSpecFromMeta } from "../portfolio/instrument_spec.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX } from "../portfolio/security_spec.js";
import { buildPortfolioStateFromFundingArb, fundingArbPositionsToInstrumentPositions } from "../portfolio/adapters/funding_arbitrage_adapter.js";
import {
  buySpot,
  getAssetBalance,
  getPositions,
  placeOrder,
  sellDown,
  sellSpot,
  type OrderResult,
} from "../trade/okx_trade.js";
import type {
  ManagedStrategyController,
  ManagedStrategyDefinition,
  ManagedStrategyInstanceConfig,
  ManagedStrategySnapshot,
  ManagedStrategyStartResult,
  ManagedStrategySyncResult,
} from "./managed_strategies.js";

const FUNDING_ARB_PORTFOLIO_VERSION = "funding-arb-v1";

type FundingPhase =
  | "idle"
  | "await_entry_window"
  | "evaluating_entry"
  | "entering"
  | "holding_for_funding"
  | "unwinding"
  | "completed"
  | "aborted";

interface FundingPackageState {
  readonly spotInstId: string;
  readonly perpInstId: string;
  readonly spotQtyBtc: number;
  readonly swapContracts: number;
  readonly preEntrySpotAvailBtc: number;
  readonly preEntryShortContracts: number;
  readonly entryMode: "standard" | "validation_override";
  readonly openedAtMs: number;
  readonly targetFundingTimeMs: number | null;
  readonly spotOrdId?: string | null;
  readonly perpOrdId?: string | null;
}

interface FundingRuntimeState {
  phase: FundingPhase;
  packageState: FundingPackageState | null;
  lastOpportunity: FundingArbitrageOpportunity | null;
  lastReason: string;
  validationCycleCompleted: boolean;
}

const DEFINITION: ManagedStrategyDefinition = {
  type: "local_funding_arbitrage",
  backend: "local",
  venue: "cryptobot",
  label: "Local Funding Arbitrage",
  description: "CryptoBot-managed BTC spot + perp funding capture strategy.",
  supportsRemotePnl: false,
  parameters: [],
};

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function toString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function shortContractsFromPositions(rows: Awaited<ReturnType<typeof getPositions>>): number {
  return rows
    .filter((row) => row.posSide === "short" || row.posSide === "net")
    .reduce((sum, row) => sum + Math.max(0, Number(row.pos) || 0), 0);
}

function toConfig(instance: ManagedStrategyInstanceConfig): FundingArbitrageConfig {
  return {
    entryLeadMs: toNumber(instance.parameters.entryLeadMs, 120_000),
    maxPackageSizeBtc: toNumber(instance.parameters.maxPackageSizeBtc, 0.01),
    minUsefulPackageSizeBtc: toNumber(instance.parameters.minUsefulPackageSizeBtc, 0.01),
    spotFeeRate: toNumber(instance.parameters.spotFeeRate, 0.001),
    perpFeeRate: toNumber(instance.parameters.perpFeeRate, 0.0005),
    spotSlippageBps: toNumber(instance.parameters.spotSlippageBps, 5),
    perpSlippageBps: toNumber(instance.parameters.perpSlippageBps, 5),
    basisRiskBufferBps: toNumber(instance.parameters.basisRiskBufferBps, 8),
    safetyBufferUsd: toNumber(instance.parameters.safetyBufferUsd, 1),
    requirePositiveFunding: true,
    forceValidationEntry: toBoolean(instance.parameters.forceValidationEntry, false),
  };
}

function emptyState(): FundingRuntimeState {
  return {
    phase: "idle",
    packageState: null,
    lastOpportunity: null,
    lastReason: "idle",
    validationCycleCompleted: false,
  };
}

async function safeFlattenShortPerp(instId: string, contracts: number): Promise<OrderResult | null> {
  if (contracts <= 0) return null;
  return placeOrder({
    instId,
    tdMode: "cross",
    side: "buy",
    posSide: "short",
    ordType: "market",
    sz: String(contracts),
    reduceOnly: true,
  });
}

function toPortfolioTimestamp(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class LocalFundingArbitrageController implements ManagedStrategyController {
  readonly definition = DEFINITION;
  private readonly states = new Map<string, FundingRuntimeState>();

  private getState(instanceId: string): FundingRuntimeState {
    const existing = this.states.get(instanceId);
    if (existing) return existing;
    const created = emptyState();
    this.states.set(instanceId, created);
    return created;
  }

  private async recordEvent(
    config: ManagedStrategyInstanceConfig,
    phase: string,
    payload: Record<string, unknown>,
    packageState: FundingPackageState | null,
  ): Promise<void> {
    const spotInstId = packageState?.spotInstId ?? toString(config.parameters.spotInstId, "BTC-USDT");
    const perpInstId = packageState?.perpInstId ?? toString(config.parameters.perpInstId, "BTC-USDT-SWAP");
    insertFundingArbEvent({
      source: "local_funding_arbitrage",
      instanceId: config.instanceId,
      phase,
      spotInstId,
      perpInstId,
      spotOrdId: packageState?.spotOrdId ?? null,
      perpOrdId: packageState?.perpOrdId ?? null,
      packageBtcSize: packageState?.spotQtyBtc ?? null,
      swapContracts: packageState?.swapContracts ?? null,
      rawJson: JSON.stringify(payload),
      createdAt: Date.now(),
    });
  }

  private persistPortfolioArtifacts(input: {
    now: number;
    state: FundingRuntimeState;
    opportunity: FundingArbitrageOpportunity;
    paperExecute: boolean;
    spotMetaLotSz: number;
    swapMetaCtVal: number;
    currentSpotBtc: number;
    currentShortContracts: number;
    currentShortBtc: number;
    netDeltaBtc: number;
    usdtCashBalance: number;
  }): void {
    const spotSpec = buildBtcSpotInstrumentSpecFromMeta({
      tickSz: 0,
      lotSz: input.spotMetaLotSz,
      minSz: input.spotMetaLotSz,
    });
    const swapSpec = buildBtcSwapInstrumentSpecFromMeta({
      tickSz: 0,
      lotSz: 1,
      minSz: 1,
      ctVal: input.swapMetaCtVal,
    });
    const instrumentPositions = fundingArbPositionsToInstrumentPositions({
      spotBtc: input.currentSpotBtc,
      shortContracts: input.currentShortContracts,
    });
    const securityExposures = computeExposure(
      instrumentPositions,
      toInstrumentSpecMap([spotSpec, swapSpec]),
    );
    const portfolioState = buildPortfolioStateFromFundingArb({
      asOfMs: input.now,
      instrumentPositions,
      securityExposures,
      cashBalances: {
        BTC: input.currentSpotBtc,
        USDT: input.usdtCashBalance,
      },
      metadata: {
        phase: input.state.phase,
        lastReason: input.state.lastReason,
        paperExecute: input.paperExecute,
        spotInstId: input.opportunity.spotInstId,
        perpInstId: input.opportunity.perpInstId,
        currentSpotBtc: input.currentSpotBtc,
        currentShortContracts: input.currentShortContracts,
        currentShortBtc: input.currentShortBtc,
        netDeltaBtc: input.netDeltaBtc,
        fundingRate: input.opportunity.fundingRate,
        nextFundingTimeMs: toPortfolioTimestamp(input.opportunity.nextFundingTimeMs),
        basisBps: input.opportunity.basisBps,
        basisUsd: input.opportunity.basisUsd,
        netCarryEdgeUsd: input.opportunity.netCarryEdgeUsd,
        expectedFundingUsd: input.opportunity.expectedFundingUsd,
        expectedFeesUsd: input.opportunity.expectedFeesUsd,
        expectedSlippageUsd: input.opportunity.expectedSlippageUsd,
        expectedBasisRiskBufferUsd: input.opportunity.expectedBasisRiskBufferUsd,
        entryWindowOpen: input.opportunity.entryWindowOpen,
        shouldEnter: input.opportunity.shouldEnter,
        forceValidationEntry: input.opportunity.forceValidationEntry,
      },
    });

    insertPortfolioSnapshot({
      source: "local_funding_arbitrage",
      shadowVersion: FUNDING_ARB_PORTFOLIO_VERSION,
      instId: `${input.opportunity.spotInstId}|${input.opportunity.perpInstId}`,
      positionContracts: -input.currentShortContracts,
      btcDelta: portfolioState.securityExposures[BTC_DELTA] ?? 0,
      fundingExposure: portfolioState.securityExposures[BTC_PERP_FUNDING_OKX] ?? 0,
      regime: input.state.phase,
      rawJson: JSON.stringify({
        portfolioState,
        opportunity: input.opportunity,
        packageState: input.state.packageState,
      }),
      createdAt: input.now,
    });
  }

  async start(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategyStartResult> {
    const state = this.getState(config.instanceId);
    state.phase = "await_entry_window";
    state.lastReason = "started";
    state.validationCycleCompleted = false;
    await this.recordEvent(config, "start", { note: "controller_started" }, state.packageState);
    return {
      state: "running",
      raw: { phase: state.phase },
    };
  }

  async stop(config: ManagedStrategyInstanceConfig): Promise<void> {
    const state = this.getState(config.instanceId);
    if (state.packageState) {
      const [btcBalance, perpPositions] = await Promise.all([
        getAssetBalance("BTC"),
        getPositions(state.packageState.perpInstId),
      ]);
      const liveSpotAvail = btcBalance?.availBal ?? 0;
      const liveShortContracts = shortContractsFromPositions(perpPositions);
      const unwindSpotQty = Math.max(
        0,
        Math.min(
          state.packageState.spotQtyBtc,
          liveSpotAvail - state.packageState.preEntrySpotAvailBtc,
        ) - 0.00000001,
      );
      const unwindShortContracts = Math.max(
        0,
        liveShortContracts - state.packageState.preEntryShortContracts,
      );
      if (unwindSpotQty > 0) {
        await sellSpot(state.packageState.spotInstId, unwindSpotQty.toFixed(8));
      }
      await safeFlattenShortPerp(state.packageState.perpInstId, unwindShortContracts);
      await this.recordEvent(config, "stop_unwind", { note: "strategy_stop_unwind" }, state.packageState);
    }
    state.phase = "completed";
    state.packageState = null;
    state.lastReason = "stopped";
  }

  async sync(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategySyncResult> {
    const state = this.getState(config.instanceId);
    const now = Date.now();
    const paperExecute = toBoolean(config.parameters.paperExecute, false);
    const maxHoldMs = toNumber(config.parameters.maxHoldMs, 300_000);
    const maxNetDeltaToleranceBtc = toNumber(config.parameters.maxNetDeltaToleranceBtc, 0.002);
    const spotInstId = toString(config.parameters.spotInstId, "BTC-USDT");
    const perpInstId = toString(config.parameters.perpInstId, "BTC-USDT-SWAP");
    const carryConfig = toConfig(config);

    const [spotTicker, perpTicker, funding, spotMeta, swapMeta, btcBalance, usdtBalance, perpPositions] = await Promise.all([
      fetchTicker(spotInstId),
      fetchTicker(perpInstId),
      fetchFundingRate(perpInstId),
      fetchInstrumentMeta("SPOT", spotInstId),
      fetchInstrumentMeta("SWAP", perpInstId),
      getAssetBalance("BTC"),
      getAssetBalance("USDT"),
      getPositions(perpInstId),
    ]);

    if (!spotTicker || !perpTicker || !funding || !spotMeta || !swapMeta?.ctVal) {
      state.phase = "aborted";
      state.lastReason = "market_data_unavailable";
      const snapshot = this.toSnapshot(config, state, null, [], [], {
        error: "market_data_unavailable",
      });
      return { snapshot: { ...snapshot, state: "error" }, rawDetail: snapshot.detail, subOrders: [], positions: [] };
    }
    const swapCtVal = swapMeta.ctVal;

    let currentSpotBtc = btcBalance?.cashBal ?? 0;
    let currentSpotAvailBtc = btcBalance?.availBal ?? 0;
    let currentUsdtCash = usdtBalance?.cashBal ?? 0;
    let currentShortContracts = shortContractsFromPositions(perpPositions);
    let currentShortBtc = currentShortContracts * swapCtVal;
    let netDeltaBtc = currentSpotBtc - currentShortBtc;
    let livePerpPositions = perpPositions;

    const refreshLiveState = async (): Promise<void> => {
      const [freshBtcBalance, freshUsdtBalance, freshPerpPositions] = await Promise.all([
        getAssetBalance("BTC"),
        getAssetBalance("USDT"),
        getPositions(perpInstId),
      ]);
      currentSpotBtc = freshBtcBalance?.cashBal ?? 0;
      currentSpotAvailBtc = freshBtcBalance?.availBal ?? 0;
      currentUsdtCash = freshUsdtBalance?.cashBal ?? 0;
      currentShortContracts = shortContractsFromPositions(freshPerpPositions);
      currentShortBtc = currentShortContracts * swapCtVal;
      netDeltaBtc = currentSpotBtc - currentShortBtc;
      livePerpPositions = freshPerpPositions;
    };

    const opportunity = computeFundingArbitrageOpportunity({
      asOfMs: now,
      spotInstId,
      perpInstId,
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
      swapCtValBtc: swapCtVal,
      swapLotSzContracts: swapMeta.lotSz,
      spotLotSzBtc: spotMeta.lotSz,
    }, carryConfig);
    state.lastOpportunity = opportunity;

    insertFundingArbOpportunity({
      source: "local_funding_arbitrage",
      instanceId: config.instanceId,
      mode: paperExecute ? "paper" : "shadow",
      spotInstId,
      perpInstId,
      fundingRate: opportunity.fundingRate,
      nextFundingTimeMs: opportunity.nextFundingTimeMs,
      basisBps: opportunity.basisBps,
      candidateBtcSize: opportunity.candidateBtcSize,
      candidateSwapContracts: opportunity.candidateSwapContracts,
      expectedFundingUsd: opportunity.expectedFundingUsd,
      expectedFeesUsd: opportunity.expectedFeesUsd,
      expectedSlippageUsd: opportunity.expectedSlippageUsd,
      expectedBasisRiskUsd: opportunity.expectedBasisRiskBufferUsd,
      netCarryEdgeUsd: opportunity.netCarryEdgeUsd,
      shouldEnter: opportunity.shouldEnter,
      reason: opportunity.reason,
      rawJson: JSON.stringify({ opportunity, funding, spotTicker, perpTicker }),
      createdAt: now,
    });

    if (state.packageState) {
      state.phase = "holding_for_funding";
      const exceededHold = now - state.packageState.openedAtMs > maxHoldMs;
      const fundingPassed = state.packageState.targetFundingTimeMs !== null && now >= state.packageState.targetFundingTimeMs;
      const hedgeBroken = Math.abs(netDeltaBtc) > maxNetDeltaToleranceBtc;
      if (paperExecute && (fundingPassed || exceededHold || hedgeBroken)) {
        state.phase = "unwinding";
        await this.recordEvent(config, "pre_unwind", {
          fundingPassed,
          exceededHold,
          hedgeBroken,
          netDeltaBtc,
        }, state.packageState);
        const spotSellQty = Math.max(
          0,
          Math.min(
            state.packageState.spotQtyBtc,
            currentSpotAvailBtc - state.packageState.preEntrySpotAvailBtc,
          ) - 0.00000001,
        );
        if (spotSellQty > 0) {
          await sellSpot(state.packageState.spotInstId, spotSellQty.toFixed(8));
        }
        const shortContractsToClose = Math.max(
          0,
          currentShortContracts - state.packageState.preEntryShortContracts,
        );
        if (shortContractsToClose > 0) {
          await safeFlattenShortPerp(state.packageState.perpInstId, shortContractsToClose);
        }
        await this.recordEvent(config, "unwound", {
          fundingPassed,
          exceededHold,
          hedgeBroken,
        }, state.packageState);
        state.packageState = null;
        state.phase = "completed";
        state.validationCycleCompleted = true;
        state.lastReason = fundingPassed ? "funding_settlement_passed" : (exceededHold ? "max_hold_exceeded" : "hedge_broken");
        await refreshLiveState();
      }
    } else {
      state.phase = opportunity.entryWindowOpen ? "evaluating_entry" : "await_entry_window";
      state.lastReason = opportunity.reason;
      const canEnterValidationCycle = !(carryConfig.forceValidationEntry && state.validationCycleCompleted);
      if (opportunity.shouldEnter && paperExecute && canEnterValidationCycle) {
        state.phase = "entering";
        const spotResult = await buySpot(spotInstId, String(opportunity.candidateBtcSize));
        if (!spotResult || spotResult.sCode !== "0") {
          state.phase = "aborted";
          state.lastReason = "spot_entry_failed";
          await this.recordEvent(config, "entry_failed", { leg: "spot", opportunity }, null);
        } else {
          const perpResult = await sellDown(perpInstId, String(opportunity.candidateSwapContracts));
          if (!perpResult || perpResult.sCode !== "0") {
            await sellSpot(spotInstId, String(opportunity.candidateBtcSize));
            state.phase = "aborted";
            state.lastReason = "perp_entry_failed";
            await this.recordEvent(config, "entry_failed", {
              leg: "perp",
              opportunity,
              spotResult,
              perpResult,
            }, null);
          } else {
            state.packageState = {
              spotInstId,
              perpInstId,
              spotQtyBtc: opportunity.candidateBtcSize,
              swapContracts: opportunity.candidateSwapContracts,
              preEntrySpotAvailBtc: btcBalance?.availBal ?? 0,
              preEntryShortContracts: currentShortContracts,
              entryMode: opportunity.reason.startsWith("validation_override") ? "validation_override" : "standard",
              openedAtMs: now,
              targetFundingTimeMs: opportunity.nextFundingTimeMs,
              spotOrdId: spotResult.ordId,
              perpOrdId: perpResult.ordId,
            };
            state.phase = "holding_for_funding";
            state.lastReason = state.packageState.entryMode;
            if (state.packageState.entryMode === "validation_override") {
              state.validationCycleCompleted = false;
            }
            await this.recordEvent(config, "entered", {
              opportunity,
              spotResult,
              perpResult,
            }, state.packageState);
            await refreshLiveState();
          }
        }
      } else if (opportunity.shouldEnter && paperExecute && !canEnterValidationCycle) {
        state.phase = "completed";
        state.lastReason = "validation_cycle_already_completed";
      }
    }

    this.persistPortfolioArtifacts({
      now,
      state,
      opportunity,
      paperExecute,
      spotMetaLotSz: spotMeta.lotSz,
      swapMetaCtVal: swapCtVal,
      currentSpotBtc,
      currentShortContracts,
      currentShortBtc,
      netDeltaBtc,
      usdtCashBalance: currentUsdtCash,
    });

    const positions: Record<string, unknown>[] = [
      {
        instId: spotInstId,
        posSide: "net",
        pos: currentSpotBtc,
        avgPx: spotTicker.last,
        upl: null,
      },
      ...livePerpPositions.map((row) => ({ ...row })),
    ];
    const subOrders: Record<string, unknown>[] = state.packageState
      ? [
          {
            ordId: state.packageState.spotOrdId ?? "",
            instId: state.packageState.spotInstId,
            side: "buy",
            posSide: "net",
            state: state.phase,
            sz: state.packageState.spotQtyBtc,
          },
          {
            ordId: state.packageState.perpOrdId ?? "",
            instId: state.packageState.perpInstId,
            side: "sell",
            posSide: "short",
            state: state.phase,
            sz: state.packageState.swapContracts,
          },
        ]
      : [];

    const snapshot = this.toSnapshot(config, state, opportunity, subOrders, positions, {
      paperExecute,
      currentSpotBtc,
      currentShortContracts,
      currentShortBtc,
      netDeltaBtc,
      fundingRate: funding.fundingRate,
      nextFundingTimeMs: funding.nextFundingTimeMs,
    });
    return {
      snapshot,
      rawDetail: snapshot.detail,
      subOrders,
      positions,
    };
  }

  private toSnapshot(
    config: ManagedStrategyInstanceConfig,
    state: FundingRuntimeState,
    opportunity: FundingArbitrageOpportunity | null,
    subOrders: Record<string, unknown>[],
    positions: Record<string, unknown>[],
    extra: Record<string, unknown>,
  ): ManagedStrategySnapshot {
    return {
      instanceId: config.instanceId,
      type: "local_funding_arbitrage",
      backend: "local",
      venue: "cryptobot",
      instrument: config.instrument,
      algoId: null,
      state: state.phase === "aborted" ? "error" : "running",
      totalPnl: null,
      subOrderCount: subOrders.length,
      positionCount: positions.length,
      capturedAt: Date.now(),
      detail: {
        phase: state.phase,
        lastReason: state.lastReason,
        packageState: state.packageState,
        opportunity,
        ...extra,
      },
    };
  }
}
