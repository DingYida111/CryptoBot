import { getDb, updateRuntimeActionStatus } from "../monitor/storage.js";
import {
  createNoopRuntimeActionExecutionAdapter,
  type RuntimeActionAdapterOperation,
  type RuntimeActionExecutionAdapter,
} from "./runtime_action_adapter.js";
import {
  buildRuntimeControlEffectsForAction,
  summarizeRuntimeControlEffects,
  type RuntimeControlEffect,
} from "./runtime_control.js";
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

export type RuntimeActionExecutionBlockerCode =
  | "LIVE_EXECUTION_NOT_ENABLED"
  | "TRADING_ADAPTER_NOT_CONFIGURED"
  | "ADAPTER_ACTION_UNSUPPORTED"
  | "AFFECTED_INSTRUMENT_MISSING"
  | "COOLDOWN_DUPLICATE"
  | "RECORD_ONLY_ACTION"
  | "UNSUPPORTED_ACTION";

export interface RuntimeActionExecutionBlocker {
  readonly code: RuntimeActionExecutionBlockerCode;
  readonly message: string;
}

export interface RuntimeActionExecutionPreflightOptions {
  readonly liveExecutionEnabled?: boolean;
  readonly tradingAdapterConfigured?: boolean;
  readonly adapter?: RuntimeActionExecutionAdapter;
}

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
  readonly readyForLiveExecution: boolean;
  readonly blockerCodes: readonly RuntimeActionExecutionBlockerCode[];
  readonly blockers: readonly RuntimeActionExecutionBlocker[];
  readonly adapterName: string | null;
  readonly adapterOperation: RuntimeActionAdapterOperation | null;
  readonly controlEffects: readonly RuntimeControlEffect[];
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
  readonly readyForLiveExecutionCount: number;
  readonly blockedCount: number;
  readonly adapterOperationCount: number;
  readonly controlEffectCount: number;
  readonly controlEffectSummary: ReturnType<typeof summarizeRuntimeControlEffects>;
  readonly blockerSummary: ReadonlyArray<{
    readonly code: RuntimeActionExecutionBlockerCode;
    readonly count: number;
  }>;
  readonly rows: readonly RuntimeActionExecutionPlanRow[];
}

export interface RuntimeActionExecutorOptions {
  readonly limit: number;
  readonly source?: string | null;
  readonly actionType?: string | null;
  readonly instrumentId?: string | null;
  readonly status?: string;
  readonly cooldownMs?: number;
  readonly ackDryRun?: boolean;
  readonly liveExecutionEnabled?: boolean;
  readonly tradingAdapterConfigured?: boolean;
}

export interface RuntimeActionExecutorResult {
  readonly limit: number;
  readonly source: string | null;
  readonly actionType: string | null;
  readonly instrumentId: string | null;
  readonly inputStatus: string;
  readonly cooldownMs: number;
  readonly dryRun: true;
  readonly executionEnabled: false;
  readonly ackDryRun: boolean;
  readonly liveExecutionEnabled: boolean;
  readonly tradingAdapterConfigured: boolean;
  readonly acknowledgedCount: number;
  readonly plan: RuntimeActionExecutionPlan;
}

