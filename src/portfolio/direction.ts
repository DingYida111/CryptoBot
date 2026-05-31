import type { DirectionId, SecurityId } from "./ids.js";
import type { BidOfferQuantity, DirectionSpec } from "./portfolio_types.js";
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

export function clampDirectionWeights(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionWeights: Readonly<Record<DirectionId, number>>;
}): Readonly<Record<DirectionId, number>> {
  const out = {} as Record<DirectionId, number>;
  for (const spec of input.directionSpecs) {
    assertFiniteBounds({
      id: spec.directionId,
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (!spec.active) continue;
    const requestedWeight = input.directionWeights[spec.directionId] ?? 0;
    const clampedWeight = clampWeight(requestedWeight, spec.lowerBound, spec.upperBound);
    if (Math.abs(clampedWeight) <= EPS) continue;
    out[spec.directionId] = clampedWeight;
  }
  return out;
}

export function splitDirectionWeights(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionWeights: Readonly<Record<DirectionId, number>>;
}): Readonly<Record<DirectionId, BidOfferQuantity>> {
  const clampedWeights = clampDirectionWeights(input);
  const out = {} as Record<DirectionId, BidOfferQuantity>;
  for (const [directionId, directionWeight] of Object.entries(clampedWeights)) {
    out[directionId as DirectionId] = splitSignedQuantity(directionWeight);
  }
  return out;
}

export function clampDirectionBidOfferWeights(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionBidOfferWeights: Readonly<Record<DirectionId, BidOfferQuantity>>;
}): Readonly<Record<DirectionId, BidOfferQuantity>> {
  const out = {} as Record<DirectionId, BidOfferQuantity>;
  for (const spec of input.directionSpecs) {
    assertFiniteBounds({
      id: spec.directionId,
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (!spec.active) continue;
    const clamped = clampBidOfferQuantity({
      id: spec.directionId,
      quantity: input.directionBidOfferWeights[spec.directionId] ?? {
        bidQuantity: 0,
        offerQuantity: 0,
      },
      lowerBound: spec.lowerBound,
      upperBound: spec.upperBound,
    });
    if (Math.abs(clamped.bidQuantity) <= EPS && Math.abs(clamped.offerQuantity) <= EPS) continue;
    out[spec.directionId] = clamped;
  }
  return out;
}

export function compileDirectionExposure(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionWeights: Readonly<Record<DirectionId, number>>;
}): Readonly<Record<SecurityId, number>> {
  const out = {} as Record<SecurityId, number>;
  const directionWeights = clampDirectionWeights(input);
  for (const spec of input.directionSpecs) {
    if (!spec.active) continue;
    const directionWeight = directionWeights[spec.directionId] ?? 0;
    if (Math.abs(directionWeight) <= EPS) continue;
    for (const [securityId, securityWeight] of Object.entries(spec.securityWeights)) {
      addSecurityQuantity(out, securityId as SecurityId, directionWeight * securityWeight);
    }
  }
  return out;
}

export function compileDirectionExposureFromBidOffer(input: {
  readonly directionSpecs: readonly DirectionSpec[];
  readonly directionBidOfferWeights: Readonly<Record<DirectionId, BidOfferQuantity>>;
}): Readonly<Record<SecurityId, number>> {
  const out = {} as Record<SecurityId, number>;
  const directionBidOfferWeights = clampDirectionBidOfferWeights(input);
  for (const spec of input.directionSpecs) {
    if (!spec.active) continue;
    const bidOfferWeight = directionBidOfferWeights[spec.directionId] ?? {
      bidQuantity: 0,
      offerQuantity: 0,
    };
    const directionWeight = netBidOfferQuantity(bidOfferWeight);
    if (Math.abs(directionWeight) <= EPS) continue;
    for (const [securityId, securityWeight] of Object.entries(spec.securityWeights)) {
      addSecurityQuantity(out, securityId as SecurityId, directionWeight * securityWeight);
    }
  }
  return out;
}

export function buildDirectionTarget(input: {
  readonly currentSecurityExposure: Readonly<Record<SecurityId, number>>;
  readonly directionExposure: Readonly<Record<SecurityId, number>>;
}): Readonly<Record<SecurityId, number>> {
  const out = { ...input.currentSecurityExposure } as Record<SecurityId, number>;
  for (const [securityId, quantity] of Object.entries(input.directionExposure)) {
    addSecurityQuantity(out, securityId as SecurityId, quantity);
  }
  return out;
}
