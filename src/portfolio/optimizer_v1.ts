import { listActiveInstrumentSpecs } from "./instrument_spec.js";
import type { InstrumentId, SecurityId } from "./ids.js";
import type { BidOfferLinearValue, InstrumentSpec, OptimizationBasisCandidate, OptimizationObjectiveBreakdown, OptimizationResult, OptimizationRequest, StrategyBasisSpec } from "./portfolio_types.js";
import { linearBidOfferValue, splitSignedQuantity } from "./side.js";

const EPS = 1e-12;

function clamp(value: number, lower: number, upper: number): number {
  if (!Number.isFinite(value)) return 0;
  if (lower > upper) {
    const mid = (lower + upper) / 2;
    return clamp(value, mid, mid);
  }
  return Math.min(Math.max(value, lower), upper);
}

function finiteOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.tanh(value);
}

function intersectIntervals(a: readonly [number, number], b: readonly [number, number]): readonly [number, number] | null {
  const lower = Math.max(a[0], b[0]);
  const upper = Math.min(a[1], b[1]);
  return lower <= upper ? [lower, upper] : null;
}

function solveIntervalForLinearConstraint(
  current: number,
  coefficient: number,
  lower: number,
  upper: number,
): readonly [number, number] | null {
  if (Math.abs(coefficient) <= EPS) {
    return current >= lower - EPS && current <= upper + EPS ? [-Infinity, Infinity] : null;
  }
  const a = (lower - current) / coefficient;
  const b = (upper - current) / coefficient;
  return [Math.min(a, b), Math.max(a, b)];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function basisScore(basisId: string, request: OptimizationRequest): number {
  const bidOffer = request.basisBidOfferScores?.[basisId];
  if (bidOffer) {
    return finiteOrZero(bidOffer.bid) - finiteOrZero(bidOffer.offer);
  }
  const confidence = Math.abs(finiteOrZero(request.objectiveScores.confidence ?? 1));
  const explicit = finiteOrZero(request.objectiveScores[basisId]);
  if (Math.abs(explicit) > EPS) {
    return explicit * confidence;
  }
  if (basisId === "basis:long_btc_swap") {
    return finiteOrZero(request.objectiveScores.signalEdge) * confidence;
  }
  if (basisId === "basis:btc_funding_carry_package") {
    return finiteOrZero(request.objectiveScores.carryEdge) * confidence;
  }
  return 0;
}

function inferBasisWeight(
  currentPositions: Readonly<Record<InstrumentId, number>>,
  basisSpec: StrategyBasisSpec,
): number {
  const estimates: number[] = [];
  for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
    if (Math.abs(coefficient) <= EPS) continue;
    const current = currentPositions[instrumentId as InstrumentId] ?? 0;
    estimates.push(current / coefficient);
  }
  return median(estimates);
}

function buildBasisSecurityWeights(
  basisSpec: StrategyBasisSpec,
  instrumentSpecs: ReadonlyMap<string, InstrumentSpec>,
): Readonly<Record<string, number>> {
  const weights: Record<string, number> = {};
  for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
    if (Math.abs(coefficient) <= EPS) continue;
    const spec = instrumentSpecs.get(instrumentId);
    if (!spec) continue;
    for (const [securityId, exposurePerContract] of Object.entries(spec.exposurePerContract)) {
      const exposure = finiteOrZero(exposurePerContract);
      if (Math.abs(exposure) <= EPS) continue;
      weights[securityId] = (weights[securityId] ?? 0) + coefficient * exposure;
    }
  }
  return weights;
}

function buildTargetRecord<T extends string>(
  current: Readonly<Record<T, number>>,
  delta: Readonly<Record<T, number>>,
): Readonly<Record<T, number>> {
  const out = {} as Record<T, number>;
  const keys = new Set<T>([
    ...Object.keys(current) as T[],
    ...Object.keys(delta) as T[],
  ]);
  for (const key of keys) {
    out[key] = (current[key] ?? 0) + (delta[key] ?? 0);
  }
  return out;
}

function buildObjectiveBreakdown(
  score: number,
  targetWeight: number,
  targetSecurityExposures: Readonly<Record<SecurityId, number>>,
  currentSecurityExposures: Readonly<Record<SecurityId, number>>,
  securityBounds: Readonly<Record<SecurityId, readonly [number, number]>>,
  riskAversion: number,
  tradeCostPerUnit: number,
  targetInstrumentDeltas: Readonly<Record<InstrumentId, number>>,
  basisBidOfferScore?: BidOfferLinearValue,
  instrumentBidOfferCosts?: Readonly<Record<InstrumentId, BidOfferLinearValue>>,
): OptimizationObjectiveBreakdown {
  const directionSide = splitSignedQuantity(targetWeight);
  const basisBidOffer = inputBidOfferScore(score, basisBidOfferScore);
  const efficiency = linearBidOfferValue({
    quantity: directionSide,
    value: {
      bid: basisBidOffer.bid,
      offer: -basisBidOffer.offer,
    },
  });

  let risk = 0;
  for (const [securityKey, targetExposure] of Object.entries(targetSecurityExposures)) {
    const securityId = securityKey as SecurityId;
    const current = currentSecurityExposures[securityId] ?? 0;
    const delta = targetExposure - current;
    const bound = securityBounds[securityId];
    const scale = bound ? Math.max(Math.abs(bound[0]), Math.abs(bound[1]), 1) : 1;
    risk += (targetExposure / scale) * (targetExposure / scale);
    risk += 0.1 * (delta / scale) * (delta / scale);
  }
  risk *= riskAversion;

  let cost = 0;
  for (const [instrumentId, delta] of Object.entries(targetInstrumentDeltas)) {
    const side = splitSignedQuantity(delta);
    const instrumentBidOfferCost = inputInstrumentBidOfferCost(
      tradeCostPerUnit,
      instrumentBidOfferCosts?.[instrumentId as InstrumentId],
    );
    cost += linearBidOfferValue({
      quantity: side,
      value: {
        bid: instrumentBidOfferCost.bid,
        offer: instrumentBidOfferCost.offer,
      },
    });
  }

  const constant = 0;
  return { efficiency, risk, cost, constant };
}

