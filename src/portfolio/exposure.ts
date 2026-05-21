import type { InstrumentPosition, InstrumentSpec, SecurityExposure, SecuritySpec } from "./portfolio_types.js";
import { getSecuritySpec } from "./security_spec.js";

export function aggregateExposure(rows: SecurityExposure[]): SecurityExposure[] {
  const merged = new Map<string, SecurityExposure>();
  for (const row of rows) {
    const existing = merged.get(row.securityId);
    if (!existing) {
      merged.set(row.securityId, row);
      continue;
    }
    merged.set(row.securityId, {
      ...existing,
      quantity: existing.quantity + row.quantity,
    });
  }
  return [...merged.values()].filter((row) => Math.abs(row.quantity) > 1e-12);
}

export function computeExposure(
  positions: readonly InstrumentPosition[],
  instrumentSpecs: ReadonlyMap<string, InstrumentSpec>
): SecurityExposure[] {
  const rows: SecurityExposure[] = [];
  for (const position of positions) {
    const spec = instrumentSpecs.get(position.instrumentId);
    if (!spec) {
      throw new Error(`Missing instrument spec for ${position.instrumentId}`);
    }
    for (const [securityId, qtyPerContract] of Object.entries(spec.exposurePerContract)) {
      if (qtyPerContract === undefined) continue;
      const securitySpec = getSecuritySpec(securityId as SecuritySpec["securityId"]);
      rows.push({
        securityId: securitySpec.securityId,
        quantity: position.quantity * qtyPerContract,
        unit: securitySpec.unit,
      });
    }
  }
  return aggregateExposure(rows);
}

export function computeUsdNotional(
  exposures: readonly SecurityExposure[],
  marks: Readonly<Record<string, number>>
): number {
  let total = 0;
  for (const exposure of exposures) {
    const mark = marks[exposure.securityId];
    if (!Number.isFinite(mark)) continue;
    total += exposure.quantity * mark;
  }
  return total;
}

export function computeDeltaPnl(
  exposures: readonly SecurityExposure[],
  priceChangeMap: Readonly<Record<string, number>>
): number {
  let pnl = 0;
  for (const exposure of exposures) {
    const dPrice = priceChangeMap[exposure.securityId];
    if (!Number.isFinite(dPrice)) continue;
    pnl += exposure.quantity * dPrice;
  }
  return pnl;
}

export function toInstrumentSpecMap(specs: readonly InstrumentSpec[]): ReadonlyMap<string, InstrumentSpec> {
  return new Map(specs.map((spec) => [spec.instrumentId, spec]));
}
