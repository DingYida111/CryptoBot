import { clampDirectionWeights, compileDirectionExposure } from "./direction.js";
import type { DirectionId, MarketletId, SecurityId } from "./ids.js";
import type {
  BidOfferQuantity,
  DirectionExecutionRouteSpec,
  DirectionSpec,
  MarketletSpec,
  RoutedDirectionExecution,
  SecurityExposureResidual,
} from "./portfolio_types.js";
import { assertFiniteBounds, clampBidOfferQuantity, netBidOfferQuantity, splitSignedQuantity } from "./side.js";

const EPS = 1e-12;

function clampWeight(weight: number, lowerBound: number, upperBound: number): number {
  return Math.min(Math.max(weight, lowerBound), upperBound);
}

function addSecurityQuantity(
  out: Record<SecurityId, number>,
  securityId: SecurityId,
  quantity: number,
): void {
  const next = (out[securityId] ?? 0) + quantity;
  if (Math.abs(next) <= EPS) {
    delete out[securityId];
    return;
  }
  out[securityId] = next;
}

export function clampMarketletWeights(input: {
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly marketletWeights: Readonly<Record<MarketletId, number>>;
}): Readonly<Record<MarketletId, number>> {
  const out = {} as Record<MarketletId, number>;
  for (const spec of input.marketletSpecs) {
    assertFiniteBounds({
      id: spec.marketletId,
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (!spec.active) continue;
    const requestedWeight = input.marketletWeights[spec.marketletId] ?? 0;
    const clampedWeight = clampWeight(requestedWeight, spec.lowerBound, spec.upperBound);
    if (Math.abs(clampedWeight) <= EPS) continue;
    out[spec.marketletId] = clampedWeight;
  }
  return out;
}

export function splitMarketletWeights(input: {
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly marketletWeights: Readonly<Record<MarketletId, number>>;
}): Readonly<Record<MarketletId, BidOfferQuantity>> {
  const clampedWeights = clampMarketletWeights(input);
  const out = {} as Record<MarketletId, BidOfferQuantity>;
  for (const [marketletId, marketletWeight] of Object.entries(clampedWeights)) {
    out[marketletId as MarketletId] = splitSignedQuantity(marketletWeight);
  }
  return out;
}

export function clampMarketletBidOfferWeights(input: {
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly marketletBidOfferWeights: Readonly<Record<MarketletId, BidOfferQuantity>>;
}): Readonly<Record<MarketletId, BidOfferQuantity>> {
  const out = {} as Record<MarketletId, BidOfferQuantity>;
  for (const spec of input.marketletSpecs) {
    assertFiniteBounds({
      id: spec.marketletId,
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (!spec.active) continue;
    const clamped = clampBidOfferQuantity({
      id: spec.marketletId,
      quantity: input.marketletBidOfferWeights[spec.marketletId] ?? {
        bidQuantity: 0,
        offerQuantity: 0,
      },
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (Math.abs(clamped.bidQuantity) <= EPS && Math.abs(clamped.offerQuantity) <= EPS) continue;
    out[spec.marketletId] = clamped;
  }
  return out;
}

export function compileMarketletExposure(input: {
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly marketletWeights: Readonly<Record<MarketletId, number>>;
}): Readonly<Record<SecurityId, number>> {
  const out = {} as Record<SecurityId, number>;
  const marketletWeights = clampMarketletWeights(input);
  for (const spec of input.marketletSpecs) {
    if (!spec.active) continue;
    const marketletWeight = marketletWeights[spec.marketletId] ?? 0;
    if (Math.abs(marketletWeight) <= EPS) continue;
    for (const [securityId, securityWeight] of Object.entries(spec.securityWeights)) {
      addSecurityQuantity(out, securityId as SecurityId, marketletWeight * securityWeight);
    }
  }
  return out;
}

export function compileMarketletExposureFromBidOffer(input: {
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly marketletBidOfferWeights: Readonly<Record<MarketletId, BidOfferQuantity>>;
}): Readonly<Record<SecurityId, number>> {
  const out = {} as Record<SecurityId, number>;
  const marketletBidOfferWeights = clampMarketletBidOfferWeights(input);
  for (const spec of input.marketletSpecs) {
    if (!spec.active) continue;
    const bidOfferWeight = marketletBidOfferWeights[spec.marketletId] ?? {
      bidQuantity: 0,
      offerQuantity: 0,
    };
    const marketletWeight = netBidOfferQuantity(bidOfferWeight);
    if (Math.abs(marketletWeight) <= EPS) continue;
    for (const [securityId, securityWeight] of Object.entries(spec.securityWeights)) {
      addSecurityQuantity(out, securityId as SecurityId, marketletWeight * securityWeight);
    }
  }
  return out;
}

export function compileDirectionMarketletWeights(input: {
  readonly routeSpecs: readonly DirectionExecutionRouteSpec[];
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionWeights: Readonly<Record<DirectionId, number>>;
}): Readonly<Record<MarketletId, number>> {
  const out = {} as Record<MarketletId, number>;
  const directionWeights = clampDirectionWeights({
    directionSpecs: input.directionSpecs,
    directionWeights: input.directionWeights,
  });
  for (const route of input.routeSpecs) {
    if (!route.active) continue;
    const directionWeight = directionWeights[route.directionId] ?? 0;
    if (Math.abs(directionWeight) <= EPS) continue;
    for (const [marketletId, marketletWeight] of Object.entries(route.marketletWeights)) {
      const key = marketletId as MarketletId;
      const next = (out[key] ?? 0) + directionWeight * marketletWeight;
      if (Math.abs(next) <= EPS) {
        delete out[key];
        continue;
      }
      out[key] = next;
    }
  }
  return out;
}

export function compileRoutedDirectionExecution(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly routeSpecs: readonly DirectionExecutionRouteSpec[];
  readonly marketletSpecs: readonly MarketletSpec[];
  readonly directionWeights: Readonly<Record<DirectionId, number>>;
  readonly tolerance?: number;
}): RoutedDirectionExecution {
  const directionExposure = compileDirectionExposure({
    directionSpecs: input.directionSpecs,
    directionWeights: input.directionWeights,
  });
  const marketletWeights = compileDirectionMarketletWeights({
    routeSpecs: input.routeSpecs,
    directionWeights: input.directionWeights,
    directionSpecs: input.directionSpecs,
  });
  const clampedMarketletWeights = clampMarketletWeights({
    marketletSpecs: input.marketletSpecs,
    marketletWeights,
  });
  const marketletExposure = compileMarketletExposure({
    marketletSpecs: input.marketletSpecs,
    marketletWeights: clampedMarketletWeights,
  });
  const residual = computeDirectionMarketletResidual({
    directionExposure,
    marketletExposure,
  });

  return {
    directionExposure,
    marketletWeights: clampedMarketletWeights,
    marketletExposure,
    residual,
    matches: maxAbsDirectionMarketletResidual({
      directionExposure,
      marketletExposure,
    }) <= (input.tolerance ?? 1e-9),
  };
}

export function computeDirectionMarketletResidual(input: {
  readonly directionExposure: Readonly<Record<SecurityId, number>>;
  readonly marketletExposure: Readonly<Record<SecurityId, number>>;
}): readonly SecurityExposureResidual[] {
  const securityIds = new Set<SecurityId>([
    ...Object.keys(input.directionExposure) as SecurityId[],
    ...Object.keys(input.marketletExposure) as SecurityId[],
  ]);
  return [...securityIds]
    .map((securityId) => {
      const marketletQuantity = input.marketletExposure[securityId] ?? 0;
      const directionQuantity = input.directionExposure[securityId] ?? 0;
      return {
        securityId,
        marketletQuantity,
        directionQuantity,
        residualQuantity: marketletQuantity - directionQuantity,
      };
    })
    .filter((row) => Math.abs(row.residualQuantity) > EPS);
}

export function maxAbsDirectionMarketletResidual(input: {
  readonly directionExposure: Readonly<Record<SecurityId, number>>;
  readonly marketletExposure: Readonly<Record<SecurityId, number>>;
}): number {
  return computeDirectionMarketletResidual(input)
    .reduce((max, row) => Math.max(max, Math.abs(row.residualQuantity)), 0);
}

export function marketletMatchesDirection(input: {
  readonly directionExposure: Readonly<Record<SecurityId, number>>;
  readonly marketletExposure: Readonly<Record<SecurityId, number>>;
  readonly tolerance?: number;
}): boolean {
  return maxAbsDirectionMarketletResidual(input) <= (input.tolerance ?? 1e-9);
}
