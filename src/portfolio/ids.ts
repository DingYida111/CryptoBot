export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SecurityId = Brand<string, "SecurityId">;
export type InstrumentId = Brand<string, "InstrumentId">;
export type StrategyBasisId = Brand<string, "StrategyBasisId">;
export type StrategyId = Brand<string, "StrategyId">;
export type ResidualReasonCode = Brand<string, "ResidualReasonCode">;

export function asSecurityId(value: string): SecurityId {
  return value as SecurityId;
}

export function asInstrumentId(value: string): InstrumentId {
  return value as InstrumentId;
}

export function asStrategyBasisId(value: string): StrategyBasisId {
  return value as StrategyBasisId;
}

export function asStrategyId(value: string): StrategyId {
  return value as StrategyId;
}

export function asResidualReasonCode(value: string): ResidualReasonCode {
  return value as ResidualReasonCode;
}
