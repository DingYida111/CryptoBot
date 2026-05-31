import type { BidOfferLinearValue, BidOfferQuantity } from "./portfolio_types.js";

const EPS = 1e-12;

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonnegative(value: number): number {
  return Math.max(finiteOrZero(value), 0);
}

export function assertFiniteBounds(input: {
  readonly id: string;
  readonly lowerBound: number;
  readonly upperBound: number;
}): void {
  if (!Number.isFinite(input.lowerBound) || !Number.isFinite(input.upperBound)) {
    throw new Error(`${input.id} bounds must be finite`);
  }
  if (input.lowerBound > input.upperBound) {
    throw new Error(`${input.id} lowerBound must be <= upperBound`);
  }
}

export function splitSignedQuantity(quantity: number): BidOfferQuantity {
  const safeQuantity = finiteOrZero(quantity);
  return {
    bidQuantity: Math.max(safeQuantity, 0),
    offerQuantity: Math.max(-safeQuantity, 0),
  };
}

export function netBidOfferQuantity(quantity: BidOfferQuantity): number {
  return nonnegative(quantity.bidQuantity) - nonnegative(quantity.offerQuantity);
}

export function clampBidOfferQuantity(input: {
  readonly id: string;
  readonly quantity: BidOfferQuantity;
  readonly lowerBound: number;
  readonly upperBound: number;
}): BidOfferQuantity {
  assertFiniteBounds(input);
  const bidUpper = Math.max(input.upperBound, 0);
  const offerUpper = Math.max(-input.lowerBound, 0);
  const bidQuantity = Math.min(nonnegative(input.quantity.bidQuantity), bidUpper);
  const offerQuantity = Math.min(nonnegative(input.quantity.offerQuantity), offerUpper);
  if (bidQuantity <= EPS && offerQuantity <= EPS) {
    return { bidQuantity: 0, offerQuantity: 0 };
  }
  return { bidQuantity, offerQuantity };
}

export function linearBidOfferValue(input: {
  readonly quantity: BidOfferQuantity;
  readonly value: BidOfferLinearValue;
}): number {
  return (
    nonnegative(input.quantity.bidQuantity) * finiteOrZero(input.value.bid) +
    nonnegative(input.quantity.offerQuantity) * finiteOrZero(input.value.offer)
  );
}
