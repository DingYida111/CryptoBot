import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import { getOkxCredentialSet } from "./utils/secrets.js";

dotenvConfig();

const TradingModeSchema = z.enum(["paper", "live"]);
const RegimeModeSchema = z.enum(["adaptive", "trend_only", "chop_only"]);

const BaseEnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  WINDOW_DURATION_MINUTES: z.coerce.number().int().min(1).default(15),
  SIGNAL_INTERVAL_MS: z.coerce.number().int().min(1000).default(10000),
  DATA_COLLECT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  TARGET_MARKETS: z.string().default("btc"),
  LOG_DIR: z.string().default("logs"),
  LOG_FILE_PREFIX: z.string().default("collector"),
  POLYMARKET_FEE_RATE: z.coerce.number().min(0).max(1).default(0.02),
  SIGNAL_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.55),
  ENABLE_TRADING: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),
  OKX_TRADING_MODE: TradingModeSchema.default("paper"),
  ALLOW_LIVE_TRADING: z.string().optional(),
  OKX_ALLOWED_IPS: z.string().optional(),
  MAX_POSITION_SIZE: z.coerce.number().int().positive().default(1),
  CLOSE_BEFORE_MINS: z.coerce.number().positive().default(0.5),
  MAX_HOLDING_MS: z.coerce.number().int().positive().default(25 * 60 * 1000),
  FLOATING_PROFIT_THRESHOLD_PCT: z.coerce.number().nonnegative().default(0.5),
  CHOP_GRID_LAYERS: z.coerce.number().int().positive().default(7),
  CHOP_GRID_SPACING_PCT: z.coerce.number().positive().default(0.006),
  CHOP_GRID_ORDER_SIZE: z.coerce.number().int().positive().default(1),
  CHOP_GRID_SEED_MULTIPLIER: z.coerce.number().int().positive().default(7),
  CHOP_GRID_MAX_INVENTORY: z.coerce.number().int().positive().default(14),
  CHOP_GRID_RECENTER_PCT: z.coerce.number().positive().default(0.014),
  CHOP_GRID_BREAKOUT_PCT: z.coerce.number().positive().default(0.04),
  CHOP_GRID_COOLDOWN_MS: z.coerce.number().int().positive().default(60_000),
  REGIME_MODE: RegimeModeSchema.default("adaptive"),
  MIN_REGIME_SCORE: z.coerce.number().min(0).max(1).default(0.6),
  TREND_WIDTH_MIN_PCT: z.coerce.number().min(0).default(0.04),
  CHOP_WIDTH_MAX_PCT: z.coerce.number().min(0).default(0.035),
  OKX_API_KEY: z.string().optional(),
  OKX_API_SECRET: z.string().optional(),
  OKX_API_PASSPHRASE: z.string().optional(),
});

const parsed = BaseEnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;
const paperCreds = getOkxCredentialSet(false);
const liveCreds = getOkxCredentialSet(true);

function ensureTradingSecrets(): void {
  if (!env.ENABLE_TRADING) {
    return;
  }

  const activeCreds = env.OKX_TRADING_MODE === "live" ? liveCreds : paperCreds;
  const missing = [
    !activeCreds.apiKey ? "OKX_API_KEY" : null,
    !activeCreds.apiSecret ? "OKX_API_SECRET" : null,
    !activeCreds.apiPassphrase ? "OKX_API_PASSPHRASE" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(
      `Trading is enabled but required OKX credentials are missing: ${missing.join(", ")}`
    );
    process.exit(1);
  }

  if (env.OKX_TRADING_MODE === "live") {
    if (env.ALLOW_LIVE_TRADING !== "I_UNDERSTAND_THE_RISK") {
      console.error(
        "Live trading requires ALLOW_LIVE_TRADING=I_UNDERSTAND_THE_RISK"
      );
      process.exit(1);
    }

    if (!env.OKX_ALLOWED_IPS || env.OKX_ALLOWED_IPS.trim().length === 0) {
      console.error(
        "Live trading requires OKX_ALLOWED_IPS to be set for operational auditing and IP allowlist checks."
      );
      process.exit(1);
    }
  }
}