function inputBidOfferScore(score: number, bidOffer?: BidOfferLinearValue): BidOfferLinearValue {
  if (bidOffer) {
    return {
      bid: finiteOrZero(bidOffer.bid),
      offer: finiteOrZero(bidOffer.offer),
    };
  }
  return {
    bid: score,
    offer: score,
  };
}

function inputInstrumentBidOfferCost(
  cost: number,
  bidOffer?: BidOfferLinearValue,
): BidOfferLinearValue {
  if (bidOffer) {
    return {
      bid: Math.max(finiteOrZero(bidOffer.bid), 0),
      offer: Math.max(finiteOrZero(bidOffer.offer), 0),
    };
  }
  return {
    bid: cost,
    offer: cost,
  };
}

export function runOptimizationV1(input: {
  readonly request: OptimizationRequest;
  readonly basisSpecs: readonly StrategyBasisSpec[];
  readonly instrumentSpecs?: readonly InstrumentSpec[];
  readonly riskAversion?: number;
  readonly tradeCostPerUnit?: number;
  readonly scoreScale?: number;
}): OptimizationResult {
  const instrumentSpecs = new Map<string, InstrumentSpec>(
    (input.instrumentSpecs ?? listActiveInstrumentSpecs()).map((spec) => [spec.instrumentId, spec]),
  );
  const currentPositions = input.request.portfolioState.instrumentPositions;
  const currentSecurityExposures = input.request.portfolioState.securityExposures;
  const activeBasisIds = new Set(input.request.basisIds);
  const scoreScale = Math.max(Math.abs(input.scoreScale ?? 1), EPS);
  const riskAversion = Math.max(input.riskAversion ?? 1, 0);
  const tradeCostPerUnit = Math.max(input.tradeCostPerUnit ?? 0, 0);

  const candidates: OptimizationBasisCandidate[] = [];

  for (const basisSpec of input.basisSpecs) {
    if (!basisSpec.active || !activeBasisIds.has(basisSpec.basisId)) continue;

    const basisBidOfferScore = input.request.basisBidOfferScores?.[basisSpec.basisId];
    const score = basisScore(String(basisSpec.basisId), input.request);
    const normalizedScore = normalizeScore(score / scoreScale);
    const currentWeight = inferBasisWeight(currentPositions, basisSpec);

    let feasible: readonly [number, number] = [-Infinity, Infinity];
    for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
      const spec = instrumentSpecs.get(instrumentId);
      if (!spec) {
        throw new Error(`Missing instrument spec for basis ${String(basisSpec.basisId)} / ${instrumentId}`);
      }

      const current = currentPositions[instrumentId as InstrumentId] ?? 0;
      const instrumentInterval = solveIntervalForLinearConstraint(
        current,
        coefficient,
        input.request.instrumentBounds[instrumentId as InstrumentId]?.[0] ?? -Infinity,
        input.request.instrumentBounds[instrumentId as InstrumentId]?.[1] ?? Infinity,
      );
      if (!instrumentInterval) {
        feasible = [1, 0];
        break;
      }
      const merged = intersectIntervals(feasible, instrumentInterval);
      if (!merged) {
        feasible = [1, 0];
        break;
      }
      feasible = merged;
    }

    const basisSecurityWeights = buildBasisSecurityWeights(basisSpec, instrumentSpecs);
    for (const [securityId, coefficient] of Object.entries(basisSecurityWeights)) {
      const typedSecurityId = securityId as SecurityId;
      const current = currentSecurityExposures[typedSecurityId] ?? 0;
      const securityInterval = solveIntervalForLinearConstraint(
        current,
        coefficient,
        input.request.securityBounds[typedSecurityId]?.[0] ?? -Infinity,
        input.request.securityBounds[typedSecurityId]?.[1] ?? Infinity,
      );
      if (!securityInterval) {
        feasible = [1, 0];
        break;
      }
      const merged = intersectIntervals(feasible, securityInterval);
      if (!merged) {
        feasible = [1, 0];
        break;
      }
      feasible = merged;
    }

    const feasibleMagnitude = Math.max(Math.abs(feasible[0]), Math.abs(feasible[1]), 0);
    const desiredWeight = normalizedScore * feasibleMagnitude;
    const targetWeight = clamp(desiredWeight, feasible[0], feasible[1]);

    const targetInstrumentDeltas: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
    const targetInstrumentPositions: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
    for (const [instrumentId, coefficient] of Object.entries(basisSpec.instrumentWeights)) {
      const id = instrumentId as InstrumentId;
      const delta = targetWeight * coefficient;
      targetInstrumentDeltas[id] = delta;
      targetInstrumentPositions[id] = (currentPositions[id] ?? 0) + delta;
    }

    const targetSecurityDeltas: Record<SecurityId, number> = {} as Record<SecurityId, number>;
    const targetSecurityExposures: Record<SecurityId, number> = {} as Record<SecurityId, number>;
    for (const [securityId, coefficient] of Object.entries(basisSecurityWeights)) {
      const typedSecurityId = securityId as SecurityId;
      const delta = targetWeight * coefficient;
      targetSecurityDeltas[typedSecurityId] = delta;
      targetSecurityExposures[typedSecurityId] = (currentSecurityExposures[typedSecurityId] ?? 0) + delta;
    }

    const objectiveBreakdown = buildObjectiveBreakdown(
      score,
      targetWeight,
      targetSecurityExposures,
      currentSecurityExposures,
      input.request.securityBounds,
      riskAversion,
      tradeCostPerUnit,
      targetInstrumentDeltas,
      basisBidOfferScore,
      input.request.instrumentBidOfferCosts,
    );
    const objectiveValue =
      objectiveBreakdown.efficiency -
      objectiveBreakdown.risk -
      objectiveBreakdown.cost +
      objectiveBreakdown.constant;

    candidates.push({
      basisId: basisSpec.basisId,
      score,
      normalizedScore,
      currentWeight,
      feasibleWeightLower: feasible[0],
      feasibleWeightUpper: feasible[1],
      targetWeight,
      objectiveValue,
      objectiveBreakdown,
    });
  }

  const selected = candidates
    .slice()
    .sort((left, right) => right.objectiveValue - left.objectiveValue)[0] ?? null;

  const selectedBasisId = selected?.basisId ?? null;
  const selectedBasisWeight = selected?.targetWeight ?? 0;
  const selectedSpec = selectedBasisId === null ? null : input.basisSpecs.find((basis) => basis.basisId === selectedBasisId) ?? null;

  const targetInstrumentDeltas: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
  const targetInstrumentPositions: Record<InstrumentId, number> = {} as Record<InstrumentId, number>;
  const targetSecurityDeltas: Record<SecurityId, number> = {} as Record<SecurityId, number>;
  const targetSecurityExposures: Record<SecurityId, number> = {} as Record<SecurityId, number>;

  if (selectedSpec) {
    const basisSecurityWeights = buildBasisSecurityWeights(selectedSpec, instrumentSpecs);
    for (const [instrumentId, coefficient] of Object.entries(selectedSpec.instrumentWeights)) {
      const id = instrumentId as InstrumentId;
      const delta = selectedBasisWeight * coefficient;
      targetInstrumentDeltas[id] = delta;
      targetInstrumentPositions[id] = (currentPositions[id] ?? 0) + delta;
    }
    for (const [securityId, coefficient] of Object.entries(basisSecurityWeights)) {
      const typedSecurityId = securityId as SecurityId;
      const delta = selectedBasisWeight * coefficient;
      targetSecurityDeltas[typedSecurityId] = delta;
      targetSecurityExposures[typedSecurityId] = (currentSecurityExposures[typedSecurityId] ?? 0) + delta;
    }
  } else {
    for (const key of Object.keys(currentPositions) as InstrumentId[]) {
      targetInstrumentPositions[key] = currentPositions[key] ?? 0;
      targetInstrumentDeltas[key] = 0;
    }
    for (const key of Object.keys(currentSecurityExposures)) {
      const typedSecurityId = key as SecurityId;
      targetSecurityExposures[typedSecurityId] = currentSecurityExposures[typedSecurityId] ?? 0;
      targetSecurityDeltas[typedSecurityId] = 0;
    }
  }

  const objectiveBreakdown = selected?.objectiveBreakdown ?? {
    efficiency: 0,
    risk: 0,
    cost: 0,
    constant: 0,
  };
  const objectiveValue = selected?.objectiveValue ?? 0;
  const reason = selectedSpec
    ? `selected_basis=${String(selectedSpec.basisId)}`
    : "no_active_basis_selected";

  return {
    selectedBasisId,
    selectedBasisWeight,
    targetInstrumentPositions: buildTargetRecord(currentPositions, targetInstrumentDeltas),
    targetInstrumentDeltas,
    targetSecurityExposures: buildTargetRecord(currentSecurityExposures, targetSecurityDeltas) as Readonly<Record<SecurityId, number>>,
    targetSecurityDeltas,
    objectiveValue,
    objectiveBreakdown,
    candidates,
    reason,
    metadata: {
      riskAversion,
      tradeCostPerUnit,
      scoreScale,
    },
  };
}
