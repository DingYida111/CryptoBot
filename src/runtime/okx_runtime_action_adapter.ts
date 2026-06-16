import { closeAllPositions } from "../trade/okx_trade.js";
import type { RuntimeActionExecutionAdapter, RuntimeActionAdapterOperation } from "./runtime_action_adapter.js";
import type { RuntimeActionReportRow } from "./runtime_actions.js";

const SUPPORTED = new Set(["flatten_all", "global_halt"]);

export function createOkxRuntimeActionAdapter(): RuntimeActionExecutionAdapter {
  return {
    name: "okx_runtime_action_adapter",
    configured: true,
    supports(actionType: string): boolean {
      return SUPPORTED.has(actionType);
    },
    describeOperation(row: RuntimeActionReportRow): RuntimeActionAdapterOperation | null {
      if (!SUPPORTED.has(row.actionType)) return null;
      return {
        adapterName: "okx_runtime_action_adapter",
        actionType: row.actionType,
        target: "system",
        affectedInstrumentIds: row.affectedInstrumentIds,
        description: `OKX: close all BTC-USDT-SWAP positions (${row.actionType})`,
      };
    },
  };
}

export async function executeOkxRuntimeAction(actionType: string): Promise<{ success: boolean; note: string }> {
  if (actionType === "flatten_all" || actionType === "global_halt") {
    await closeAllPositions("BTC-USDT-SWAP");
    return { success: true, note: `Closed all BTC-USDT-SWAP positions via ${actionType}` };
  }
  return { success: false, note: `Action ${actionType} not supported by OKX adapter` };
}
