import { getDb } from "../monitor/storage.js";
import type { PortfolioShadowReportRow } from "./shadow_report.js";
import { summarizeShadowRows } from "./shadow_report.js";

interface ShadowRowDb {
  actual_route: string;
  shadow_route: string;
  actual_dq_contracts: number;
  shadow_dq_contracts: number;
  actual_basis_id: string | null;
  shadow_basis_id: string | null;
  actual_residual_contracts: number | null;
  shadow_residual_contracts: number | null;
  shadow_residual_reason: string | null;
  diff_pct: number | null;
  created_at: number;
}

const limitArg = process.argv[2];
const parsedLimit = limitArg ? Number(limitArg) : 200;
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 200;

const db = getDb();
const rows = db.prepare(`
  SELECT
    actual_route,
    shadow_route,
    actual_dq_contracts,
    shadow_dq_contracts,
    actual_basis_id,
    shadow_basis_id,
    actual_residual_contracts,
    shadow_residual_contracts,
    shadow_residual_reason,
    diff_pct,
    created_at
  FROM portfolio_shadow_log
  ORDER BY id DESC
  LIMIT ?
`).all(limit) as ShadowRowDb[];

const mapped: PortfolioShadowReportRow[] = rows.map((row) => ({
  actualRoute: row.actual_route,
  shadowRoute: row.shadow_route,
  actualDqContracts: row.actual_dq_contracts,
  shadowDqContracts: row.shadow_dq_contracts,
  actualBasisId: row.actual_basis_id,
  shadowBasisId: row.shadow_basis_id,
  actualResidualContracts: row.actual_residual_contracts,
  shadowResidualContracts: row.shadow_residual_contracts,
  shadowResidualReason: row.shadow_residual_reason,
  diffPct: row.diff_pct,
  createdAt: row.created_at,
}));

const summary = summarizeShadowRows(mapped);
console.log(JSON.stringify({ limit, summary }, null, 2));
