import test from "node:test";
import assert from "node:assert/strict";

import { asDirectionId, asInstrumentId, asMarketletId } from "../ids.js";
import {
  compileDirectionExposure,
  compileDirectionExposureFromBidOffer,
  splitDirectionWeights,
} from "../direction.js";
import {
  compileDirectionMarketletWeights,
  compileMarketletExposure,
  compileMarketletExposureFromBidOffer,
  compileRoutedDirectionExecution,
  computeDirectionMarketletResidual,
  marketletMatchesDirection,
  splitMarketletWeights,
} from "../marketlet.js";
import { linearBidOfferValue } from "../side.js";
import type { DirectionExecutionRouteSpec, DirectionSpec, MarketletSpec } from "../portfolio_types.js";
import { BTC_DELTA, ETH_DELTA } from "../security_spec.js";

const BTC_ETH_SPREAD = asDirectionId("direction:btc_eth_spread");
const BTC_MARKETLET = asMarketletId("marketlet:test_btc");
const ETH_MARKETLET = asMarketletId("marketlet:test_eth");

const directionSpecs: readonly DirectionSpec[] = Object.freeze([
  {
    directionId: BTC_ETH_SPREAD,
    securityWeights: {
      [BTC_DELTA]: 1,
      [ETH_DELTA]: -40,
    },
    lowerBound: -2,
    upperBound: 2,
    description: "Example BTC/ETH relative-value spread direction",
    active: true,
    bidThreshold: -20,
    offerThreshold: 30,
    horizonMs: 15 * 60 * 1000,
    tags: ["example", "spread"],
  },
]);

const marketletSpecs: readonly MarketletSpec[] = Object.freeze([
  {
    marketletId: BTC_MARKETLET,
    instrumentWeights: {
      [asInstrumentId("TEST:BTC")]: 1,
    },
    securityWeights: {
      [BTC_DELTA]: 1,
    },
    lowerBound: -3,
    upperBound: 3,
    description: "Test BTC marketlet",
    active: true,
    tags: ["test"],
  },
  {
    marketletId: ETH_MARKETLET,
    instrumentWeights: {
      [asInstrumentId("TEST:ETH")]: 1,
    },
    securityWeights: {
      [ETH_DELTA]: 1,
    },
    lowerBound: -120,
    upperBound: 120,
    description: "Test ETH marketlet",
    active: true,
    tags: ["test"],
  },
]);

const routeSpecs: readonly DirectionExecutionRouteSpec[] = Object.freeze([
  {
    directionId: BTC_ETH_SPREAD,
    marketletWeights: {
      [BTC_MARKETLET]: 1,
      [ETH_MARKETLET]: -40,
    },
    description: "Execute one BTC/ETH spread unit with BTC and ETH marketlets",
    active: true,
    tags: ["example", "spread"],
  },
]);

test("direction exposure compiles into security-space weights", () => {
  const exposure = compileDirectionExposure({
    directionSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 2,
    },
  });

  assert.equal(exposure[BTC_DELTA], 2);
  assert.equal(exposure[ETH_DELTA], -80);
});

test("oversized direction request clamps to configured bounds", () => {
  const routed = compileRoutedDirectionExecution({
    directionSpecs,
    routeSpecs,
    marketletSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 10,
    },
  });

  assert.equal(routed.matches, true);
  assert.equal(routed.directionExposure[BTC_DELTA], 2);
  assert.equal(routed.directionExposure[ETH_DELTA], -80);
  assert.equal(routed.marketletWeights[BTC_MARKETLET], 2);
  assert.equal(routed.marketletWeights[ETH_MARKETLET], -80);
});

test("signed direction weights split into bid and offer quantities", () => {
  const bidSide = splitDirectionWeights({
    directionSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 1.25,
    },
  });
  const offerSide = splitDirectionWeights({
    directionSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: -1.5,
    },
  });

  assert.equal(bidSide[BTC_ETH_SPREAD]?.bidQuantity, 1.25);
  assert.equal(bidSide[BTC_ETH_SPREAD]?.offerQuantity, 0);
  assert.equal(offerSide[BTC_ETH_SPREAD]?.bidQuantity, 0);
  assert.equal(offerSide[BTC_ETH_SPREAD]?.offerQuantity, 1.5);
});

test("direction bid and offer quantities net to security exposure", () => {
  const exposure = compileDirectionExposureFromBidOffer({
    directionSpecs,
    directionBidOfferWeights: {
      [BTC_ETH_SPREAD]: {
        bidQuantity: 2,
        offerQuantity: 0.5,
      },
    },
  });

  assert.equal(exposure[BTC_DELTA], 1.5);
  assert.equal(exposure[ETH_DELTA], -60);
});

test("bid and offer values multiply side quantities directly", () => {
  const value = linearBidOfferValue({
    quantity: {
      bidQuantity: 2,
      offerQuantity: 0.5,
    },
    value: {
      bid: 30,
      offer: 18,
    },
  });

  assert.equal(value, 69);
});

