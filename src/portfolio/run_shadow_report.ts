import { getDb } from "../monitor/storage.js";
import { isRuntimeDecisionTrace, summarizeRuntimeDecisionTraces } from "./decision_trace_report.js";
import type { PortfolioShadowReportRow } from "./shadow_report.js";
import { extractShadowMismatchDetails, summarizeShadowRows } from "./shadow_report.js";

interface ShadowRowDb {
  shadow_version: string | null;
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
  raw_json: string;
  created_at: number;
}

interface ResidualRowDb {
  shadow_version: string | null;
  source: string;
  inst_id: string;
  quantity: number;
  reason_code: string;
  created_at: number;
}

interface CliOptions {
  readonly limit: number;
  readonly version: string | null;
  readonly allVersions: boolean;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 200;
  let version: string | null = null;
  let allVersions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--all") {
      allVersions = true;
      continue;
    }
    if (arg === "--version") {
      const next = argv[index + 1];
      if (next) {
        version = next;
        index += 1;
      }
      continue;
    }
    const parsed = Number(arg);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.floor(parsed);
    }
  }

  return {
    limit,
    version,
    allVersions,
  };
}

const options = parseCliOptions(process.argv.slice(2));
const limit = options.limit;

const db = getDb();

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const availableVersions = db.prepare(`
  SELECT DISTINCT shadow_version
  FROM portfolio_shadow_log
  WHERE shadow_version IS NOT NULL
  ORDER BY shadow_version DESC
`).all() as Array<{ shadow_version: string | null }>;

const latestVersionRow = db.prepare(`
  SELECT shadow_version
  FROM portfolio_shadow_log
  WHERE shadow_version IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
`).get() as { shadow_version: string | null } | undefined;

const resolvedVersion = options.allVersions
  ? null
  : options.version ?? latestVersionRow?.shadow_version ?? null;

const rows = resolvedVersion === null
  ? db.prepare(`
      SELECT
        shadow_version,
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
        raw_json,
        created_at
      FROM portfolio_shadow_log
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as ShadowRowDb[]
  : db.prepare(`
      SELECT
        shadow_version,
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
        raw_json,
        created_at
      FROM portfolio_shadow_log
      WHERE shadow_version = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(resolvedVersion, limit) as ShadowRowDb[];

const residualRows = resolvedVersion === null
  ? db.prepare(`
      SELECT shadow_version, source, inst_id, quantity, reason_code, created_at
      FROM portfolio_residuals
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.min(limit, 20)) as ResidualRowDb[]
  : db.prepare(`
      SELECT shadow_version, source, inst_id, quantity, reason_code, created_at
      FROM portfolio_residuals
      WHERE shadow_version = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(resolvedVersion, Math.min(limit, 20)) as ResidualRowDb[];

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
const mismatches = extractShadowMismatchDetails(mapped, 10);
const traceReport = summarizeRuntimeDecisionTraces(
  rows
    .map((row) => {
      const parsed = safeParseJson(row.raw_json);
      const trace = parsed?.decisionTrace;
      if (!isRuntimeDecisionTrace(trace)) return null;
      return { trace, createdAt: row.created_at };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null),
);
console.log(JSON.stringify({
  limit,
  shadowVersion: resolvedVersion,
  allVersions: options.allVersions,
  availableVersions: availableVersions
    .map((row) => row.shadow_version)
    .filter((value): value is string => value !== null),
  summary,
  mismatches,
  traceSummary: traceReport.summary,
  recentTraceAlerts: traceReport.alerts.slice(0, 20),
  recentTraceRows: traceReport.rows.slice(0, 10),
  recentResiduals: residualRows,
}, null, 2));
