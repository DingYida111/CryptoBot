import { getDb } from "../monitor/storage.js";
import { summarizeRuntimeActions, type RuntimeActionReportRow } from "./runtime_actions.js";

interface CliOptions {
  readonly limit: number;
  readonly source: string | null;
  readonly status: string | null;
  readonly actionType: string | null;
  readonly instrumentId: string | null;
  readonly cooldownMs: number;
}

interface RuntimeActionDbRow {
  readonly id: number;
  readonly surface: string;
  readonly surface_row_id: number;
  readonly message_code: string;
  readonly category: string;
  readonly scope: string;
  readonly source: string;
  readonly trace_version: string | null;
  readonly action_type: string;
  readonly status: string;
  readonly execution_enabled: number;
  readonly affected_instrument_ids_json: string;
  readonly reason: string;
  readonly created_at: number;
  readonly proposed_at: number;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  let limit = 200;
  let source: string | null = null;
  let status: string | null = null;
  let actionType: string | null = null;
  let instrumentId: string | null = null;
  let cooldownMs = 300_000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--source") {
      const next = argv[index + 1];
      if (next) {
        source = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--status") {
      const next = argv[index + 1];
      if (next) {
        status = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--action-type") {
      const next = argv[index + 1];
      if (next) {
        actionType = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--instrument") {
      const next = argv[index + 1];
      if (next) {
        instrumentId = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--cooldown-ms") {
      const parsed = parsePositiveNumber(argv[index + 1]);
      if (parsed !== null) {
        cooldownMs = Math.floor(parsed);
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
    source,
    status,
    actionType,
    instrumentId,
    cooldownMs,
  };
}

function parseInstrumentIds(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === "string").sort();
  } catch {
    return [];
  }
}

function toReportRow(row: RuntimeActionDbRow): RuntimeActionReportRow {
  return {
    id: row.id,
    surface: row.surface,
    surfaceRowId: row.surface_row_id,
    messageCode: row.message_code,
    category: row.category,
    scope: row.scope,
    source: row.source,
    traceVersion: row.trace_version,
    actionType: row.action_type,
    status: row.status,
    executionEnabled: row.execution_enabled === 1,
    affectedInstrumentIds: parseInstrumentIds(row.affected_instrument_ids_json),
    reason: row.reason,
    createdAt: row.created_at,
    proposedAt: row.proposed_at,
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

const options = parseCliOptions(process.argv.slice(2));
const db = getDb();
const filters: string[] = [];
const params: Array<string | number> = [];

addFilter(filters, params, "source", options.source);
addFilter(filters, params, "status", options.status);
addFilter(filters, params, "action_type", options.actionType);
params.push(options.limit);

const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
const rows = (db.prepare(`
  SELECT
    id,
    surface,
    surface_row_id,
    message_code,
    category,
    scope,
    source,
    trace_version,
    action_type,
    status,
    execution_enabled,
    affected_instrument_ids_json,
    reason,
    created_at,
    proposed_at
  FROM runtime_actions
  ${whereClause}
  ORDER BY id DESC
  LIMIT ?
`).all(...params) as RuntimeActionDbRow[])
  .map(toReportRow)
  .filter((row) => options.instrumentId === null || row.affectedInstrumentIds.includes(options.instrumentId));

const report = summarizeRuntimeActions(rows, { cooldownMs: options.cooldownMs });

console.log(JSON.stringify({
  limit: options.limit,
  source: options.source,
  status: options.status,
  actionType: options.actionType,
  instrumentId: options.instrumentId,
  cooldownMs: options.cooldownMs,
  summary: report.summary,
  cooldown: report.cooldown,
  recentActions: rows.slice(0, 50),
}, null, 2));
