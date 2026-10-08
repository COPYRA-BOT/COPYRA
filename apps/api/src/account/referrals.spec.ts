import { describe, expect, it } from 'vitest';
import { REFERRAL_EARNINGS_ENABLED, REFERRAL_STOP_REASON, claimReferralToTrading } from './referrals.js';

describe('referral claim stop', () => {
  it('never invents payouts when platform fees are not collected', async () => {
    expect(REFERRAL_EARNINGS_ENABLED).toBe(false);
    const result = await claimReferralToTrading('user-a', 'evm');
    expect(result.claimed).toBe(false);
    expect(result.amount).toBe(0);
    expect(result.reason).toBe(REFERRAL_STOP_REASON);
  });
});
