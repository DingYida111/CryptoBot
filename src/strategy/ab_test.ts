/**
 * Phase 2 Strategy A/B Test Framework
 *
 * Strategies are registered by name and assigned to a variant group.
 * The active variant is selected via the STRATEGY_VARIANT env var (default: "control").
 *
 * Usage:
 *   STRATEGY_VARIANT=aggressive tsx src/monitor/run.ts
 *
 * Adding a new strategy:
 *   1. Implement StrategyFn with signature: (context: StrategyContext) => StrategySignal
 *   2. Register it with registerStrategy()
 *   3. Add it to a variant in VARIANTS
 */

import type { StrategySignal, MarketRegime } from "../types.js";
import type { OkxCandle } from "../monitor/okx_klines.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Candle with Binance-compatible field names (returned by okxToBinanceCandle) */
export interface BinanceCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface StrategyContext {
  coin: string;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  btcPrice: number | null;
  candles: BinanceCandle[];
  regime: MarketRegime;
  windowMinutes: number;
  signalThreshold: number;
}

export type StrategyFn = (ctx: StrategyContext) => StrategySignal;

export interface StrategyConfig {
  name: string;
  description: string;
  fn: StrategyFn;
  params: Record<string, number | string | boolean>;
}

export interface VariantConfig {
  name: string;
  description: string;
  strategies: string[];  // strategy names to use (in priority order)
  allocationPct: number; // % of traffic (for future multi-variant routing)
}

// ── Strategy Registry ────────────────────────────────────────────────────────

const _registry = new Map<string, StrategyConfig>();

export function registerStrategy(config: StrategyConfig): void {
  _registry.set(config.name, config);
}

export function getStrategy(name: string): StrategyConfig | undefined {
  return _registry.get(name);
}

// ── Built-in Strategies ──────────────────────────────────────────────────────

/** Control: simple threshold on upBid */
registerStrategy({
  name: "threshold_simple",
  description: "Bet UP if upBid > threshold, DOWN if (1-downBid) > threshold",
  params: { threshold: 0.55 },
  fn: (ctx) => {
    const threshold = 0.55;
    const upPriceRatio = ctx.upBid !== null ? Math.abs(ctx.upBid - 0.5) / 0.5 : 0;
    if (ctx.upBid !== null && ctx.upBid > threshold) {
      return {
        coin: ctx.coin as any,
        direction: "up",
        confidence: ctx.upBid,
        edge: ctx.upBid - 0.5,
        upPriceRatio,
        reason: `upBid=${ctx.upBid.toFixed(3)} > ${threshold}`,
        regime: ctx.regime,
        stage: "MID",
      };
    }
    if (ctx.downBid !== null && (1 - ctx.downBid) > threshold) {
      return {
        coin: ctx.coin as any,
        direction: "down",
        confidence: 1 - ctx.downBid,
        edge: (1 - ctx.downBid) - 0.5,
        upPriceRatio,
        reason: `downBid=${ctx.downBid.toFixed(3)} < ${1 - threshold}`,
        regime: ctx.regime,
        stage: "MID",
      };
    }
    return { coin: ctx.coin as any, direction: "none", confidence: 0, edge: 0, upPriceRatio, reason: "no signal", regime: ctx.regime, stage: "MID" };
  },
});

/** Variant A: regime-filtered threshold (only trade in TREND regimes) */
registerStrategy({
  name: "threshold_regime_filtered",
  description: "Like threshold_simple but only fires in TREND_UP or TREND_DOWN",
  params: { threshold: 0.54, allowedRegimes: "TREND_UP,TREND_DOWN" },
  fn: (ctx) => {
    const threshold = 0.54;
    const allowed: MarketRegime[] = ["TREND_UP", "TREND_DOWN"];
    if (!allowed.includes(ctx.regime)) {
      return { coin: ctx.coin as any, direction: "none", confidence: 0, edge: 0, upPriceRatio: 0, reason: `regime=${ctx.regime} filtered`, regime: ctx.regime, stage: "MID" };
    }
    const base = getStrategy("threshold_simple")!;
    return base.fn({ ...ctx });
  },
});

