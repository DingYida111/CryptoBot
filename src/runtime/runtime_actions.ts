import type { RuntimeMessageCategory, RuntimeMessageScope, RuntimeTraceMessage } from "../portfolio/decision_trace_report.js";

export type RuntimeActionType =
  | "global_halt"
  | "flatten_all"
  | "pause_instrument"
  | "flatten_instrument"
  | "record_warning"
  | "record_info";

export type RuntimeActionStatus = "proposed";

export type RuntimeActionExecutorStatus =
  | "proposed"
  | "dry_run_acknowledged"
  | "dry_run_cooldown_duplicate"
  | "live_executed"
  | "live_skipped";

export interface RuntimeProposedAction {
  readonly actionType: RuntimeActionType;
  readonly status: RuntimeActionStatus;
  readonly executionEnabled: boolean;
  readonly category: RuntimeMessageCategory;
  readonly scope: RuntimeMessageScope;
  readonly source: string;
  readonly traceVersion: string;
  readonly messageCode: string;
  readonly affectedInstrumentIds: readonly string[];
  readonly reason: string;
  readonly createdAt: number | null;
  readonly rawMessage: RuntimeTraceMessage;
}

export interface RuntimeActionReportRow {
  readonly id: number;
  readonly surface: string;
  readonly surfaceRowId: number;
  readonly messageCode: string;
  readonly category: string;
  readonly scope: string;
  readonly source: string;
  readonly traceVersion: string | null;
  readonly actionType: string;
  readonly status: string;
  readonly executionEnabled: boolean;
  readonly affectedInstrumentIds: readonly string[];
  readonly reason: string;
  readonly createdAt: number;
  readonly proposedAt: number;
  readonly updatedAt: number | null;
  readonly executorNote: string | null;
}

export interface RuntimeActionCooldownDuplicate {
  readonly id: number;
  readonly duplicateKey: string;
  readonly previousId: number;
  readonly elapsedMs: number;
  readonly actionType: string;
  readonly messageCode: string;
  readonly source: string;
  readonly instrumentId: string;
  readonly createdAt: number;
}

export interface RuntimeActionReport {
  readonly summary: {
    readonly totalActions: number;
    readonly proposedCount: number;
    readonly executionEnabledCount: number;
    readonly cooldownDuplicateCount: number;
    readonly cooldownDuplicateRate: number;
    readonly byActionType: ReadonlyArray<{ readonly actionType: string; readonly count: number }>;
    readonly byCategory: ReadonlyArray<{ readonly category: string; readonly count: number }>;
    readonly byStatus: ReadonlyArray<{ readonly status: string; readonly count: number }>;
    readonly bySource: ReadonlyArray<{ readonly source: string; readonly count: number }>;
    readonly byInstrument: ReadonlyArray<{ readonly instrumentId: string; readonly count: number }>;
  };
  readonly cooldown: {
    readonly windowMs: number;
    readonly duplicateCount: number;
    readonly duplicates: readonly RuntimeActionCooldownDuplicate[];
    readonly topDuplicateKeys: ReadonlyArray<{ readonly duplicateKey: string; readonly count: number }>;
  };
}

function action(input: {
  readonly actionType: RuntimeActionType;
  readonly message: RuntimeTraceMessage;
  readonly reason: string;
  readonly executionEnabled: boolean;
}): RuntimeProposedAction {
  return {
    actionType: input.actionType,
    status: "proposed",
    executionEnabled: input.executionEnabled,
    category: input.message.category,
    scope: input.message.scope,
    source: input.message.source,
    traceVersion: input.message.traceVersion,
    messageCode: input.message.code,
    affectedInstrumentIds: input.message.affectedInstrumentIds,
    reason: input.reason,
    createdAt: input.message.createdAt,
    rawMessage: input.message,
  };
}

