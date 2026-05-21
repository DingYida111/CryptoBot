import { getDb } from "../monitor/storage.js";

interface CliOptions {
  readonly limit: number;
  readonly status: string | null;
  readonly targetId: string | null;
}

interface RuntimeControlEffectDbRow {
  readonly id: number;
  readonly runtime_action_id: number;
  readonly effect_type: string;
  readonly scope: string;
  readonly target_id: string;
  readonly value: string;
  readonly status: string;
  readonly source: string;
  readonly action_type: string;
  readonly message_code: string;
  readonly reason: string;
  readonly created_at: number;
  readonly observed_at: number;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 100;
  let status: string | null = null;
  let targetId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--status") {
      const next = argv[index + 1];
      if (next) {
        status = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--target") {
      const next = argv[index + 1];
      if (next) {
        targetId = next;
        index += 1;
      }
      continue;
    }
    const parsed = parsePositiveNumber(arg);
    if (parsed !== null) {
      limit = Math.floor(parsed);
    }
  }

  return {
    limit,
    status,
    targetId,
  };
}

function addFilter(
  filters: string[],
  params: Array<string | number>,
  column: string,
  value: string | null,
): void {
  if (value === null) return;
  filters.push(`${column} = ?`);
  params.push(value);
}

function countBy<T extends string>(
  rows: readonly RuntimeControlEffectDbRow[],
  key: keyof RuntimeControlEffectDbRow,
  label: T,
): ReadonlyArray<{ readonly [P in T]: string } & { readonly count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(row[key]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [label]: value, count }) as { [P in T]: string } & { count: number })
    .sort((a, b) => b.count - a.count || a[label].localeCompare(b[label]));
}

const options = parseCliOptions(process.argv.slice(2));
const db = getDb();
const filters: string[] = [];
const params: Array<string | number> = [];

addFilter(filters, params, "status", options.status);
addFilter(filters, params, "target_id", options.targetId);
params.push(options.limit);

const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
const rows = db.prepare(`
  SELECT
    id,
    runtime_action_id,
    effect_type,
    scope,
    target_id,
    value,
    status,
    source,
    action_type,
    message_code,
    reason,
    created_at,
    observed_at
  FROM runtime_control_effects
  ${whereClause}
  ORDER BY id DESC
  LIMIT ?
`).all(...params) as RuntimeControlEffectDbRow[];

console.log(JSON.stringify({
  limit: options.limit,
  status: options.status,
  targetId: options.targetId,
  summary: {
    totalEffects: rows.length,
    byEffectType: countBy(rows, "effect_type", "effectType"),
    byStatus: countBy(rows, "status", "status"),
    byTarget: countBy(rows, "target_id", "targetId"),
    bySource: countBy(rows, "source", "source"),
  },
  recentEffects: rows.slice(0, 50),
}, null, 2));
