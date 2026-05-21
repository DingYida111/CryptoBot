import { asSecurityId } from "./ids.js";
import type { SecurityId } from "./ids.js";
import type { SecuritySpec } from "./portfolio_types.js";
import { SecuritySpecSchema } from "./schemas/security_schema.js";

export const BTC_DELTA = asSecurityId("BTC_DELTA");
export const USDT_CASH = asSecurityId("USDT_CASH");
export const BTC_PERP_FUNDING_OKX = asSecurityId("BTC_PERP_FUNDING_OKX");
export const ETH_DELTA = asSecurityId("ETH_DELTA");
export const XAU_DELTA = asSecurityId("XAU_DELTA");

function validateSecuritySpec(spec: SecuritySpec): SecuritySpec {
  return SecuritySpecSchema.parse(spec);
}

export const SECURITY_SPECS: readonly SecuritySpec[] = Object.freeze([
  validateSecuritySpec({
    securityId: BTC_DELTA,
    category: "delta",
    unit: "BTC",
    markSource: "okx_btc_swap_last",
    description: "BTC delta exposure from BTC-linked instruments",
    active: true,
  }),
  validateSecuritySpec({
    securityId: USDT_CASH,
    category: "cash",
    unit: "USDT",
    markSource: "wallet_balance",
    description: "USDT cash balance or margin balance placeholder",
    active: true,
  }),
  validateSecuritySpec({
    securityId: BTC_PERP_FUNDING_OKX,
    category: "funding",
    unit: "BTC",
    markSource: "okx_btc_perp_funding_placeholder",
    description: "BTC perpetual funding sensitivity placeholder for OKX",
    active: true,
  }),
  validateSecuritySpec({
    securityId: ETH_DELTA,
    category: "delta",
    unit: "ETH",
    markSource: "reserved",
    description: "Reserved ETH delta security",
    active: false,
  }),
  validateSecuritySpec({
    securityId: XAU_DELTA,
    category: "delta",
    unit: "XAU",
    markSource: "reserved",
    description: "Reserved XAU delta security",
    active: false,
  }),
]);

const SECURITY_SPEC_MAP = new Map<SecurityId, SecuritySpec>(
  SECURITY_SPECS.map((spec) => [spec.securityId, spec])
);

export function getSecuritySpec(securityId: SecurityId): SecuritySpec {
  const spec = SECURITY_SPEC_MAP.get(securityId);
  if (!spec) {
    throw new Error(`Unknown security spec: ${securityId}`);
  }
  return spec;
}

export function listActiveSecuritySpecs(): SecuritySpec[] {
  return SECURITY_SPECS.filter((spec) => spec.active);
}
