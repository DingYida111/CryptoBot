import type {
  DirectionId,
  InstrumentId,
  MarketletId,
  ResidualReasonCode,
  SecurityId,
  StrategyBasisId,
  StrategyId,
} from "./ids.js";

export type SecurityCategory =
  | "delta"
  | "cash"
  | "funding"
  | "basis"
  | "issuer"
  | "borrow"
  | "other";

export type InstrumentKind = "spot" | "perp" | "future" | "synthetic" | "spread";

export interface SecuritySpec {
  readonly securityId: SecurityId;
  readonly category: SecurityCategory;
  readonly unit: string;
  readonly markSource: string;
  readonly description: string;
  readonly active: boolean;
}

export interface InstrumentSpec {
  readonly instrumentId: InstrumentId;
  readonly kind: InstrumentKind;
  readonly venue: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly quantityUnit: string;
  readonly priceUnit: string;
  readonly minTradeSize: number;
  readonly stepSize: number;
  readonly contractMultiplier: number;
  readonly allowedSides: readonly ("buy" | "sell")[];
  readonly exposurePerContract: Readonly<Partial<Record<SecurityId, number>>>;
  readonly tags: readonly string[];
}

export interface InstrumentPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: number;
}

export interface SecurityExposure {
  readonly securityId: SecurityId;
  readonly quantity: number;
  readonly unit: string;
}

export interface StrategyBasisSpec {
  readonly basisId: StrategyBasisId;
  readonly instrumentWeights: Readonly<Record<InstrumentId, number>>;
  readonly description: string;
  readonly active: boolean;
}

export interface StrategyTemplateSpec {
  readonly strategyId: StrategyId;
  readonly basisIds: readonly StrategyBasisId[];
  readonly allowedInstruments: readonly InstrumentId[];
  readonly parameterSchema: Readonly<Record<string, string>>;
  readonly lifecycleRules: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
}

export interface DirectionSpec {
  readonly directionId: DirectionId;
  readonly securityWeights: Readonly<Record<SecurityId, number>>;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly description: string;
  readonly active: boolean;
  readonly bidThreshold?: number;
  readonly offerThreshold?: number;
  readonly horizonMs?: number;
  readonly tags: readonly string[];
}

export interface BidOfferQuantity {
  readonly bidQuantity: number;
  readonly offerQuantity: number;
}

export interface BidOfferLinearValue {
  readonly bid: number;
  readonly offer: number;
}

export interface MarketletSpec {
  readonly marketletId: MarketletId;
  readonly instrumentWeights: Readonly<Record<InstrumentId, number>>;
  readonly securityWeights: Readonly<Record<SecurityId, number>>;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly description: string;
  readonly active: boolean;
  readonly tags: readonly string[];
}

export interface DirectionExecutionRouteSpec {
  readonly directionId: DirectionId;
  readonly marketletWeights: Readonly<Record<MarketletId, number>>;
  readonly description: string;
  readonly active: boolean;
  readonly tags: readonly string[];
}

export interface SecurityExposureResidual {
  readonly securityId: SecurityId;
  readonly marketletQuantity: number;
  readonly directionQuantity: number;
  readonly residualQuantity: number;
}

export interface RoutedDirectionExecution {
  readonly directionExposure: Readonly<Record<SecurityId, number>>;
  readonly marketletWeights: Readonly<Record<MarketletId, number>>;
  readonly marketletExposure: Readonly<Record<SecurityId, number>>;
  readonly residual: readonly SecurityExposureResidual[];
  readonly matches: boolean;
}

export interface ResidualPosition {
  readonly instrumentId: InstrumentId;
  readonly quantity: number;
  readonly reasonCode: ResidualReasonCode;
}

export interface ResidualLedgerSummary {
  readonly rowCount: number;
  readonly grossQuantity: number;
  readonly netQuantity: number;
  readonly byInstrument: Readonly<Record<InstrumentId, number>>;
  readonly byReasonCode: Readonly<Record<ResidualReasonCode, number>>;
}

export interface ResidualBudget {
  readonly maxRowCount?: number;
  readonly maxGrossQuantity?: number;
  readonly maxNetQuantity?: number;
}

export interface ResidualBudgetCheck {
  readonly rowCount: number;
  readonly grossQuantity: number;
  readonly netQuantity: number;
  readonly withinBudget: boolean;
  readonly exceeded: readonly string[];
}

export interface BasisDecomposition {
  readonly basisId: StrategyBasisId | null;
  readonly strategyWeight: number;
  readonly basisDqContracts: number;
  readonly residualDqContracts: number;
  readonly residualReasonCode: ResidualReasonCode | null;
}

