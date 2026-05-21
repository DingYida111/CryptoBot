import type { RuntimeMessageCategory, RuntimeMessageScope, RuntimeTraceMessage } from "../portfolio/decision_trace_report.js";

export type RuntimeActionType =
  | "global_halt"
  | "flatten_all"
  | "pause_instrument"
  | "flatten_instrument"
  | "record_warning"
  | "record_info";

export type RuntimeActionStatus = "proposed";

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
