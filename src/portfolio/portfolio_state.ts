import type { InstrumentPosition, PortfolioState, ResidualPosition, SecurityExposure } from "./portfolio_types.js";

function toReadonlyNumberRecord<T extends string>(rows: ReadonlyArray<{ key: T; value: number }>): Readonly<Record<T, number>> {
  const out = {} as Record<T, number>;
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}

export function buildPortfolioState(input: {
  asOfMs: number;
  instrumentPositions: readonly InstrumentPosition[];
  securityExposures: readonly SecurityExposure[];
  cashBalances?: Readonly<Record<string, number>>;
  residualPositions?: readonly ResidualPosition[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}): PortfolioState {
  const instrumentPositions = toReadonlyNumberRecord(
    input.instrumentPositions.map((row) => ({ key: row.instrumentId, value: row.quantity }))
  );
  const securityExposures = toReadonlyNumberRecord(
    input.securityExposures.map((row) => ({ key: row.securityId, value: row.quantity }))
  );
  const residualPositions = toReadonlyNumberRecord(
    (input.residualPositions ?? []).map((row) => ({ key: row.instrumentId, value: row.quantity }))
  );

  return {
    asOfMs: input.asOfMs,
    instrumentPositions,
    securityExposures,
    cashBalances: input.cashBalances ?? {},
    residualPositions,
    metadata: input.metadata ?? {},
  };
}
