import type { RuntimeActionExecutionPlanRow } from "./runtime_action_executor.js";
import type { RuntimeActionReportRow } from "./runtime_actions.js";

export type RuntimeControlEffectType =
  | "global_halt"
  | "flatten_all_request"
  | "instrument_pause"
  | "flatten_instrument_request";

export type RuntimeControlEffectScope = "system" | "instrument";

export interface RuntimeControlEffect {
  readonly effectType: RuntimeControlEffectType;
  readonly scope: RuntimeControlEffectScope;
  readonly targetId: string;
  readonly value: "active" | "requested";
  readonly reason: string;
}

export interface RuntimeControlEffectLedgerRow extends RuntimeControlEffect {
  readonly runtimeActionId: number;
  readonly source: string;
  readonly actionType: string;
  readonly messageCode: string;
  readonly status: "planned";
}

function instrumentTargets(row: RuntimeActionReportRow): readonly string[] {
  return row.affectedInstrumentIds.length > 0 ? row.affectedInstrumentIds : [];
}

export function buildRuntimeControlEffectsForAction(
  row: RuntimeActionReportRow,
): readonly RuntimeControlEffect[] {
  if (row.actionType === "global_halt") {
    return [{
      effectType: "global_halt",
      scope: "system",
      targetId: "system",
      value: "active",
      reason: row.reason,
    }];
  }

  if (row.actionType === "flatten_all") {
    return [{
      effectType: "flatten_all_request",
      scope: "system",
      targetId: "system",
      value: "requested",
      reason: row.reason,
    }];
  }

  if (row.actionType === "pause_instrument") {
    return instrumentTargets(row).map((targetId) => ({
      effectType: "instrument_pause",
      scope: "instrument",
      targetId,
      value: "active",
      reason: row.reason,
    }));
  }

  if (row.actionType === "flatten_instrument") {
    return instrumentTargets(row).map((targetId) => ({
      effectType: "flatten_instrument_request",
      scope: "instrument",
      targetId,
      value: "requested",
      reason: row.reason,
    }));
  }

  return [];
}

export function summarizeRuntimeControlEffects(
  rows: readonly RuntimeActionExecutionPlanRow[],
): ReadonlyArray<{ readonly effectType: RuntimeControlEffectType; readonly count: number }> {
  const counts = new Map<RuntimeControlEffectType, number>();
  for (const row of rows) {
    for (const effect of row.controlEffects) {
      counts.set(effect.effectType, (counts.get(effect.effectType) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([effectType, count]) => ({ effectType, count }))
    .sort((a, b) => b.count - a.count || a.effectType.localeCompare(b.effectType));
}

export function buildRuntimeControlEffectLedgerRows(
  rows: readonly RuntimeActionExecutionPlanRow[],
): readonly RuntimeControlEffectLedgerRow[] {
  return rows.flatMap((row) =>
    row.controlEffects.map((effect) => ({
      ...effect,
      runtimeActionId: row.id,
      source: row.source,
      actionType: row.actionType,
      messageCode: row.messageCode,
      status: "planned" as const,
    }))
  );
}