interface RuntimeActionDbRow {
  readonly id: number;
  readonly surface: string;
  readonly surface_row_id: number;
  readonly message_code: string;
  readonly category: string;
  readonly scope: string;
  readonly source: string;
  readonly trace_version: string | null;
  readonly action_type: string;
  readonly status: string;
  readonly execution_enabled: number;
  readonly affected_instrument_ids_json: string;
  readonly reason: string;
  readonly created_at: number;
  readonly proposed_at: number;
  readonly updated_at: number | null;
  readonly executor_note: string | null;
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

function countBlockers(
  rows: readonly RuntimeActionExecutionPlanRow[],
): RuntimeActionExecutionPlan["blockerSummary"] {
  const counts = new Map<RuntimeActionExecutionBlockerCode, number>();
  for (const row of rows) {
    for (const code of row.blockerCodes) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function blocker(code: RuntimeActionExecutionBlockerCode, message: string): RuntimeActionExecutionBlocker {
  return { code, message };
}

function executableBlockers(
  row: RuntimeActionReportRow,
  options: RuntimeActionExecutionPreflightOptions,
): RuntimeActionExecutionBlocker[] {
  const blockers: RuntimeActionExecutionBlocker[] = [];
  const adapter = options.adapter ?? createNoopRuntimeActionExecutionAdapter();
  const tradingAdapterConfigured = options.tradingAdapterConfigured ?? adapter.configured;
  if (!options.liveExecutionEnabled) {
    blockers.push(blocker("LIVE_EXECUTION_NOT_ENABLED", "Live runtime action execution is not enabled."));
  }
  if (!tradingAdapterConfigured) {
    blockers.push(blocker("TRADING_ADAPTER_NOT_CONFIGURED", "No live runtime action trading adapter is configured."));
  }
  if (!adapter.supports(row.actionType)) {
    blockers.push(blocker("ADAPTER_ACTION_UNSUPPORTED", `Configured adapter ${adapter.name} does not support ${row.actionType}.`));
  }
  if (
    (row.actionType === "pause_instrument" || row.actionType === "flatten_instrument") &&
    row.affectedInstrumentIds.length === 0
  ) {
    blockers.push(blocker("AFFECTED_INSTRUMENT_MISSING", "Instrument action has no affected instrument IDs."));
  }
  return blockers;
}

function operationForRow(
  row: RuntimeActionReportRow,
  preflight: RuntimeActionExecutionPreflightOptions,
): RuntimeActionAdapterOperation | null {
  const adapter = preflight.adapter ?? createNoopRuntimeActionExecutionAdapter({
    configured: preflight.tradingAdapterConfigured,
  });
  return adapter.describeOperation(row);
}

function parseInstrumentIds(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === "string").sort();
  } catch {
    return [];
  }
}

function toReportRow(row: RuntimeActionDbRow): RuntimeActionReportRow {
  return {
    id: row.id,
    surface: row.surface,
    surfaceRowId: row.surface_row_id,
    messageCode: row.message_code,
    category: row.category,
    scope: row.scope,
    source: row.source,
    traceVersion: row.trace_version,
    actionType: row.action_type,
    status: row.status,
    executionEnabled: row.execution_enabled === 1,
    affectedInstrumentIds: parseInstrumentIds(row.affected_instrument_ids_json),
    reason: row.reason,
    createdAt: row.created_at,
    proposedAt: row.proposed_at,
    updatedAt: row.updated_at,
    executorNote: row.executor_note,
  };
}

function addFilter(
  filters: string[],
  params: Array<string | number>,
  column: string,
  value: string | null,
): void {
  if (value === null) return;
  filters.push(`${column} = ?`);
  params.push(value);
}

export function queryRuntimeActionRows(options: RuntimeActionExecutorOptions): readonly RuntimeActionReportRow[] {
  const db = getDb();
  const filters: string[] = [];
  const params: Array<string | number> = [];
  const status = options.status ?? "proposed";

  addFilter(filters, params, "source", options.source ?? null);
  addFilter(filters, params, "action_type", options.actionType ?? null);
  addFilter(filters, params, "status", status);
  params.push(options.limit);

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  return (db.prepare(`
    SELECT
      id,
      surface,
      surface_row_id,
      message_code,
      category,
      scope,
      source,
      trace_version,
      action_type,
      status,
      execution_enabled,
      affected_instrument_ids_json,
      reason,
      created_at,
      proposed_at,
      updated_at,
      executor_note
    FROM runtime_actions
    ${whereClause}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params) as RuntimeActionDbRow[])
    .map(toReportRow)
    .filter((row) => options.instrumentId === null || options.instrumentId === undefined
      || row.affectedInstrumentIds.includes(options.instrumentId));
}

function planRow(
  row: RuntimeActionReportRow,
  duplicateIds: ReadonlySet<number>,
  preflight: RuntimeActionExecutionPreflightOptions,
): RuntimeActionExecutionPlanRow {
  const adapter = preflight.adapter ?? createNoopRuntimeActionExecutionAdapter({
    configured: preflight.tradingAdapterConfigured,
  });
  if (duplicateIds.has(row.id)) {
    const blockers = [
      blocker("COOLDOWN_DUPLICATE", "Action is a cooldown duplicate of a recent action."),
    ];
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
      readyForLiveExecution: false,
      blockerCodes: blockers.map((row) => row.code),
      blockers,
      adapterName: adapter.name,
      adapterOperation: null,
      controlEffects: [],
      executorNote: "Dry-run executor marked this proposed action as a cooldown duplicate.",
    };
  }

  if (EXECUTABLE_ACTION_TYPES.has(row.actionType)) {
    const blockers = executableBlockers(row, preflight);
    const adapterOperation = operationForRow(row, preflight);
    const controlEffects = blockers.length === 0
      ? buildRuntimeControlEffectsForAction(row)
      : [];
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
      readyForLiveExecution: blockers.length === 0,
      blockerCodes: blockers.map((row) => row.code),
      blockers,
      adapterName: adapter.name,
      adapterOperation,
      controlEffects,
      executorNote: `Dry-run executor would run ${row.actionType} if live execution were enabled.`,
    };
  }

  if (RECORD_ONLY_ACTION_TYPES.has(row.actionType)) {
    const blockers = [
      blocker("RECORD_ONLY_ACTION", "Record-only action does not require live trading execution."),
    ];
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
      readyForLiveExecution: false,
      blockerCodes: blockers.map((row) => row.code),
      blockers,
      adapterName: adapter.name,
      adapterOperation: operationForRow(row, preflight),
      controlEffects: [],
      executorNote: `Dry-run executor acknowledges ${row.actionType}; no trading intervention is expected.`,
    };
  }

  const blockers = [
    blocker("UNSUPPORTED_ACTION", `Action type ${row.actionType} is not supported by the runtime action executor.`),
  ];
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
    readyForLiveExecution: false,
    blockerCodes: blockers.map((row) => row.code),
    blockers,
    adapterName: adapter.name,
    adapterOperation: null,
    controlEffects: [],
    executorNote: `Dry-run executor does not know how to handle ${row.actionType}.`,
  };
}

export function buildRuntimeActionExecutionPlan(input: {
  readonly rows: readonly RuntimeActionReportRow[];
  readonly cooldownMs: number;
  readonly ackDryRun: boolean;
  readonly preflight?: RuntimeActionExecutionPreflightOptions;
}): RuntimeActionExecutionPlan {
  const duplicates = findRuntimeActionCooldownDuplicates(input.rows, input.cooldownMs);
  const duplicateIds = new Set(duplicates.map((row) => row.id));
  const preflight = input.preflight ?? {};
  const rows = input.rows.map((row) => planRow(row, duplicateIds, preflight));

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
    readyForLiveExecutionCount: rows.filter((row) => row.readyForLiveExecution).length,
    blockedCount: rows.filter((row) => !row.readyForLiveExecution).length,
    adapterOperationCount: rows.filter((row) => row.adapterOperation !== null).length,
    controlEffectCount: rows.reduce((sum, row) => sum + row.controlEffects.length, 0),
    controlEffectSummary: summarizeRuntimeControlEffects(rows),
    blockerSummary: countBlockers(rows),
    rows,
  };
}

export function executeRuntimeActionDryRun(
  options: RuntimeActionExecutorOptions,
): RuntimeActionExecutorResult {
  const rows = queryRuntimeActionRows(options);
  const cooldownMs = options.cooldownMs ?? 300_000;
  const ackDryRun = options.ackDryRun ?? false;
  const liveExecutionEnabled = options.liveExecutionEnabled ?? false;
  const tradingAdapterConfigured = options.tradingAdapterConfigured ?? false;
  const adapter = createNoopRuntimeActionExecutionAdapter({
    configured: tradingAdapterConfigured,
  });
  const plan = buildRuntimeActionExecutionPlan({
    rows,
    cooldownMs,
    ackDryRun,
    preflight: {
      liveExecutionEnabled,
      tradingAdapterConfigured,
      adapter,
    },
  });
  const acknowledgedAt = Date.now();
  const acknowledgedCount = ackDryRun
    ? plan.rows.filter((row) =>
        updateRuntimeActionStatus({
          id: row.id,
          status: row.nextStatus,
          updatedAt: acknowledgedAt,
          executorNote: row.executorNote,
        })
      ).length
    : 0;

  return {
    limit: options.limit,
    source: options.source ?? null,
    actionType: options.actionType ?? null,
    instrumentId: options.instrumentId ?? null,
    inputStatus: options.status ?? "proposed",
    cooldownMs,
    dryRun: true,
    executionEnabled: false,
    ackDryRun,
    liveExecutionEnabled,
    tradingAdapterConfigured,
    acknowledgedCount,
    plan,
  };
}
