import { describe, expect, it } from 'vitest';
import { HttpError, RetryExhaustedError, TimeoutError, withRetry, withTimeout } from './retry.js';

describe('withRetry', () => {
  it('returns on the first success', async () => {
    let attempts = 0;
    const value = await withRetry(async () => {
      attempts += 1;
      return 'ok';
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(value).toBe('ok');
    expect(attempts).toBe(1);
  });

  it('retries a retryable failure and then succeeds', async () => {
    let attempts = 0;
    const value = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'recovered';
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    expect(value).toBe('recovered');
    expect(attempts).toBe(3);
  });

  it('does not retry when retryable() returns false (e.g. insufficient balance)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error('insufficient funds');
        },
        {
          attempts: 5,
          baseDelayMs: 1,
          retryable: (error) =>
            !/insufficient/i.test(error instanceof Error ? error.message : ''),
        },
      ),
    ).rejects.toThrow(/insufficient funds/);
    expect(attempts).toBe(1);
  });

  it('throws RetryExhaustedError after the last attempt', async () => {
    await expect(
      withRetry(async () => {
        throw new Error('always');
      }, { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });
});

describe('withTimeout', () => {
  it('rejects a hung operation rather than waiting forever', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 20, 'hung-call'),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('HttpError', () => {
  it('carries status so callers can distinguish 4xx from 5xx', () => {
    const error = new HttpError(429, 'jupiter/quote', 'rate limited');
    expect(error.status).toBe(429);
    expect(error.code).toBe('HTTP_ERROR');
  });
});
