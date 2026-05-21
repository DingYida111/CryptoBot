import type {
  InstrumentId,
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
  readonly route: DecisionRoute;
  readonly dqContracts: number;
  readonly basisId: StrategyBasisId | null;
  readonly strategyWeight: number;
  readonly basisDqContracts: number;
  readonly residualDqContracts: number;
  readonly residualReasonCode: ResidualReasonCode | null;
  readonly explainsDqExactly: boolean;
}

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
  readonly instrumentBounds: Readonly<Record<InstrumentId, readonly [number, number]>>;
  readonly securityBounds: Readonly<Record<SecurityId, readonly [number, number]>>;
}

export interface DecisionIntent {
  readonly mode: "hold" | "trade" | "grid";
  readonly route: DecisionRoute;
  readonly proposedDqContracts: number;
  readonly basis: BasisDecomposition;
  readonly reason: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
