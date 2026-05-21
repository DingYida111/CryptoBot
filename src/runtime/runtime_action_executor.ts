import {
  findRuntimeActionCooldownDuplicates,
  type RuntimeActionExecutorStatus,
  type RuntimeActionReportRow,
} from "./runtime_actions.js";

export type RuntimeActionExecutorDecision =
  | "dry_run_would_execute"
  | "dry_run_record_only"
  | "dry_run_cooldown_duplicate"
  | "dry_run_unsupported";

export interface RuntimeActionExecutionPlanRow {
  readonly id: number;
  readonly actionType: string;
  readonly status: string;
  readonly nextStatus: RuntimeActionExecutorStatus;
  readonly decision: RuntimeActionExecutorDecision;
  readonly executionEnabled: boolean;
  readonly affectedInstrumentIds: readonly string[];
  readonly source: string;
  readonly messageCode: string;
  readonly reason: string;
  readonly executorNote: string;
}

export interface RuntimeActionExecutionPlan {
  readonly dryRun: true;
  readonly ackDryRun: boolean;
  readonly executionEnabled: false;
  readonly cooldownMs: number;
  readonly totalCandidates: number;
  readonly wouldExecuteCount: number;
  readonly recordOnlyCount: number;
  readonly cooldownDuplicateCount: number;
  readonly unsupportedCount: number;
  readonly rows: readonly RuntimeActionExecutionPlanRow[];
}

const EXECUTABLE_ACTION_TYPES = new Set([
  "global_halt",
  "flatten_all",
  "pause_instrument",
  "flatten_instrument",
]);

const RECORD_ONLY_ACTION_TYPES = new Set([
  "record_warning",
  "record_info",
]);

function planRow(
  row: RuntimeActionReportRow,
  duplicateIds: ReadonlySet<number>,
): RuntimeActionExecutionPlanRow {
  if (duplicateIds.has(row.id)) {
    return {
      id: row.id,
      actionType: row.actionType,
      status: row.status,
      nextStatus: "dry_run_cooldown_duplicate",
      decision: "dry_run_cooldown_duplicate",
      executionEnabled: false,
      affectedInstrumentIds: row.affectedInstrumentIds,
      source: row.source,
      messageCode: row.messageCode,
      reason: row.reason,
      executorNote: "Dry-run executor marked this proposed action as a cooldown duplicate.",
    };
  }

  if (EXECUTABLE_ACTION_TYPES.has(row.actionType)) {
    return {
      id: row.id,
      actionType: row.actionType,
      status: row.status,
      nextStatus: "dry_run_acknowledged",
      decision: "dry_run_would_execute",
      executionEnabled: false,
      affectedInstrumentIds: row.affectedInstrumentIds,
      source: row.source,
      messageCode: row.messageCode,
      reason: row.reason,
      executorNote: `Dry-run executor would run ${row.actionType} if live execution were enabled.`,
    };
  }

  if (RECORD_ONLY_ACTION_TYPES.has(row.actionType)) {
    return {
      id: row.id,
      actionType: row.actionType,
      status: row.status,
      nextStatus: "dry_run_acknowledged",
      decision: "dry_run_record_only",
      executionEnabled: false,
      affectedInstrumentIds: row.affectedInstrumentIds,
      source: row.source,
      messageCode: row.messageCode,
      reason: row.reason,
      executorNote: `Dry-run executor acknowledges ${row.actionType}; no trading intervention is expected.`,
    };
  }

  return {
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    nextStatus: "dry_run_acknowledged",
    decision: "dry_run_unsupported",
    executionEnabled: false,
    affectedInstrumentIds: row.affectedInstrumentIds,
    source: row.source,
    messageCode: row.messageCode,
    reason: row.reason,
    executorNote: `Dry-run executor does not know how to handle ${row.actionType}.`,
  };
}

export function buildRuntimeActionExecutionPlan(input: {
  readonly rows: readonly RuntimeActionReportRow[];
  readonly cooldownMs: number;
  readonly ackDryRun: boolean;
}): RuntimeActionExecutionPlan {
  const duplicates = findRuntimeActionCooldownDuplicates(input.rows, input.cooldownMs);
  const duplicateIds = new Set(duplicates.map((row) => row.id));
  const rows = input.rows.map((row) => planRow(row, duplicateIds));

  return {
    dryRun: true,
    ackDryRun: input.ackDryRun,
    executionEnabled: false,
    cooldownMs: input.cooldownMs,
    totalCandidates: rows.length,
    wouldExecuteCount: rows.filter((row) => row.decision === "dry_run_would_execute").length,
    recordOnlyCount: rows.filter((row) => row.decision === "dry_run_record_only").length,
    cooldownDuplicateCount: rows.filter((row) => row.decision === "dry_run_cooldown_duplicate").length,
    unsupportedCount: rows.filter((row) => row.decision === "dry_run_unsupported").length,
    rows,
  };
}
