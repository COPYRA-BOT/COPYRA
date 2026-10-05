export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying immediately (e.g. insufficient balance). */
  retryable?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Abort the whole operation after this long, regardless of attempts left. */
  deadlineMs?: number;
}

export class RetryExhaustedError extends Error {
  readonly code = 'RETRY_EXHAUSTED';
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(
      `Operation failed after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Exponential backoff with full jitter. Jitter matters here: without it, a
 * provider blip makes every monitor retry in lockstep and re-trigger the blip.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 150;
  const max = options.maxDelayMs ?? 4_000;
  const startedAt = Date.now();

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (options.retryable && !options.retryable(error, attempt)) {
        throw error;
      }
      if (attempt === attempts) break;
      if (options.deadlineMs && Date.now() - startedAt > options.deadlineMs) break;

      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw new RetryExhaustedError(attempts, lastError);
}

export class TimeoutError extends Error {
  readonly code = 'TIMEOUT';
  constructor(ms: number, label: string) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTP helper with a hard timeout — every outbound call must have one. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; label?: string } = {},
): Promise<{ data: T; latencyMs: number; status: number }> {
  const { timeoutMs = 8_000, label = url, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(response.status, label, text.slice(0, 500));
    }
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new HttpError(response.status, label, `non-JSON response: ${text.slice(0, 200)}`);
    }
    return { data, latencyMs, status: response.status };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(timeoutMs, label);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class HttpError extends Error {
  readonly code = 'HTTP_ERROR';
  readonly status: number;
  readonly body: string;

  constructor(status: number, label: string, body: string) {
    super(`${label} returned HTTP ${status}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}
