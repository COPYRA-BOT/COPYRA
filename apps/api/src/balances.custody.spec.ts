import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@copyra/core', async () => {
  const actual = await vi.importActual<typeof import('@copyra/core')>('@copyra/core');
  const addr = (_userId: string, chain: string, opts?: { family?: string }) => {
    if (chain !== 'SOLANA') return '0xCustEvm11111111111111111111111111111111';
    if (opts?.family === 'SNIPER') return 'CustSnip11111111111111111111111111111';
    return 'CustSol1111111111111111111111111111111';
  };
  return {
    ...actual,
    multiUserCustodyEnabled: vi.fn(() => true),
    deriveUserCustodyAddress: vi.fn(addr),
    userCustodyAddress: vi.fn(async (...args: Parameters<typeof addr>) => addr(...args)),
    tradingWalletAddress: vi.fn(() => 'ExQWcDyLAcHnt6AZmdPh8MKK2dQguuNqWkwryB2oTgzv'),
    getTradingAvailableQuote: vi.fn(async (_chain: string, _userId?: string, opts?: { family?: string }) => {
      const sniper = opts?.family === 'SNIPER';
      return {
        onChainQuote: sniper ? 0 : 1.25,
        savingsQuote: 0,
        availableQuote: sniper ? 0 : 1.24,
        withdrawableQuote: sniper ? 0 : 1.25,
        gasReserveQuote: 0,
        address: sniper ? 'CustSnip11111111111111111111111111111' : 'CustSol1111111111111111111111111111111',
        configured: true,
        multiUser: true,
        assetSymbol: 'SOL',
        assetDecimals: 9,
      };
    }),
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

  it('sniper custody is independent and starts at 0 until deposit', async () => {
    const { buildModeBalances } = await import('./balances.js');
    const sniper = await buildModeBalances('sniper', 'user_abc');
    const sol = await buildModeBalances('sol', 'user_abc');
    expect(sniper.custodyAddress).toBe('CustSnip11111111111111111111111111111');
    expect(sniper.custodyAddress).not.toBe(sol.custodyAddress);
    expect(sniper.family).toBe('SNIPER');
    expect(sniper.wallets[0]?.native).toBe(0);
    expect(sniper.wallets[0]?.onChainNative).toBe(0);
    expect(sniper.wallets[0]?.family).toBe('SNIPER');
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
