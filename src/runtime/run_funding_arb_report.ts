import { getDb } from "../monitor/storage.js";
import { isRuntimeDecisionTrace, summarizeRuntimeDecisionTraces } from "../portfolio/decision_trace_report.js";

interface PackageLedgerSummaryView {
  readonly basisId: string | null;
  readonly strategyWeight: number;
  readonly explainsPackageExactly: boolean;
  readonly residualRowCount: number;
  readonly residualGrossQuantity: number;
  readonly residualNetQuantity: number;
}

interface DecisionTraceDiffView {
  readonly routeMatch: boolean | null;
  readonly exactDqMatch: boolean | null;
  readonly basisMatch: boolean | null;
  readonly residualMatch: boolean | null;
  readonly packageResidualRowDiff: number | null;
}

interface CliOptions {
  readonly limit: number;
  readonly instanceId: string | null;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 20;
  let instanceId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--instance") {
      const next = argv[index + 1];
      if (next) {
        instanceId = next;
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
    instanceId,
  };
}

const options = parseCliOptions(process.argv.slice(2));
const db = getDb();
const bind = options.instanceId ? [options.instanceId, options.limit] : [options.limit];

function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toPackageLedgerSummary(value: unknown): PackageLedgerSummaryView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const residualSummary = row.residualSummary && typeof row.residualSummary === "object"
    ? row.residualSummary as Record<string, unknown>
    : null;
  return {
    basisId: typeof row.basisId === "string" ? row.basisId : null,
    strategyWeight: typeof row.strategyWeight === "number" ? row.strategyWeight : 0,
    explainsPackageExactly: row.explainsPackageExactly === true,
    residualRowCount: typeof residualSummary?.rowCount === "number" ? residualSummary.rowCount : 0,
    residualGrossQuantity: typeof residualSummary?.grossQuantity === "number" ? residualSummary.grossQuantity : 0,
    residualNetQuantity: typeof residualSummary?.netQuantity === "number" ? residualSummary.netQuantity : 0,
  };
}

function toDecisionTraceDiff(value: unknown): DecisionTraceDiffView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    routeMatch: typeof row.routeMatch === "boolean" ? row.routeMatch : null,
    exactDqMatch: typeof row.exactDqMatch === "boolean" ? row.exactDqMatch : null,
    basisMatch: typeof row.basisMatch === "boolean" ? row.basisMatch : null,
    residualMatch: typeof row.residualMatch === "boolean" ? row.residualMatch : null,
    packageResidualRowDiff: typeof row.packageResidualRowDiff === "number" ? row.packageResidualRowDiff : null,
  };
}