export function buildRuntimeActionsForMessage(
  message: RuntimeTraceMessage,
  options: { readonly executionEnabled?: boolean } = {},
): readonly RuntimeProposedAction[] {
  const executionEnabled = options.executionEnabled ?? false;

  if (message.category === "major_error") {
    return [
      action({
        actionType: "global_halt",
        message,
        executionEnabled,
        reason: "Major runtime error requires global trading halt.",
      }),
      action({
        actionType: "flatten_all",
        message,
        executionEnabled,
        reason: "Major runtime error requires flattening all open exposure.",
      }),
    ];
  }

  if (message.category === "instrument_error") {
    return [
      action({
        actionType: "pause_instrument",
        message,
        executionEnabled,
        reason: "Instrument runtime error requires pausing affected instrument trading.",
      }),
      action({
        actionType: "flatten_instrument",
        message,
        executionEnabled,
        reason: "Instrument runtime error requires flattening affected instrument exposure.",
      }),
    ];
  }

  if (message.category === "warning") {
    return [
      action({
        actionType: "record_warning",
        message,
        executionEnabled: false,
        reason: "Warning is recorded for later review and does not alter trading.",
      }),
    ];
  }

  return [
    action({
      actionType: "record_info",
      message,
      executionEnabled: false,
      reason: "Info message is recorded only when normal operational message persistence is enabled.",
    }),
  ];
}

function countByLabel<K extends string>(
  values: readonly string[],
  label: K,
): ReadonlyArray<{ readonly [P in K]: string } & { readonly count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [label]: value, count }) as { [P in K]: string } & { count: number })
    .sort((a, b) => b.count - a.count || a[label].localeCompare(b[label]));
}

function instrumentKeys(row: RuntimeActionReportRow): readonly string[] {
  return row.affectedInstrumentIds.length > 0 ? row.affectedInstrumentIds : ["system"];
}

function duplicateKey(row: RuntimeActionReportRow, instrumentId: string): string {
  return [
    row.source,
    row.actionType,
    row.messageCode,
    instrumentId,
  ].join("|");
}

export function findRuntimeActionCooldownDuplicates(
  rows: readonly RuntimeActionReportRow[],
  cooldownMs: number,
): readonly RuntimeActionCooldownDuplicate[] {
  if (cooldownMs <= 0) return [];

  const lastSeen = new Map<string, RuntimeActionReportRow>();
  const duplicates: RuntimeActionCooldownDuplicate[] = [];
  const ordered = [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

  for (const row of ordered) {
    for (const instrumentId of instrumentKeys(row)) {
      const key = duplicateKey(row, instrumentId);
      const previous = lastSeen.get(key);
      if (previous) {
        const elapsedMs = row.createdAt - previous.createdAt;
        if (elapsedMs >= 0 && elapsedMs <= cooldownMs) {
          duplicates.push({
            id: row.id,
            duplicateKey: key,
            previousId: previous.id,
            elapsedMs,
            actionType: row.actionType,
            messageCode: row.messageCode,
            source: row.source,
            instrumentId,
            createdAt: row.createdAt,
          });
        }
      }
      lastSeen.set(key, row);
    }
  }

  return duplicates.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

export function summarizeRuntimeActions(
  rows: readonly RuntimeActionReportRow[],
  options: { readonly cooldownMs?: number } = {},
): RuntimeActionReport {
  const cooldownMs = options.cooldownMs ?? 300_000;
  const duplicates = findRuntimeActionCooldownDuplicates(rows, cooldownMs);
  const duplicateIds = new Set(duplicates.map((row) => row.id));
  const instrumentIds = rows.flatMap((row) => instrumentKeys(row));

  return {
    summary: {
      totalActions: rows.length,
      proposedCount: rows.filter((row) => row.status === "proposed").length,
      executionEnabledCount: rows.filter((row) => row.executionEnabled).length,
      cooldownDuplicateCount: duplicateIds.size,
      cooldownDuplicateRate: rows.length > 0 ? duplicateIds.size / rows.length : 0,
      byActionType: countByLabel(rows.map((row) => row.actionType), "actionType"),
      byCategory: countByLabel(rows.map((row) => row.category), "category"),
      byStatus: countByLabel(rows.map((row) => row.status), "status"),
      bySource: countByLabel(rows.map((row) => row.source), "source"),
      byInstrument: countByLabel(instrumentIds, "instrumentId"),
    },
    cooldown: {
      windowMs: cooldownMs,
      duplicateCount: duplicates.length,
      duplicates,
      topDuplicateKeys: countByLabel(duplicates.map((row) => row.duplicateKey), "duplicateKey").slice(0, 20),
    },
  };
}
