/**
 * Shared type definitions for CryptoBot
 */

// Polymarket market types
export type Coin = "btc" | "eth" | "sol" | "xrp";
export type Minutes = 5 | 15 | 60 | 240 | 1440;

// Time bucket interface (mirrors slug.ts logic)
export interface TimeBucket {
  slug: string;
  endTimestamp: number;
}

// Raw price tick from both sources
export interface Tick {
  timestamp: number;          // Unix ms
  coin: Coin;
  slug: string;               // Polymarket market slug
  upBid: number | null;       // UP token bid
  upAsk: number | null;       // UP token ask
  downBid: number | null;     // DOWN token bid
  downAsk: number | null;     // DOWN token ask
  btcPrice: number | null;    // OKX BTC perpetuals price (USD)
  marketEndTimestamp: number;  // Window end time (Unix s)
  fetchedAt: number;          // When we fetched this (Unix ms)
}

// Aggregated window data (written at window close)
export interface WindowSummary {
  id: number;
  coin: Coin;
  slug: string;
  windowStartTimestamp: number;
  windowEndTimestamp: number;
  // Entry signals (when signal first triggered)
  signalUpPrice: number | null;
  signalDownPrice: number | null;
  signalUpTime: number | null;
  signalDownTime: number | null;
  // Outcome
  btcEntryPrice: number | null;   // OKX BTC price at entry
  btcExitPrice: number | null;    // OKX BTC price at window end
  btcReturn: number | null;       // % return over the window
  // Result
  upWon: boolean | null;          // Did UP token win?
  profitIfUp: number | null;       // Gross profit if bet on UP (1 share)
  profitIfDown: number | null;    // Gross profit if bet on DOWN (1 share)
  // Friction-adjusted P&L (net after spread + fee)
  netProfitIfUp: number | null;   // profitIfUp  - spreadCost - feeCost
  netProfitIfDown: number | null; // profitIfDown - spreadCost - feeCost
  spreadCost: number | null;      // upAsk - upBid at signal time (entry slippage)
  feeCost: number | null;         // Polymarket taker fee ≈ 2% of notional (configurable)
  createdAt: number;
}

// Configuration schema
export interface CollectorConfig {
  intervalMs: number;
  markets: Coin[];
  windowDurationMinutes: number;
  logDir: string;
  logFilePrefix: string;
}

// Strategy result (for Phase 2+)
export interface StrategySignal {
  coin: Coin;
  direction: "up" | "down" | "none";
  confidence: number;         // 0-1
  edge: number;              // model_prob - market_prob
  upPriceRatio: number;     // |upBid - 0.5| / 0.5
  reason: string;
  regime: MarketRegime;
  stage: TradeStage;
}

export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "CHOP";
export type TradeStage = "EARLY" | "MID" | "LATE";