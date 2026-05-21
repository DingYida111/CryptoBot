import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShadowRows } from "../shadow_report.js";

test("shadow report summarizes route and dq matches", () => {
  const summary = summarizeShadowRows([
    {
      actualRoute: "open_long",
      shadowRoute: "open_long",
      actualDqContracts: 2,
      shadowDqContracts: 2,
      actualBasisId: "basis:long_btc_swap",
      shadowBasisId: "basis:long_btc_swap",
      actualResidualContracts: 0,
      shadowResidualContracts: 0,
      shadowResidualReason: null,
      diffPct: 0,
      createdAt: 1,
    },
    {
      actualRoute: "grid_hold",
      shadowRoute: "noop",
      actualDqContracts: 0,
      shadowDqContracts: 0,
      actualBasisId: null,
      shadowBasisId: null,
      actualResidualContracts: 0,
      shadowResidualContracts: 0,
      shadowResidualReason: null,
      diffPct: 0,
      createdAt: 2,
    },
    {
      actualRoute: "close_long",
      shadowRoute: "residual",
      actualDqContracts: -3,
      shadowDqContracts: -2,
      actualBasisId: "basis:long_btc_swap",
      shadowBasisId: null,
      actualResidualContracts: 0,
      shadowResidualContracts: -2,
      shadowResidualReason: "UNROUTED_DECISION",
      diffPct: 33.3333,
      createdAt: 3,
    },
  ]);

  assert.equal(summary.totalRows, 3);
  assert.equal(summary.routeMatchCount, 1);
  assert.equal(summary.exactDqMatchCount, 2);
  assert.equal(summary.mismatchCount, 2);
  assert.equal(summary.residualRowCount, 1);
  assert.equal(summary.topRouteMismatches[0]?.actualRoute, "grid_hold");
  assert.equal(summary.residualReasonBreakdown[0]?.reason, "UNROUTED_DECISION");
  assert.equal(summary.maxDiffPct, 33.3333);
});
