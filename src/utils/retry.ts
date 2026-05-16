/**
 * Retry utilities with error classification
 */

export enum RetryableErrorType {
  NETWORK = "NETWORK",
  SERVER = "SERVER",
  RATE_LIMIT = "RATE_LIMIT",
  UNKNOWN = "UNKNOWN",
}

export enum UnretryableErrorType {
  AUTH = "AUTH",
  VALIDATION = "VALIDATION",
  NOT_FOUND = "NOT_FOUND",
}

export type ErrorType = RetryableErrorType | UnretryableErrorType;

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: Error, type: ErrorType) => void;
}

function classifyError(status: number, message: string): ErrorType {
  if (status === 401 || status === 403) return UnretryableErrorType.AUTH;
  if (status === 400 || status === 422) return UnretryableErrorType.VALIDATION;
  if (status === 404) return UnretryableErrorType.NOT_FOUND;
  if (status === 429) return RetryableErrorType.RATE_LIMIT;
  if (status >= 500) return RetryableErrorType.SERVER;
  if (status === 0 || message.includes("fetch") || message.includes("ECONNREFUSED")) {
    return RetryableErrorType.NETWORK;
  }
  return RetryableErrorType.UNKNOWN;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithInstantRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 5000,
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      let status = 0;
      const statusMatch = lastError.message.match(/status.?(\d+)/i);
      if (statusMatch) status = parseInt(statusMatch[1]);
      else if ((lastError as any).status) status = (lastError as any).status;

      const errorType = classifyError(status, lastError.message);

      // Unretryable — fail immediately
      if (
        errorType === UnretryableErrorType.AUTH ||
        errorType === UnretryableErrorType.VALIDATION ||
        errorType === UnretryableErrorType.NOT_FOUND
      ) {
        throw lastError;
      }

      if (attempt === maxAttempts) break;

      // Exponential backoff
      const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      onRetry?.(attempt, lastError, errorType);
      await sleep(delay);
    }
  }

  throw lastError!;
}