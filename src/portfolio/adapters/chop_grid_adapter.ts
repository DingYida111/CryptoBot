import type { ChopGridSnapshot } from "../../trade/chop_grid.js";

export function chopGridMetadata(snapshot: ChopGridSnapshot): Readonly<Record<string, string | number | boolean>> {
  return {
    gridActive: snapshot.active,
    gridSide: snapshot.side ?? "flat",
    gridAnchorPrice: snapshot.anchorPrice ?? 0,
    gridEntryPrice: snapshot.entryPrice ?? 0,
    gridInventory: snapshot.inventory,
    gridPendingOrderCount: snapshot.pendingOrderCount,
    gridReason: snapshot.reason,
  };
}
