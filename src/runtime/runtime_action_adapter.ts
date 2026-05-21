import type { RuntimeActionReportRow } from "./runtime_actions.js";

export interface RuntimeActionAdapterOperation {
  readonly adapterName: string;
  readonly actionType: string;
  readonly target: "system" | "instrument" | "record";
  readonly affectedInstrumentIds: readonly string[];
  readonly description: string;
}

export interface RuntimeActionExecutionAdapter {
  readonly name: string;
  readonly configured: boolean;
  supports(actionType: string): boolean;
  describeOperation(row: RuntimeActionReportRow): RuntimeActionAdapterOperation | null;
}

const NOOP_SUPPORTED_ACTIONS = new Set([
  "global_halt",
  "flatten_all",
  "pause_instrument",
  "flatten_instrument",
  "record_warning",
  "record_info",
]);

function targetForAction(actionType: string): RuntimeActionAdapterOperation["target"] {
  if (actionType === "global_halt" || actionType === "flatten_all") return "system";
  if (actionType === "pause_instrument" || actionType === "flatten_instrument") return "instrument";
  return "record";
}

function descriptionForAction(actionType: string, affectedInstrumentIds: readonly string[]): string {
  const instruments = affectedInstrumentIds.length > 0 ? affectedInstrumentIds.join(",") : "system";
  if (actionType === "global_halt") return "Would halt all automated trading loops.";
  if (actionType === "flatten_all") return "Would flatten all open exposure.";
  if (actionType === "pause_instrument") return `Would pause trading for ${instruments}.`;
  if (actionType === "flatten_instrument") return `Would flatten exposure for ${instruments}.`;
  if (actionType === "record_warning") return "Would acknowledge warning without trading intervention.";
  if (actionType === "record_info") return "Would acknowledge info without trading intervention.";
  return `No operation description is available for ${actionType}.`;
}

export function createNoopRuntimeActionExecutionAdapter(
  options: { readonly configured?: boolean } = {},
): RuntimeActionExecutionAdapter {
  return {
    name: "noop_runtime_action_adapter",
    configured: options.configured ?? false,
    supports(actionType: string): boolean {
      return NOOP_SUPPORTED_ACTIONS.has(actionType);
    },
    describeOperation(row: RuntimeActionReportRow): RuntimeActionAdapterOperation | null {
      if (!NOOP_SUPPORTED_ACTIONS.has(row.actionType)) return null;
      return {
        adapterName: "noop_runtime_action_adapter",
        actionType: row.actionType,
        target: targetForAction(row.actionType),
        affectedInstrumentIds: row.affectedInstrumentIds,
        description: descriptionForAction(row.actionType, row.affectedInstrumentIds),
      };
    },
  };
}