export interface PortfolioState {
  readonly asOfMs: number;
  readonly instrumentPositions: Readonly<Record<InstrumentId, number>>;
  readonly securityExposures: Readonly<Record<SecurityId, number>>;
  readonly cashBalances: Readonly<Record<string, number>>;
  readonly residualPositions: Readonly<Record<InstrumentId, number>>;
  readonly residualLedger: readonly ResidualPosition[];
  readonly residualSummary: ResidualLedgerSummary;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export type DecisionRoute =
  | "noop"
  | "open_long"
  | "open_short"
  | "close_long"
  | "close_short"
  | "partial_close_long"
  | "partial_close_short"
  | "grid_seed"
  | "grid_exit"
  | "grid_hold"
  | "residual";

export interface TradeLedgerEntry {
  readonly instrumentId: InstrumentId;
  readonly route: DecisionRoute;
  readonly dq: number;
  readonly basisId: StrategyBasisId | null;
  readonly strategyWeight: number;
  readonly basisDq: number;
  readonly residualDq: number;
  readonly residualReasonCode: ResidualReasonCode | null;
  readonly explainsDqExactly: boolean;
}

export interface TradePackageLedger {
  readonly basisId: StrategyBasisId | null;
  readonly strategyWeight: number;
  readonly legs: readonly TradeLedgerEntry[];
  readonly residualLedger: readonly ResidualPosition[];
  readonly residualSummary: ResidualLedgerSummary;
  readonly explainsPackageExactly: boolean;
}

export type DecisionTraceRoute =
  | DecisionRoute
  | "package_hold"
  | "funding_carry_enter"
  | "funding_carry_unwind";

export interface FundingArbPortfolioMetadata extends Readonly<Record<string, string | number | boolean>> {
  readonly phase: string;
  readonly lastReason: string;
  readonly paperExecute: boolean;
  readonly spotInstId: string;
  readonly perpInstId: string;
  readonly currentSpotBtc: number;
  readonly currentShortContracts: number;
  readonly currentShortBtc: number;
  readonly netDeltaBtc: number;
  readonly fundingRate: number;
  readonly nextFundingTimeMs: number;
  readonly basisBps: number;
  readonly basisUsd: number;
  readonly netCarryEdgeUsd: number;
  readonly expectedFundingUsd: number;
  readonly expectedFeesUsd: number;
  readonly expectedSlippageUsd: number;
  readonly expectedBasisRiskBufferUsd: number;
  readonly entryWindowOpen: boolean;
  readonly shouldEnter: boolean;
  readonly forceValidationEntry: boolean;
}

export interface OptimizationRequest {
  readonly portfolioState: PortfolioState;
  readonly enabledStrategies: readonly StrategyId[];
  readonly basisIds: readonly StrategyBasisId[];
  readonly objectiveScores: Readonly<Record<string, number>>;
  readonly basisBidOfferScores?: Readonly<Record<string, BidOfferLinearValue>>;
  readonly instrumentBidOfferCosts?: Readonly<Record<InstrumentId, BidOfferLinearValue>>;
  readonly instrumentBounds: Readonly<Record<InstrumentId, readonly [number, number]>>;
  readonly securityBounds: Readonly<Record<SecurityId, readonly [number, number]>>;
}

export interface RuntimeDecisionTraceDecision {
  readonly mode: DecisionIntent["mode"] | "package";
  readonly route: DecisionTraceRoute;
  readonly reason: string;
  readonly proposedDqContracts: number | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly intent: DecisionIntent | null;
  readonly tradeLedger: TradeLedgerEntry | null;
  readonly packageLedger: TradePackageLedger | null;
}

export interface RuntimeDecisionTraceDiff {
  readonly routeMatch: boolean | null;
  readonly exactDqMatch: boolean | null;
  readonly basisMatch: boolean | null;
  readonly residualMatch: boolean | null;
  readonly packageResidualRowDiff: number | null;
}

export interface RuntimeDecisionTrace {
  readonly traceVersion: string;
  readonly source: string;
  readonly portfolioState: PortfolioState;
  readonly optimizationRequest: OptimizationRequest;
  readonly actualDecision: RuntimeDecisionTraceDecision;
  readonly shadowDecision: RuntimeDecisionTraceDecision | null;
  readonly diff: RuntimeDecisionTraceDiff;
}

export interface DecisionIntent {
  readonly mode: "hold" | "trade" | "grid";
  readonly route: DecisionRoute;
  readonly proposedDqContracts: number;
  readonly basis: BasisDecomposition;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export type ExecutionRoundingMode = "toward_zero" | "nearest" | "floor" | "ceil";

export interface OptimizationObjectiveBreakdown {
  readonly efficiency: number;
  readonly risk: number;
  readonly cost: number;
  readonly constant: number;
}

export interface OptimizationBasisCandidate {
  readonly basisId: StrategyBasisId;
  readonly score: number;
  readonly normalizedScore: number;
  readonly currentWeight: number;
  readonly feasibleWeightLower: number;
  readonly feasibleWeightUpper: number;
  readonly targetWeight: number;
  readonly objectiveValue: number;
  readonly objectiveBreakdown: OptimizationObjectiveBreakdown;
}

export interface OptimizationResult {
  readonly selectedBasisId: StrategyBasisId | null;
  readonly selectedBasisWeight: number;
  readonly targetInstrumentPositions: Readonly<Record<InstrumentId, number>>;
  readonly targetInstrumentDeltas: Readonly<Record<InstrumentId, number>>;
  readonly targetSecurityExposures: Readonly<Record<SecurityId, number>>;
  readonly targetSecurityDeltas: Readonly<Record<SecurityId, number>>;
  readonly objectiveValue: number;
  readonly objectiveBreakdown: OptimizationObjectiveBreakdown;
  readonly candidates: readonly OptimizationBasisCandidate[];
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface QuantizedInstrumentDelta {
  readonly instrumentId: InstrumentId;
  readonly requestedDelta: number;
  readonly stepSize: number;
  readonly minTradeSize: number;
  readonly roundedDelta: number;
  readonly residualDelta: number;
  readonly roundingMode: ExecutionRoundingMode;
  readonly satisfiesMinTradeSize: boolean;
}

export interface ExecutionPlan {
  readonly asOfMs: number;
  readonly source: string;
  readonly targetInstrumentPositions: Readonly<Record<InstrumentId, number>>;
  readonly targetInstrumentDeltas: Readonly<Record<InstrumentId, number>>;
  readonly executedInstrumentDeltas: Readonly<Record<InstrumentId, number>>;
  readonly quantizedDeltas: readonly QuantizedInstrumentDelta[];
  readonly residualLedger: readonly ResidualPosition[];
  readonly residualBudgetCheck: ResidualBudgetCheck | null;
  readonly executable: boolean;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
