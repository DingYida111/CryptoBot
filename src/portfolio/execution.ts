import { buildResidualPositionFromCode, RESIDUAL_REASON_CODES } from "./residual.js";
import { getInstrumentSpec } from "./instrument_spec.js";
import type {
  ExecutionPlan,
  ExecutionRoundingMode,
  PortfolioState,
  OptimizationResult,
  ResidualBudget,
  ResidualBudgetCheck,
  QuantizedInstrumentDelta,
  ResidualPosition,
  StrategyBasisSpec,
} from "./portfolio_types.js";
import type { InstrumentId } from "./ids.js";

const EPS = 1e-12;

function summarizeResidualBudget(
  residualLedger: readonly ResidualPosition[],
  budget?: ResidualBudget,
): ResidualBudgetCheck | null {
  if (!budget) return null;
  const rowCount = residualLedger.length;
  const grossQuantity = residualLedger.reduce((sum, row) => sum + Math.abs(row.quantity), 0);
  const netQuantity = residualLedger.reduce((sum, row) => sum + row.quantity, 0);
  const exceeded: string[] = [];

  if (budget.maxRowCount !== undefined && rowCount > budget.maxRowCount) {
    exceeded.push("maxRowCount");
  }
  if (budget.maxGrossQuantity !== undefined && grossQuantity > budget.maxGrossQuantity + EPS) {
    exceeded.push("maxGrossQuantity");
  }
  if (budget.maxNetQuantity !== undefined && Math.abs(netQuantity) > budget.maxNetQuantity + EPS) {
    exceeded.push("maxNetQuantity");
  }

  return {
    rowCount,
    grossQuantity,
    netQuantity,
    withinBudget: exceeded.length === 0,
    exceeded,
  };
}

function roundTowardZero(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.sign(value) * Math.floor(Math.abs(value) / step + EPS) * step;
}

