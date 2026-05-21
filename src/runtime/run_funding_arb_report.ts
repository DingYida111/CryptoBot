import { getDb } from "../monitor/storage.js";

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

console.log(JSON.stringify({
  limit: options.limit,
  instanceId: options.instanceId,
  aggregates,
  recentOpportunities,
  recentEvents,
  recentPortfolioSnapshots,
}, null, 2));
