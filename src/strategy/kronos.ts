/**
 * Kronos model client for CryptoBot.
 * Calls the local Kronos Python microservice (port 8766) and returns
 * a direction probability to blend with TA signals.
 *
 * Fails gracefully: if the service is down or too slow, returns null
 * so the strategy falls back to TA-only scoring.
 */

import type { Candle } from "../monitor/binance.js";

const KRONOS_URL = process.env.KRONOS_URL ?? "http://localhost:8766";
const TIMEOUT_MS = 4000;  // skip if inference takes > 4s

export interface KronosResult {
  probUp: number;         // 0-1, probability that price will be UP
  predictedClose: number;
  currentClose: number;
  deltaPercent: number;
  latencyMs: number;
}

/**
 * Query the Kronos service with recent candles.
 * Returns null on any failure so callers can gracefully degrade.
 */
export async function getKronosProb(candles: Candle[]): Promise<KronosResult | null> {
  if (candles.length < 30) return null;

  const payload = {
    candles: candles.map((c) => ({
      ts: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  };

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${KRONOS_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json() as {
      ok: boolean;
      prob_up?: number;
      predicted_close?: number;
      current_close?: number;
      price_delta_pct?: number;
      error?: string;
    };

    if (!data.ok || data.prob_up === undefined) return null;

    return {
      probUp: data.prob_up,
      predictedClose: data.predicted_close ?? 0,
      currentClose: data.current_close ?? 0,
      deltaPercent: data.price_delta_pct ?? 0,
      latencyMs: Date.now() - t0,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the Kronos service is alive.
 */
export async function isKronosReady(): Promise<boolean> {
  try {
    const res = await fetch(`${KRONOS_URL}/health`, { signal: AbortSignal.timeout(1000) });
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
