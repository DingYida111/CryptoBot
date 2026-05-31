import crypto from "crypto";
import { lookup } from "dns/promises";
import { getOkxCredentialSet } from "../utils/secrets.js";

const OKX_API = "https://www.okx.com";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly status?: number;
  readonly code?: string;
  readonly addresses?: readonly string[];
  readonly error?: string;
}

function timeoutMs(): number {
  const parsed = Number(process.env.OKX_CONNECTIVITY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8_000;
}

function useLiveApi(): boolean {
  return process.env.OKX_CONNECTIVITY_USE_LIVE === "true";
}

function nowMs(): number {
  return Date.now();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

async function timedJsonFetch(input: {
  readonly path: string;
  readonly method?: "GET";
  readonly headers?: Record<string, string>;
}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`${OKX_API}${input.path}`, {
    method: input.method ?? "GET",
    headers: input.headers,
    signal: AbortSignal.timeout(timeoutMs()),
  });
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = await response.json();
    json = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    json,
  };
}

async function checkDns(): Promise<CheckResult> {
  const started = nowMs();
  try {
    const rows = await lookup("www.okx.com", { all: true });
    return {
      name: "dns:www.okx.com",
      ok: rows.length > 0,
      elapsedMs: nowMs() - started,
      addresses: rows.map((row) => row.address),
    };
  } catch (error) {
    return {
      name: "dns:www.okx.com",
      ok: false,
      elapsedMs: nowMs() - started,
      error: errorMessage(error),
    };
  }
}

async function checkPublic(path: string, name: string): Promise<CheckResult> {
  const started = nowMs();
  try {
    const response = await timedJsonFetch({ path });
    return {
      name,
      ok: response.status >= 200 && response.status < 300 && response.json?.code === "0",
      elapsedMs: nowMs() - started,
      status: response.status,
      code: typeof response.json?.code === "string" ? response.json.code : undefined,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      elapsedMs: nowMs() - started,
      error: errorMessage(error),
    };
  }
}

function sign(timestamp: string, method: string, path: string, body: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(timestamp + method + path + body)
    .digest("base64");
}

async function checkPrivateBalance(): Promise<CheckResult> {
  const started = nowMs();
  const live = useLiveApi();
  const creds = getOkxCredentialSet(live);
  if (!creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      name: "private:account_balance",
      ok: false,
      elapsedMs: nowMs() - started,
      error: `OKX ${live ? "live" : "paper"} credentials are not configured.`,
    };
  }

  const path = "/api/v5/account/balance";
  const timestamp = new Date().toISOString();
  try {
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": creds.apiKey,
      "OK-ACCESS-SIGN": sign(timestamp, "GET", path, "", creds.apiSecret),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": creds.apiPassphrase,
      "Content-Type": "application/json",
    };
    if (!live) {
      headers["x-simulated-trading"] = "1";
    }

    const response = await timedJsonFetch({
      path,
      headers,
    });
    return {
      name: "private:account_balance",
      ok: response.status >= 200 && response.status < 300 && response.json?.code === "0",
      elapsedMs: nowMs() - started,
      status: response.status,
      code: typeof response.json?.code === "string" ? response.json.code : undefined,
    };
  } catch (error) {
    return {
      name: "private:account_balance",
      ok: false,
      elapsedMs: nowMs() - started,
      error: errorMessage(error),
    };
  }
}

async function main(): Promise<void> {
  const results = await Promise.all([
    checkDns(),
    checkPublic("/api/v5/public/time", "public:time"),
    checkPublic("/api/v5/public/funding-rate?instId=BTC-USDT-SWAP", "public:funding_rate"),
    checkPrivateBalance(),
  ]);

  console.log(JSON.stringify({
    ok: results.every((row) => row.ok),
    timeoutMs: timeoutMs(),
    useLiveApi: useLiveApi(),
    tradingAction: false,
    results,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
