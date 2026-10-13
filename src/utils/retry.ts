import { RETRY_CONFIG } from "../config/constants.ts";

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Status lets createApiRetryStrategy tell an HTTP rejection from a network fault.
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const LLM_TIMEOUT_CODE = "LLM_TIMEOUT";

export function llmTimeoutError(seconds: number): Error & { code: string } {
  return Object.assign(new Error(`Request timed out after ${seconds}s`), {
    code: LLM_TIMEOUT_CODE,
  });
}

function isTimeoutError(error: any): boolean {
  return error?.code === LLM_TIMEOUT_CODE || error?.name === "APIConnectionTimeoutError";
}

// Specific retry strategy for API calls. A long call (minutes-long timeoutSeconds)
// must not multiply its wait: it never retries a timeout, and retries other faults
// only while they fail fast (within the first quarter of the timeout).
export function createApiRetryStrategy({ timeoutSeconds }: { timeoutSeconds?: number } = {}) {
  const startedAt = Date.now();
  const retryWindowMs = timeoutSeconds ? (timeoutSeconds * 1000) / 4 : Infinity;
  return {
    shouldRetry: (error: any) => {
      const status = error?.status ?? error?.response?.status;
      if (timeoutSeconds && (isTimeoutError(error) || status === 408)) return false;
      if (Date.now() - startedAt >= retryWindowMs) return false;

      // No HTTP status means the request never got an answer (network drop, timeout).
      if (typeof status !== "number") return true;

      // Most 4xx are deterministic rejections. 408 is a request timeout and 429 is
      // a rate limit; both can clear on retry, as can 5xx server faults.
      return status === 408 || status === 429 || (status >= 500 && status < 600);
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // Retry on temporary file system errors
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      return retriableErrors.includes(error.code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}
