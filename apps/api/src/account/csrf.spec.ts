import { describe, expect, it } from 'vitest';
import { accountSentinelAddress, isAccountSentinel } from './crypto.js';

describe('account scoping', () => {
  it('account A and B get distinct sentinel custody keys', () => {
    const a = accountSentinelAddress('acctA');
    const b = accountSentinelAddress('acctB');
    expect(a).not.toBe(b);
    expect(isAccountSentinel(a)).toBe(true);
    expect(isAccountSentinel(b)).toBe(true);
  });
});