/** Variant B: momentum-aligned — only bet UP if BTC is trending up recently */
registerStrategy({
  name: "momentum_aligned",
  description: "Polymarket signal filtered by short-term BTC momentum",
  params: { threshold: 0.53, lookbackCandles: 5 },
  fn: (ctx) => {
    const threshold = 0.53;
    if (ctx.candles.length < 5) {
      return { coin: ctx.coin as any, direction: "none", confidence: 0, edge: 0, upPriceRatio: 0, reason: "insufficient candles", regime: ctx.regime, stage: "MID" };
    }
    const recent = ctx.candles.slice(-5);
    const momentum = (recent[recent.length - 1].close - recent[0].open) / recent[0].open;
    const upPriceRatio = ctx.upBid !== null ? Math.abs(ctx.upBid - 0.5) / 0.5 : 0;

    if (ctx.upBid !== null && ctx.upBid > threshold && momentum > 0) {
      return {
        coin: ctx.coin as any, direction: "up", confidence: ctx.upBid,
        edge: ctx.upBid - 0.5, upPriceRatio,
        reason: `upBid=${ctx.upBid.toFixed(3)} + momentum=${(momentum * 100).toFixed(2)}%`,
        regime: ctx.regime, stage: "MID",
      };
    }
    if (ctx.downBid !== null && (1 - ctx.downBid) > threshold && momentum < 0) {
      return {
        coin: ctx.coin as any, direction: "down", confidence: 1 - ctx.downBid,
        edge: (1 - ctx.downBid) - 0.5, upPriceRatio,
        reason: `downBid=${ctx.downBid.toFixed(3)} + momentum=${(momentum * 100).toFixed(2)}%`,
        regime: ctx.regime, stage: "MID",
      };
    }
    return { coin: ctx.coin as any, direction: "none", confidence: 0, edge: 0, upPriceRatio, reason: "no aligned signal", regime: ctx.regime, stage: "MID" };
  },
});

// ── Variant Definitions ──────────────────────────────────────────────────────

export const VARIANTS: Record<string, VariantConfig> = {
  /** Baseline: no regime filter, simple threshold */
  control: {
    name: "control",
    description: "Simple threshold, no regime filter",
    strategies: ["threshold_simple"],
    allocationPct: 50,
  },
  /** A: regime-aware (avoids chop) */
  regime_filtered: {
    name: "regime_filtered",
    description: "Only bet in trending regimes",
    strategies: ["threshold_regime_filtered"],
    allocationPct: 25,
  },
  /** B: momentum-aligned (candle confirmation) */
  momentum: {
    name: "momentum",
    description: "Polymarket signal confirmed by BTC momentum",
    strategies: ["momentum_aligned"],
    allocationPct: 25,
  },
};

/** Get active variant from env, defaulting to "control" */
export function getActiveVariant(): VariantConfig {
  const variantName = process.env.STRATEGY_VARIANT ?? "control";
  return VARIANTS[variantName] ?? VARIANTS.control;
}

/**
 * Run the active variant's strategy and return a signal.
 * Falls back to the next strategy in the list if the first returns "none".
 */
export function evaluateStrategy(ctx: StrategyContext): StrategySignal & { variantName: string; strategyName: string } {
  const variant = getActiveVariant();
  for (const stratName of variant.strategies) {
    const strat = getStrategy(stratName);
    if (!strat) continue;
    const signal = strat.fn(ctx);
    if (signal.direction !== "none") {
      return { ...signal, variantName: variant.name, strategyName: stratName };
    }
  }
  // No strategy fired
  return {
    coin: ctx.coin as any,
    direction: "none",
    confidence: 0,
    edge: 0,
    upPriceRatio: 0,
    reason: "no strategy fired",
    regime: ctx.regime,
    stage: "MID",
    variantName: variant.name,
    strategyName: "none",
  };
}
