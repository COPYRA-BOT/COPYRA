import { describe, expect, it } from 'vitest';
import { accountSentinelAddress, isAccountSentinel, sha256Hex } from './crypto.js';
import { REFERRAL_EARNINGS_ENABLED, REFERRAL_STOP_REASON } from './referrals.js';

describe('account isolation helpers', () => {
  it('sentinel addresses never look like wallets', () => {
    const a = accountSentinelAddress('userA');
    const b = accountSentinelAddress('userB');
    expect(a).not.toEqual(b);
    expect(isAccountSentinel(a)).toBe(true);
    expect(isAccountSentinel('ExQWcDyLAcHnt6AZmdPh8MKK2dQguuNqWkwryB2oTgzv')).toBe(false);
  });

  it('hashes differ across accounts for the same secret input namespace', () => {
    expect(sha256Hex('userA:secret')).not.toEqual(sha256Hex('userB:secret'));
  });
});

describe('referral fee stop', () => {
  it('does not invent platform-fee earnings', () => {
    expect(REFERRAL_EARNINGS_ENABLED).toBe(false);
    expect(REFERRAL_STOP_REASON).toBe('PLATFORM_FEES_NOT_COLLECTED');
  });
});
