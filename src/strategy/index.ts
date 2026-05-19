/**
 * Strategy module barrel export
 */
export { scoreStrategy, calcUpPriceRatio, calcTimeRatio, calcTradeStage, applyTimeAwareness, DEFAULT_SCORING_CONFIG } from "./scoring.js";
export { detectRegime } from "./regime.js";
export * from "./ta.js";
export { fetchKlines, fetchBtcPrice as fetchBinanceBtcPrice, getRecentClose } from "../monitor/binance.js";
