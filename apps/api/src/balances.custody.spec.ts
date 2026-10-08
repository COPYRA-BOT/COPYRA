import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@copyra/core', async () => {
  const actual = await vi.importActual<typeof import('@copyra/core')>('@copyra/core');
  return {
    ...actual,
    multiUserCustodyEnabled: vi.fn(() => true),
    userCustodyAddress: vi.fn(async (userId: string, chain: string) =>
      chain === 'SOLANA' ? 'CustSol1111111111111111111111111111111' : '0xCustEvm11111111111111111111111111111111',
    ),
    tradingWalletAddress: vi.fn(() => 'ExQWcDyLAcHnt6AZmdPh8MKK2dQguuNqWkwryB2oTgzv'),
    getTradingAvailableQuote: vi.fn(async () => ({
      onChainQuote: 1.25,
      savingsQuote: 0,
      availableQuote: 1.24,
      withdrawableQuote: 1.25,
      gasReserveQuote: 0,
      address: 'CustSol1111111111111111111111111111111',
      configured: true,
      multiUser: true,
      assetSymbol: 'SOL',
      assetDecimals: 9,
    })),
    getSolanaBalances: vi.fn(async () => ({
      lamports: 1_250_000_000n,
      tokens: [],
      slot: 1n,
    })),
  };
});

describe('buildModeBalances custody isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never returns the shared bot signer when a userId is present', async () => {
    const { buildModeBalances } = await import('./balances.js');
    const { tradingWalletAddress } = await import('@copyra/core');
    const sol = await buildModeBalances('sol', 'user_abc');
    expect(sol.custodyAddress).toBe('CustSol1111111111111111111111111111111');
    expect(sol.wallets.every((w) => w.userScoped === true)).toBe(true);
    expect(sol.wallets.every((w) => w.address !== tradingWalletAddress('SOLANA' as never))).toBe(true);
    expect(sol.wallets[0]?.native).toBe(1.25);
  });

  it('does not surface the bot wallet when the mode has no session', async () => {
    const { buildModeBalances } = await import('./balances.js');
    const sol = await buildModeBalances('sol', undefined);
    expect(sol.wallets[0]?.needsAuth).toBe(true);
    expect(sol.wallets[0]?.address).toBeNull();
    expect(sol.wallets[0]?.userScoped).toBe(true);
    expect(String(sol.wallets[0]?.address || '')).not.toMatch(/^ExQW/);
  });
});