const recentOpportunities = options.instanceId
  ? db.prepare(`
      SELECT
        id,
        instance_id,
        mode,
        funding_rate,
        basis_bps,
        candidate_btc_size,
        candidate_swap_contracts,
        net_carry_edge_usd,
        should_enter,
        reason,
        created_at
      FROM funding_arb_opportunities
      WHERE instance_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(...bind)
  : db.prepare(`
      SELECT
        id,
        instance_id,
        mode,
        funding_rate,
        basis_bps,
        candidate_btc_size,
        candidate_swap_contracts,
        net_carry_edge_usd,
        should_enter,
        reason,
        created_at
      FROM funding_arb_opportunities
      ORDER BY id DESC
      LIMIT ?
    `).all(...bind);

const recentEvents = options.instanceId
  ? db.prepare(`
      SELECT
        id,
        instance_id,
        phase,
        spot_inst_id,
        perp_inst_id,
        package_btc_size,
        swap_contracts,
        raw_json,
        created_at
      FROM funding_arb_events
      WHERE instance_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(...bind)
  : db.prepare(`
      SELECT
        id,
        instance_id,
        phase,
        spot_inst_id,
        perp_inst_id,
        package_btc_size,
        swap_contracts,
        raw_json,
        created_at
      FROM funding_arb_events
      ORDER BY id DESC
      LIMIT ?
    `).all(...bind);

const recentPortfolioSnapshots = db.prepare(`
  SELECT
    id,
    inst_id,
    position_contracts,
    btc_delta,
    funding_exposure,
    regime,
    raw_json,
    created_at
  FROM portfolio_snapshots
  WHERE source = 'local_funding_arbitrage'
  ORDER BY id DESC
  LIMIT ?
`).all(options.limit);

const aggregates = options.instanceId
  ? db.prepare(`
      SELECT
        COUNT(*) AS total_rows,
        SUM(CASE WHEN should_enter = 1 THEN 1 ELSE 0 END) AS enter_rows,
        AVG(net_carry_edge_usd) AS avg_net_carry_edge_usd,
        MAX(net_carry_edge_usd) AS max_net_carry_edge_usd,
        MIN(net_carry_edge_usd) AS min_net_carry_edge_usd
      FROM funding_arb_opportunities
      WHERE instance_id = ?
    `).get(options.instanceId)
  : db.prepare(`
      SELECT
        COUNT(*) AS total_rows,
        SUM(CASE WHEN should_enter = 1 THEN 1 ELSE 0 END) AS enter_rows,
        AVG(net_carry_edge_usd) AS avg_net_carry_edge_usd,
        MAX(net_carry_edge_usd) AS max_net_carry_edge_usd,
        MIN(net_carry_edge_usd) AS min_net_carry_edge_usd
      FROM funding_arb_opportunities
    `).get();

const recentEventPackageLedgers = (recentEvents as Array<Record<string, unknown>>)
  .map((row) => {
    const parsed = safeParseJson(row.raw_json);
    const packageLedger = toPackageLedgerSummary(
      parsed?.entryTradePackageLedger ?? parsed?.unwindTradePackageLedger
    );
    if (!packageLedger) return null;
    return {
      id: row.id,
      instanceId: row.instance_id,
      phase: row.phase,
      createdAt: row.created_at,
      packageLedger,
    };
  })
  .filter((row): row is NonNullable<typeof row> => row !== null);

const recentSnapshotConsistency = (recentPortfolioSnapshots as Array<Record<string, unknown>>)
  .map((row) => {
    const parsed = safeParseJson(row.raw_json);
    const decisionTrace = isRuntimeDecisionTrace(parsed?.decisionTrace) ? parsed.decisionTrace : null;
    const activePackageLedger = toPackageLedgerSummary(parsed?.activePackageLedger);
    const diff = toDecisionTraceDiff(decisionTrace?.diff);
    const portfolioState = parsed?.portfolioState && typeof parsed.portfolioState === "object"
      ? parsed.portfolioState as Record<string, unknown>
      : null;
    const metadata = portfolioState?.metadata && typeof portfolioState.metadata === "object"
      ? portfolioState.metadata as Record<string, unknown>
      : null;
    return {
      id: row.id,
      instId: row.inst_id,
      regime: row.regime,
      createdAt: row.created_at,
      netDeltaBtc: typeof metadata?.netDeltaBtc === "number" ? metadata.netDeltaBtc : null,
      diff,
      activePackageLedger,
    };
  });

const traceReport = summarizeRuntimeDecisionTraces(
  (recentPortfolioSnapshots as Array<Record<string, unknown>>)
    .map((row) => {
      const parsed = safeParseJson(row.raw_json);
      const trace = parsed?.decisionTrace;
      if (!isRuntimeDecisionTrace(trace)) return null;
      return {
        trace,
        createdAt: typeof row.created_at === "number" ? row.created_at : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null),
);

const snapshotConsistencySummary = {
  totalSnapshots: recentSnapshotConsistency.length,
  activePackageSnapshots: recentSnapshotConsistency.filter((row) => row.activePackageLedger !== null).length,
  residualSnapshots: recentSnapshotConsistency.filter((row) => (row.activePackageLedger?.residualRowCount ?? 0) > 0).length,
  nonExactSnapshots: recentSnapshotConsistency.filter((row) => row.activePackageLedger?.explainsPackageExactly === false).length,
  routeMismatchSnapshots: recentSnapshotConsistency.filter((row) => row.diff?.routeMatch === false).length,
  basisMismatchSnapshots: recentSnapshotConsistency.filter((row) => row.diff?.basisMatch === false).length,
};

console.log(JSON.stringify({
  limit: options.limit,
  instanceId: options.instanceId,
  aggregates,
  recentOpportunities,
  recentEvents,
  recentEventPackageLedgers,
  recentPortfolioSnapshots,
  recentSnapshotConsistency,
  snapshotConsistencySummary,
  traceSummary: traceReport.summary,
  recentTraceAlerts: traceReport.alerts.slice(0, 20),
  recentTraceRows: traceReport.rows.slice(0, 10),
}, null, 2));