function roundNearest(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

function roundFloor(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.floor(value / step) * step;
}

function roundCeil(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.ceil(value / step) * step;
}

export function roundToStep(value: number, step: number, mode: ExecutionRoundingMode = "toward_zero"): number {
  switch (mode) {
    case "nearest":
      return roundNearest(value, step);
    case "floor":
      return roundFloor(value, step);
    case "ceil":
      return roundCeil(value, step);
    case "toward_zero":
    default:
      return roundTowardZero(value, step);
  }
}

export function quantizeInstrumentDelta(input: {
  readonly instrumentId: InstrumentId;
  readonly requestedDelta: number;
  readonly roundingMode?: ExecutionRoundingMode;
}): QuantizedInstrumentDelta {
  const spec = getInstrumentSpec(input.instrumentId);
  const roundingMode = input.roundingMode ?? "toward_zero";
  const roundedDelta = roundToStep(input.requestedDelta, spec.stepSize, roundingMode);
  const isNoop = Math.abs(input.requestedDelta) <= EPS;
  const satisfiesMinTradeSize = isNoop || Math.abs(roundedDelta) + EPS >= spec.minTradeSize;
  const executableDelta = satisfiesMinTradeSize ? roundedDelta : 0;
  const residualDelta = input.requestedDelta - executableDelta;

  return {
    instrumentId: input.instrumentId,
    requestedDelta: input.requestedDelta,
    stepSize: spec.stepSize,
    minTradeSize: spec.minTradeSize,
    roundedDelta: executableDelta,
    residualDelta,
    roundingMode,
    satisfiesMinTradeSize,
  };
}

export function buildExecutionPlan(input: {
  readonly asOfMs: number;
  readonly source: string;
  readonly portfolioState: PortfolioState;
  readonly targetInstrumentPositions: Readonly<Record<InstrumentId, number>>;
  readonly roundingMode?: ExecutionRoundingMode;
  readonly residualBudget?: ResidualBudget;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): ExecutionPlan {
  const currentPositions = input.portfolioState.instrumentPositions;
  const targetInstrumentDeltas: Record<InstrumentId, number> = {};
  const executedInstrumentDeltas: Record<InstrumentId, number> = {};
  const quantizedDeltas: QuantizedInstrumentDelta[] = [];
  const residualLedger: ResidualPosition[] = [];

  const instrumentIds = new Set<InstrumentId>([
    ...Object.keys(currentPositions) as InstrumentId[],
    ...Object.keys(input.targetInstrumentPositions) as InstrumentId[],
  ]);

  for (const instrumentId of instrumentIds) {
    const current = currentPositions[instrumentId] ?? 0;
    const target = input.targetInstrumentPositions[instrumentId] ?? current;
    const requestedDelta = target - current;
    targetInstrumentDeltas[instrumentId] = requestedDelta;

    const quantized = quantizeInstrumentDelta({
      instrumentId,
      requestedDelta,
      roundingMode: input.roundingMode,
    });
    quantizedDeltas.push(quantized);
    executedInstrumentDeltas[instrumentId] = quantized.roundedDelta;

    if (Math.abs(quantized.residualDelta) > EPS) {
      residualLedger.push(
        buildResidualPositionFromCode(
          instrumentId,
          quantized.residualDelta,
          RESIDUAL_REASON_CODES.LOT_ROUNDING,
        ),
      );
    }
  }

  const executable = quantizedDeltas.every((row) => row.satisfiesMinTradeSize || Math.abs(row.requestedDelta) <= EPS);
  const residualBudgetCheck = summarizeResidualBudget(residualLedger, input.residualBudget);
  const budgetOk = residualBudgetCheck ? residualBudgetCheck.withinBudget : true;
  const finalExecutable = executable && budgetOk;
  const reason = !budgetOk
    ? "execution_plan_residual_budget_exceeded"
    : input.reason ?? (finalExecutable ? "execution_plan_ready" : "execution_plan_quantized");

  return {
    asOfMs: input.asOfMs,
    source: input.source,
    targetInstrumentPositions: input.targetInstrumentPositions,
    targetInstrumentDeltas,
    executedInstrumentDeltas,
    quantizedDeltas,
    residualLedger,
    residualBudgetCheck,
    executable: finalExecutable,
    reason,
    metadata: input.metadata ?? {},
  };
}

export function buildExecutionPlanFromOptimization(input: {
  readonly asOfMs: number;
  readonly source: string;
  readonly portfolioState: PortfolioState;
  readonly optimizationResult: OptimizationResult;
  readonly roundingMode?: ExecutionRoundingMode;
  readonly residualBudget?: ResidualBudget;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): ExecutionPlan {
  return buildExecutionPlan({
    asOfMs: input.asOfMs,
    source: input.source,
    portfolioState: input.portfolioState,
    targetInstrumentPositions: input.optimizationResult.targetInstrumentPositions,
    roundingMode: input.roundingMode,
    residualBudget: input.residualBudget,
    reason: input.reason ?? input.optimizationResult.reason,
    metadata: {
      selectedBasisId: input.optimizationResult.selectedBasisId ?? "none",
      selectedBasisWeight: input.optimizationResult.selectedBasisWeight,
      objectiveValue: input.optimizationResult.objectiveValue,
      ...(input.metadata ?? {}),
    },
  });
}

function packageWeightStep(basisSpec: StrategyBasisSpec): number {
  let step = 0;
  for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
    if (Math.abs(coefficient) <= EPS) continue;
    const spec = getInstrumentSpec(instrumentId as InstrumentId);
    step = Math.max(step, spec.stepSize / Math.abs(coefficient));
  }
  return step;
}

function packageMinWeight(basisSpec: StrategyBasisSpec): number {
  let minWeight = 0;
  for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
    if (Math.abs(coefficient) <= EPS) continue;
    const spec = getInstrumentSpec(instrumentId as InstrumentId);
    minWeight = Math.max(minWeight, spec.minTradeSize / Math.abs(coefficient));
  }
  return minWeight;
}

export function quantizeBasisWeight(input: {
  readonly basisSpec: StrategyBasisSpec;
  readonly requestedWeight: number;
  readonly roundingMode?: ExecutionRoundingMode;
}): {
  readonly requestedWeight: number;
  readonly roundedWeight: number;
  readonly residualWeight: number;
  readonly packageWeightStep: number;
  readonly packageMinWeight: number;
  readonly roundingMode: ExecutionRoundingMode;
  readonly executable: boolean;
} {
  const roundingMode = input.roundingMode ?? "toward_zero";
  const step = packageWeightStep(input.basisSpec);
  const minWeight = packageMinWeight(input.basisSpec);
  const rawRounded = step > 0 ? roundToStep(input.requestedWeight, step, roundingMode) : input.requestedWeight;
  const isNoop = Math.abs(input.requestedWeight) <= EPS;
  const executable = isNoop || Math.abs(rawRounded) + EPS >= minWeight;
  const roundedWeight = executable ? rawRounded : 0;

  return {
    requestedWeight: input.requestedWeight,
    roundedWeight,
    residualWeight: input.requestedWeight - roundedWeight,
    packageWeightStep: step,
    packageMinWeight: minWeight,
    roundingMode,
    executable,
  };
}

export function buildPackageExecutionPlanFromBasis(input: {
  readonly asOfMs: number;
  readonly source: string;
  readonly portfolioState: PortfolioState;
  readonly basisSpec: StrategyBasisSpec;
  readonly requestedBasisWeight: number;
  readonly roundingMode?: ExecutionRoundingMode;
  readonly residualBudget?: ResidualBudget;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}): ExecutionPlan {
  const quantizedWeight = quantizeBasisWeight({
    basisSpec: input.basisSpec,
    requestedWeight: input.requestedBasisWeight,
    roundingMode: input.roundingMode,
  });
  const targetInstrumentPositions: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
  const targetInstrumentDeltas: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
  const executedInstrumentDeltas: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
  const quantizedDeltas: QuantizedInstrumentDelta[] = [];
  const residualLedger: ResidualPosition[] = [];

  for (const [instrumentId, coefficient] of Object.entries(input.basisSpec.instrumentWeights)) {
    const id = instrumentId as InstrumentId;
    const spec = getInstrumentSpec(id);
    const current = input.portfolioState.instrumentPositions[id] ?? 0;
    const requestedDelta = input.requestedBasisWeight * coefficient;
    const roundedDelta = quantizedWeight.roundedWeight * coefficient;
    const residualDelta = requestedDelta - roundedDelta;
    const isNoop = Math.abs(requestedDelta) <= EPS;
    const satisfiesMinTradeSize = isNoop || Math.abs(roundedDelta) + EPS >= spec.minTradeSize;

    targetInstrumentDeltas[id] = requestedDelta;
    targetInstrumentPositions[id] = current + requestedDelta;
    executedInstrumentDeltas[id] = roundedDelta;
    quantizedDeltas.push({
      instrumentId: id,
      requestedDelta,
      stepSize: spec.stepSize,
      minTradeSize: spec.minTradeSize,
      roundedDelta,
      residualDelta,
      roundingMode: quantizedWeight.roundingMode,
      satisfiesMinTradeSize,
    });

    if (Math.abs(residualDelta) > EPS) {
      residualLedger.push(
        buildResidualPositionFromCode(
          id,
          residualDelta,
          RESIDUAL_REASON_CODES.LOT_ROUNDING,
        ),
      );
    }
  }

  const residualBudgetCheck = summarizeResidualBudget(residualLedger, input.residualBudget);
  const budgetOk = residualBudgetCheck ? residualBudgetCheck.withinBudget : true;

  return {
    asOfMs: input.asOfMs,
    source: input.source,
    targetInstrumentPositions,
    targetInstrumentDeltas,
    executedInstrumentDeltas,
    quantizedDeltas,
    residualLedger,
    residualBudgetCheck,
    executable:
      quantizedWeight.executable &&
      quantizedDeltas.every((row) => row.satisfiesMinTradeSize) &&
      budgetOk,
    reason: input.reason ?? `package_execution_plan_basis=${String(input.basisSpec.basisId)}`,
    metadata: {
      basisId: String(input.basisSpec.basisId),
      requestedBasisWeight: input.requestedBasisWeight,
      roundedBasisWeight: quantizedWeight.roundedWeight,
      residualBasisWeight: quantizedWeight.residualWeight,
      packageWeightStep: quantizedWeight.packageWeightStep,
      packageMinWeight: quantizedWeight.packageMinWeight,
      ...(input.metadata ?? {}),
    },
  };
}