export function getStartupRiskSummary(): string[] {
  const lines = [
    `mode=${env.OKX_TRADING_MODE}`,
    `tradingEnabled=${env.ENABLE_TRADING}`,
    `window=${env.WINDOW_DURATION_MINUTES}m`,
    `signalIntervalMs=${env.SIGNAL_INTERVAL_MS}`,
    `maxPositionSize=${env.MAX_POSITION_SIZE}`,
    `closeBeforeMins=${env.CLOSE_BEFORE_MINS}`,
    `maxHoldingMs=${env.MAX_HOLDING_MS}`,
    `chopGridLayers=${env.CHOP_GRID_LAYERS}`,
    `chopGridSpacingPct=${env.CHOP_GRID_SPACING_PCT}`,
    `chopGridOrderSize=${env.CHOP_GRID_ORDER_SIZE}`,
    `chopGridSeedMultiplier=${env.CHOP_GRID_SEED_MULTIPLIER}`,
    `chopGridMaxInventory=${env.CHOP_GRID_MAX_INVENTORY}`,
    `regimeMode=${env.REGIME_MODE}`,
    `minRegimeScore=${env.MIN_REGIME_SCORE}`,
  ];

  if (env.OKX_TRADING_MODE === "live") {
    lines.push(`liveAck=${env.ALLOW_LIVE_TRADING === "I_UNDERSTAND_THE_RISK"}`);
    lines.push(`ipAllowlistConfigured=${Boolean(env.OKX_ALLOWED_IPS?.trim())}`);
  }

  return lines;
}

export function requireTradingEnv() {
  ensureTradingSecrets();
  const activeCreds = env.OKX_TRADING_MODE === "live" ? liveCreds : paperCreds;
  return {
    apiKey: activeCreds.apiKey!,
    apiSecret: activeCreds.apiSecret!,
    apiPassphrase: activeCreds.apiPassphrase!,
    tradingMode: env.OKX_TRADING_MODE,
    allowLiveTrading: env.ALLOW_LIVE_TRADING,
    allowedIps: env.OKX_ALLOWED_IPS,
  };
}

export const APP_CONFIG = {
  nodeEnv: env.NODE_ENV,
  windowDurationMinutes: env.WINDOW_DURATION_MINUTES,
  signalIntervalMs: env.SIGNAL_INTERVAL_MS,
  dataCollectIntervalMs: env.DATA_COLLECT_INTERVAL_MS,
  targetMarkets: env.TARGET_MARKETS.split(",").map((s) => s.trim().toLowerCase()),
  logDir: env.LOG_DIR,
  logFilePrefix: env.LOG_FILE_PREFIX,
  polymarketFeeRate: env.POLYMARKET_FEE_RATE,
  signalThreshold: env.SIGNAL_THRESHOLD,
  enableTrading: env.ENABLE_TRADING,
  okxTradingMode: env.OKX_TRADING_MODE,
  maxPositionSize: env.MAX_POSITION_SIZE,
  closeBeforeMins: env.CLOSE_BEFORE_MINS,
  maxHoldingMs: env.MAX_HOLDING_MS,
  floatingProfitThresholdPct: env.FLOATING_PROFIT_THRESHOLD_PCT,
  chopGridLayers: env.CHOP_GRID_LAYERS,
  chopGridSpacingPct: env.CHOP_GRID_SPACING_PCT,
  chopGridOrderSize: env.CHOP_GRID_ORDER_SIZE,
  chopGridSeedMultiplier: env.CHOP_GRID_SEED_MULTIPLIER,
  chopGridMaxInventory: env.CHOP_GRID_MAX_INVENTORY,
  chopGridRecenterPct: env.CHOP_GRID_RECENTER_PCT,
  chopGridBreakoutPct: env.CHOP_GRID_BREAKOUT_PCT,
  chopGridCooldownMs: env.CHOP_GRID_COOLDOWN_MS,
  regimeMode: env.REGIME_MODE,
  minRegimeScore: env.MIN_REGIME_SCORE,
  trendWidthMinPct: env.TREND_WIDTH_MIN_PCT,
  chopWidthMaxPct: env.CHOP_WIDTH_MAX_PCT,
} as const;
