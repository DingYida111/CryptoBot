export interface PortfolioShadowReportRow {
  readonly actualRoute: string;
  readonly shadowRoute: string;
  readonly actualDqContracts: number;
  readonly shadowDqContracts: number;
  readonly actualBasisId: string | null;
  readonly shadowBasisId: string | null;
  readonly actualResidualContracts: number | null;
  readonly shadowResidualContracts: number | null;
  readonly shadowResidualReason: string | null;
  readonly diffPct: number | null;
  readonly createdAt: number;
}

export interface PortfolioShadowSummary {
  readonly totalRows: number;
  readonly routeMatchCount: number;
  readonly routeMatchRate: number;
  readonly exactDqMatchCount: number;
  readonly exactDqMatchRate: number;
  readonly avgDiffPct: number | null;
  readonly maxDiffPct: number | null;
  readonly mismatchCount: number;
  readonly topRouteMismatches: ReadonlyArray<{
    readonly actualRoute: string;
    readonly shadowRoute: string;
    readonly count: number;
  }>;
  readonly residualRowCount: number;
  readonly residualReasonBreakdown: ReadonlyArray<{
    readonly reason: string;
    readonly count: number;
  }>;
}

export interface PortfolioShadowMismatchDetail {
  readonly actualRoute: string;
  readonly shadowRoute: string;
  readonly actualDqContracts: number;
  readonly shadowDqContracts: number;
  readonly diffPct: number | null;
  readonly actualBasisId: string | null;
  readonly shadowBasisId: string | null;
  readonly shadowResidualReason: string | null;
  readonly createdAt: number;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function summarizeShadowRows(rows: readonly PortfolioShadowReportRow[]): PortfolioShadowSummary {
  const totalRows = rows.length;
  const routeMatchCount = rows.filter((row) => row.actualRoute === row.shadowRoute).length;
  const exactDqMatchCount = rows.filter((row) => row.actualDqContracts === row.shadowDqContracts).length;
  const diffValues = rows
    .map((row) => row.diffPct)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const avgDiffPct = diffValues.length > 0
    ? diffValues.reduce((sum, value) => sum + value, 0) / diffValues.length
    : null;
  const maxDiffPct = diffValues.length > 0
    ? diffValues.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY)
    : null;

  const mismatchGroups = new Map<string, { actualRoute: string; shadowRoute: string; count: number }>();
  for (const row of rows) {
    if (row.actualRoute === row.shadowRoute) continue;
    const key = `${row.actualRoute}=>${row.shadowRoute}`;
    const current = mismatchGroups.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    mismatchGroups.set(key, {
      actualRoute: row.actualRoute,
      shadowRoute: row.shadowRoute,
      count: 1,
    });
  }

  const residualReasonCounts = new Map<string, number>();
  let residualRowCount = 0;
  for (const row of rows) {
    const hasResidual =
      Math.abs(row.actualResidualContracts ?? 0) > 1e-12 ||
      Math.abs(row.shadowResidualContracts ?? 0) > 1e-12;
    if (!hasResidual) continue;
    residualRowCount += 1;
    const reason = row.shadowResidualReason ?? "UNKNOWN";
    residualReasonCounts.set(reason, (residualReasonCounts.get(reason) ?? 0) + 1);
  }

  return {
    totalRows,
    routeMatchCount,
    routeMatchRate: rate(routeMatchCount, totalRows),
    exactDqMatchCount,
    exactDqMatchRate: rate(exactDqMatchCount, totalRows),
    avgDiffPct,
    maxDiffPct,
    mismatchCount: totalRows - routeMatchCount,
    topRouteMismatches: [...mismatchGroups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    residualRowCount,
    residualReasonBreakdown: [...residualReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function extractShadowMismatchDetails(
  rows: readonly PortfolioShadowReportRow[],
  limit = 10
): PortfolioShadowMismatchDetail[] {
  return rows
    .filter((row) =>
      row.actualRoute !== row.shadowRoute ||
      row.actualDqContracts !== row.shadowDqContracts ||
      (row.actualBasisId ?? null) !== (row.shadowBasisId ?? null) ||
      Math.abs(row.actualResidualContracts ?? 0) !== Math.abs(row.shadowResidualContracts ?? 0)
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((row) => ({
      actualRoute: row.actualRoute,
      shadowRoute: row.shadowRoute,
      actualDqContracts: row.actualDqContracts,
      shadowDqContracts: row.shadowDqContracts,
      diffPct: row.diffPct,
      actualBasisId: row.actualBasisId,
      shadowBasisId: row.shadowBasisId,
      shadowResidualReason: row.shadowResidualReason,
      createdAt: row.createdAt,
    }));
}
