export type StrategyBackend = "local" | "okx_managed";
export type StrategyVenue = "cryptobot" | "okx";

export type ManagedStrategyType =
  | "local_chop_grid"
  | "okx_contract_grid"
  | "okx_martingale"
  | "local_spread_arbitrage"
  | "local_funding_arbitrage";

export const MANAGED_STRATEGY_TYPES: ManagedStrategyType[] = [
  "local_chop_grid",
  "okx_contract_grid",
  "okx_martingale",
  "local_spread_arbitrage",
  "local_funding_arbitrage",
];

export type StrategyLifecycleState =
  | "idle"
  | "running"
  | "stopped"
  | "paused"
  | "error"
  | "unknown";

export interface StrategyParameterSpec {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  defaultValue?: string | number | boolean;
  description: string;
  options?: string[];
}

export interface ManagedStrategyDefinition {
  type: ManagedStrategyType;
  backend: StrategyBackend;
  venue: StrategyVenue;
  label: string;
  description: string;
  supportsRemotePnl: boolean;
  parameters: StrategyParameterSpec[];
}

export interface ManagedStrategyInstanceConfig {
  instanceId: string;
  type: ManagedStrategyType;
  instrument: string;
  enabled: boolean;
  autoStart?: boolean;
  syncIntervalMs?: number;
  parameters: Record<string, string | number | boolean>;
  metadata?: Record<string, string>;
}

export interface ManagedStrategySnapshot {
  instanceId: string;
  type: ManagedStrategyType;
  backend: StrategyBackend;
  venue: StrategyVenue;
  instrument: string;
  algoId?: string | null;
  state: StrategyLifecycleState;
  totalPnl?: number | null;
  detail: Record<string, unknown>;
  subOrderCount?: number;
  positionCount?: number;
  capturedAt: number;
}

export interface ManagedStrategyStartResult {
  algoId?: string | null;
  state: StrategyLifecycleState;
  raw?: Record<string, unknown>;
}

export interface ManagedStrategySyncResult {
  snapshot: ManagedStrategySnapshot;
  rawDetail: Record<string, unknown>;
  subOrders: Record<string, unknown>[];
  positions: Record<string, unknown>[];
}

export interface ManagedStrategyController {
  readonly definition: ManagedStrategyDefinition;
  start(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategyStartResult>;
  sync(config: ManagedStrategyInstanceConfig): Promise<ManagedStrategySyncResult>;
  stop(config: ManagedStrategyInstanceConfig): Promise<void>;
}

export type ManagedStrategyFactory = () => ManagedStrategyController;

export class ManagedStrategyRegistry {
  private readonly definitions = new Map<ManagedStrategyType, ManagedStrategyDefinition>();
  private readonly factories = new Map<ManagedStrategyType, ManagedStrategyFactory>();

  register(definition: ManagedStrategyDefinition, factory?: ManagedStrategyFactory): void {
    this.definitions.set(definition.type, definition);
    if (factory) {
      this.factories.set(definition.type, factory);
    }
  }

  getDefinition(type: ManagedStrategyType): ManagedStrategyDefinition | undefined {
    return this.definitions.get(type);
  }

  listDefinitions(): ManagedStrategyDefinition[] {
    return Array.from(this.definitions.values());
  }

  create(type: ManagedStrategyType): ManagedStrategyController {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`No managed strategy factory registered for ${type}`);
    }
    return factory();
  }
}

