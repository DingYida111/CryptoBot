import type { OkxInstrumentMeta } from "../monitor/okx.js";
import { asInstrumentId } from "./ids.js";
import type { InstrumentId } from "./ids.js";
import type { InstrumentSpec } from "./portfolio_types.js";
import { InstrumentSpecSchema } from "./schemas/instrument_schema.js";
import { BTC_DELTA, BTC_PERP_FUNDING_OKX, USDT_CASH } from "./security_spec.js";

export const OKX_BTC_USDT_SPOT = asInstrumentId("OKX:BTC-USDT");
export const OKX_BTC_USDT_SWAP = asInstrumentId("OKX:BTC-USDT-SWAP");
export const DEFAULT_BTC_SPOT_STEP_SIZE = 0.00000001;
export const DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER = 0.01;

function validateInstrumentSpec(spec: InstrumentSpec): InstrumentSpec {
  return InstrumentSpecSchema.parse(spec);
}

export function buildBtcSwapInstrumentSpec(contractMultiplier = DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER): InstrumentSpec {
  const exposurePerContract = {
    [BTC_DELTA]: contractMultiplier,
    [USDT_CASH]: 0,
    [BTC_PERP_FUNDING_OKX]: contractMultiplier,
  } as Record<typeof BTC_DELTA | typeof USDT_CASH | typeof BTC_PERP_FUNDING_OKX, number>;

  return validateInstrumentSpec({
    instrumentId: OKX_BTC_USDT_SWAP,
    kind: "perp",
    venue: "OKX",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    quantityUnit: "contract",
    priceUnit: "USDT",
    minTradeSize: 1,
    stepSize: 1,
    contractMultiplier,
    allowedSides: ["buy", "sell"],
    exposurePerContract,
    tags: ["btc", "perp", "okx", "active"],
  });
}

export function buildBtcSpotInstrumentSpec(spotStepSize = DEFAULT_BTC_SPOT_STEP_SIZE): InstrumentSpec {
  const exposurePerContract = {
    [BTC_DELTA]: 1,
    [USDT_CASH]: 0,
  } as Record<typeof BTC_DELTA | typeof USDT_CASH, number>;

  return validateInstrumentSpec({
    instrumentId: OKX_BTC_USDT_SPOT,
    kind: "spot",
    venue: "OKX",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    quantityUnit: "BTC",
    priceUnit: "USDT",
    minTradeSize: spotStepSize,
    stepSize: spotStepSize,
    contractMultiplier: 1,
    allowedSides: ["buy", "sell"],
    exposurePerContract,
    tags: ["btc", "spot", "okx", "active"],
  });
}

export function buildBtcSpotInstrumentSpecFromMeta(meta: OkxInstrumentMeta | null | undefined): InstrumentSpec {
  const stepSize =
    meta && typeof meta.lotSz === "number" && Number.isFinite(meta.lotSz) && meta.lotSz > 0
      ? meta.lotSz
      : DEFAULT_BTC_SPOT_STEP_SIZE;
  return buildBtcSpotInstrumentSpec(stepSize);
}

export function buildBtcSwapInstrumentSpecFromMeta(meta: OkxInstrumentMeta | null | undefined): InstrumentSpec {
  const multiplier =
    meta && typeof meta.ctVal === "number" && Number.isFinite(meta.ctVal) && meta.ctVal > 0
      ? meta.ctVal
      : DEFAULT_BTC_SWAP_CONTRACT_MULTIPLIER;
  return buildBtcSwapInstrumentSpec(multiplier);
}

export const INSTRUMENT_SPECS: readonly InstrumentSpec[] = Object.freeze([
  buildBtcSpotInstrumentSpec(),
  buildBtcSwapInstrumentSpec(),
]);

const INSTRUMENT_SPEC_MAP = new Map<InstrumentId, InstrumentSpec>(
  INSTRUMENT_SPECS.map((spec) => [spec.instrumentId, spec])
);

export function getInstrumentSpec(instrumentId: InstrumentId): InstrumentSpec {
  const spec = INSTRUMENT_SPEC_MAP.get(instrumentId);
  if (!spec) {
    throw new Error(`Unknown instrument spec: ${instrumentId}`);
  }
  return spec;
}

export function listActiveInstrumentSpecs(): InstrumentSpec[] {
  return [...INSTRUMENT_SPECS];
}
