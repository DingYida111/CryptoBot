type TradeLogValue = string | number | boolean | null;

function sanitizeValue(value: unknown): TradeLogValue {
  if (value === null) return null;
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value) as TradeLogValue;
}

export function logTradeEvent(scope: string, event: string, fields: Record<string, unknown> = {}): void {
  const payload = Object.fromEntries(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeValue(value)])
  );
  const suffix = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  console.error(`[${new Date().toISOString()}] [${scope}] ${event}${suffix}`);
}