export const BUILTIN_MANAGED_STRATEGIES: ManagedStrategyDefinition[] = [
  {
    type: "local_chop_grid",
    backend: "local",
    venue: "cryptobot",
    label: "Local CHOP Grid",
    description: "CryptoBot self-managed long-inventory grid tuned for CHOP/RANGE regime.",
    supportsRemotePnl: false,
    parameters: [
      { key: "layers", label: "Layers", type: "number", required: true, defaultValue: 7, description: "Grid layers on each side." },
      { key: "spacingPct", label: "Spacing %", type: "number", required: true, defaultValue: 0.006, description: "Distance between adjacent grid levels." },
      { key: "orderSize", label: "Order Size", type: "number", required: true, defaultValue: 1, description: "Contracts per child order." },
      { key: "seedMultiplier", label: "Seed Multiplier", type: "number", required: true, defaultValue: 7, description: "Initial inventory multiplier." },
    ],
  },
  {
    type: "okx_contract_grid",
    backend: "okx_managed",
    venue: "okx",
    label: "OKX Contract Grid",
    description: "Exchange-managed contract grid strategy queried through OKX strategy trading APIs.",
    supportsRemotePnl: true,
    parameters: [
      { key: "algoId", label: "Algo ID", type: "string", required: false, description: "Reuse an existing OKX strategy if present." },
      { key: "direction", label: "Direction", type: "enum", required: true, defaultValue: "neutral", options: ["long", "short", "neutral"], description: "OKX contract grid direction." },
      { key: "margin", label: "Margin", type: "number", required: true, defaultValue: 200, description: "Margin in USDT passed as sz." },
      { key: "leverage", label: "Leverage", type: "number", required: true, defaultValue: 2, description: "Exchange leverage." },
      { key: "gridNum", label: "Grid Count", type: "number", required: true, defaultValue: 7, description: "Number of grid levels." },
      { key: "minPriceRatio", label: "Min Ratio", type: "number", required: true, defaultValue: 0.97, description: "Lower bound as ratio of current price." },
      { key: "maxPriceRatio", label: "Max Ratio", type: "number", required: true, defaultValue: 1.03, description: "Upper bound as ratio of current price." },
    ],
  },
  {
    type: "okx_martingale",
    backend: "okx_managed",
    venue: "okx",
    label: "OKX Martingale / DCA",
    description: "Placeholder for exchange-managed DCA or martingale family using OKX trading bot endpoints.",
    supportsRemotePnl: true,
    parameters: [
      { key: "algoId", label: "Algo ID", type: "string", required: false, description: "Existing OKX DCA strategy identifier." },
      { key: "budget", label: "Budget", type: "number", required: true, defaultValue: 200, description: "Total capital allocated." },
      { key: "direction", label: "Direction", type: "enum", required: true, defaultValue: "long", options: ["long", "short"], description: "DCA orientation." },
    ],
  },
  {
    type: "local_spread_arbitrage",
    backend: "local",
    venue: "cryptobot",
    label: "Local Spread Arbitrage",
    description: "Placeholder for self-managed multi-leg spread or funding-basis arbitrage logic.",
    supportsRemotePnl: false,
    parameters: [
      { key: "entrySpreadBps", label: "Entry Spread bps", type: "number", required: true, defaultValue: 15, description: "Minimum spread before opening a spread trade." },
      { key: "maxLegSize", label: "Max Leg Size", type: "number", required: true, defaultValue: 10, description: "Maximum contracts per leg." },
    ],
  },
  {
    type: "local_funding_arbitrage",
    backend: "local",
    venue: "cryptobot",
    label: "Local Funding Arbitrage",
    description: "CryptoBot self-managed BTC spot + perp funding-capture strategy with shadow-first and paper execution modes.",
    supportsRemotePnl: false,
    parameters: [
      { key: "spotInstId", label: "Spot Instrument", type: "string", required: true, defaultValue: "BTC-USDT", description: "OKX spot instrument for the long hedge leg." },
      { key: "perpInstId", label: "Perp Instrument", type: "string", required: true, defaultValue: "BTC-USDT-SWAP", description: "OKX perpetual instrument for the short funding leg." },
      { key: "entryLeadMs", label: "Entry Lead Ms", type: "number", required: true, defaultValue: 120000, description: "How long before funding settlement the strategy is allowed to enter." },
      { key: "maxPackageSizeBtc", label: "Max Package BTC", type: "number", required: true, defaultValue: 0.01, description: "Maximum BTC-equivalent package size." },
      { key: "minUsefulPackageSizeBtc", label: "Min Useful BTC", type: "number", required: true, defaultValue: 0.01, description: "Minimum BTC-equivalent package size required to trade." },
      { key: "spotFeeRate", label: "Spot Fee Rate", type: "number", required: true, defaultValue: 0.001, description: "Spot fee assumption used in carry gating." },
      { key: "perpFeeRate", label: "Perp Fee Rate", type: "number", required: true, defaultValue: 0.0005, description: "Perp fee assumption used in carry gating." },
      { key: "spotSlippageBps", label: "Spot Slippage bps", type: "number", required: true, defaultValue: 5, description: "Spot slippage budget in bps." },
      { key: "perpSlippageBps", label: "Perp Slippage bps", type: "number", required: true, defaultValue: 5, description: "Perp slippage budget in bps." },
      { key: "basisRiskBufferBps", label: "Basis Buffer bps", type: "number", required: true, defaultValue: 8, description: "Basis-risk buffer used in net-edge gating." },
      { key: "safetyBufferUsd", label: "Safety Buffer USD", type: "number", required: true, defaultValue: 1, description: "Minimum positive net edge required for standard entry." },
      { key: "paperExecute", label: "Paper Execute", type: "boolean", required: true, defaultValue: false, description: "When true, place demo orders instead of shadow-only evaluation." },
      { key: "forceValidationEntry", label: "Force Validation Entry", type: "boolean", required: true, defaultValue: false, description: "Allow a paper validation package even outside the normal funding entry window." },
      { key: "maxHoldMs", label: "Max Hold Ms", type: "number", required: true, defaultValue: 300000, description: "Maximum time to keep the package open after entry." },
      { key: "maxNetDeltaToleranceBtc", label: "Max Net Delta BTC", type: "number", required: true, defaultValue: 0.002, description: "Maximum tolerated hedge mismatch in BTC before aborting." },
    ],
  },
];
