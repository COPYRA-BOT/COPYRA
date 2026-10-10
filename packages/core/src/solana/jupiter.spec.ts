import { describe, expect, it } from 'vitest';
import { HttpError } from '../util/retry.js';
import { isJupiterRateLimitError } from './jupiter.js';

describe('isJupiterRateLimitError', () => {
  it('detects HttpError 429', () => {
    expect(isJupiterRateLimitError(new HttpError(429, 'jupiter/quote', 'Rate limit exceeded'))).toBe(
      true,
    );
  });

  it('detects RetryExhausted-style message text', () => {
    expect(
      isJupiterRateLimitError(
        new Error('Operation failed after 2 attempt(s): jupiter/quote returned HTTP 429: Rate limit exceeded'),
      ),
    ).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(isJupiterRateLimitError(new HttpError(500, 'jupiter/quote', 'boom'))).toBe(false);
    expect(isJupiterRateLimitError(new Error('NO_ROUTE'))).toBe(false);
  });
});