test("marketlet exposure can exactly explain a direction", () => {
  const directionExposure = compileDirectionExposure({
    directionSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 2,
    },
  });
  const marketletExposure = compileMarketletExposure({
    marketletSpecs,
    marketletWeights: {
      [BTC_MARKETLET]: 2,
      [ETH_MARKETLET]: -80,
    },
  });

  assert.equal(marketletMatchesDirection({ directionExposure, marketletExposure }), true);
  assert.equal(computeDirectionMarketletResidual({ directionExposure, marketletExposure }).length, 0);
});

test("marketlet drift without active direction is visible as residual", () => {
  const directionExposure = compileDirectionExposure({
    directionSpecs,
    directionWeights: {},
  });
  const marketletExposure = compileMarketletExposure({
    marketletSpecs,
    marketletWeights: {
      [BTC_MARKETLET]: 1,
    },
  });
  const residual = computeDirectionMarketletResidual({ directionExposure, marketletExposure });

  assert.equal(marketletMatchesDirection({ directionExposure, marketletExposure }), false);
  assert.equal(residual.length, 1);
  assert.equal(residual[0]?.securityId, BTC_DELTA);
  assert.equal(residual[0]?.residualQuantity, 1);
});

test("signed marketlet weights split into bid and offer quantities", () => {
  const bidSide = splitMarketletWeights({
    marketletSpecs,
    marketletWeights: {
      [BTC_MARKETLET]: 1.5,
    },
  });
  const offerSide = splitMarketletWeights({
    marketletSpecs,
    marketletWeights: {
      [BTC_MARKETLET]: -1.25,
    },
  });

  assert.equal(bidSide[BTC_MARKETLET]?.bidQuantity, 1.5);
  assert.equal(bidSide[BTC_MARKETLET]?.offerQuantity, 0);
  assert.equal(offerSide[BTC_MARKETLET]?.bidQuantity, 0);
  assert.equal(offerSide[BTC_MARKETLET]?.offerQuantity, 1.25);
});

test("marketlet bid and offer quantities net to security exposure and respect bounds", () => {
  const exposure = compileMarketletExposureFromBidOffer({
    marketletSpecs,
    marketletBidOfferWeights: {
      [ETH_MARKETLET]: {
        bidQuantity: 10,
        offerQuantity: 200,
      },
    },
  });

  assert.equal(exposure[ETH_DELTA], -110);
});

test("approved route compiles direction weight into marketlet weights", () => {
  const marketletWeights = compileDirectionMarketletWeights({
    routeSpecs,
    directionSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 2,
    },
  });

  assert.equal(marketletWeights[BTC_MARKETLET], 2);
  assert.equal(marketletWeights[ETH_MARKETLET], -80);
});

test("routed direction execution satisfies Mx equals Dz", () => {
  const routed = compileRoutedDirectionExecution({
    directionSpecs,
    routeSpecs,
    marketletSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 2,
    },
  });

  assert.equal(routed.matches, true);
  assert.equal(routed.residual.length, 0);
  assert.equal(routed.directionExposure[BTC_DELTA], 2);
  assert.equal(routed.marketletExposure[BTC_DELTA], 2);
});

test("missing route leg creates explicit residual", () => {
  const routed = compileRoutedDirectionExecution({
    directionSpecs,
    routeSpecs: [
      {
        directionId: BTC_ETH_SPREAD,
        marketletWeights: {
          [BTC_MARKETLET]: 1,
        },
        description: "Broken route missing ETH leg",
        active: true,
        tags: ["test"],
      },
    ],
    marketletSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 1,
    },
  });

  assert.equal(routed.matches, false);
  assert.equal(routed.residual.length, 1);
  assert.equal(routed.residual[0]?.securityId, ETH_DELTA);
  assert.equal(routed.residual[0]?.residualQuantity, 40);
});

test("marketlet bounds can clamp execution and create explicit residual", () => {
  const ethBoundedMarketletSpecs: readonly MarketletSpec[] = Object.freeze([
    marketletSpecs[0]!,
    {
      ...marketletSpecs[1]!,
      lowerBound: -40,
      upperBound: 40,
    },
  ]);
  const routed = compileRoutedDirectionExecution({
    directionSpecs,
    routeSpecs,
    marketletSpecs: ethBoundedMarketletSpecs,
    directionWeights: {
      [BTC_ETH_SPREAD]: 2,
    },
  });

  assert.equal(routed.matches, false);
  assert.equal(routed.directionExposure[ETH_DELTA], -80);
  assert.equal(routed.marketletWeights[ETH_MARKETLET], -40);
  assert.equal(routed.marketletExposure[ETH_DELTA], -40);
  assert.equal(routed.residual.length, 1);
  assert.equal(routed.residual[0]?.securityId, ETH_DELTA);
  assert.equal(routed.residual[0]?.residualQuantity, 40);
});
