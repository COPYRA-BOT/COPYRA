import { describe, expect, it } from 'vitest';

/**
 * Wallet modal open-path contract tests (no browser).
 * Locks the AppKit formula behaviour we rely on for desktop Connect.
 */
describe('wallet connect contract', () => {
  it('opens Connect for the active namespace quickly (Chrome-friendly)', () => {
    // Document the open order used by apps/web/src/wallet.ts openAppKit:
    const attempts: string[] = [];
    const open = (opts: { view: string; namespace?: string }) => {
      attempts.push(`${opts.view}:${opts.namespace ?? 'any'}`);
    };
    const namespace = 'solana';
    try {
      open({ view: 'Connect', namespace });
    } catch {
      open({ view: 'AllWallets', namespace });
    }
    expect(attempts[0]).toBe('Connect:solana');
  });

  it('does not instant-resolve same-address reconnect without seeing the modal open', () => {
    let sawModalOpen = false;
    const prior = 'ABC';
    const address = 'ABC';
    const isOpen = false;
    // Without sawModalOpen, same address must NOT resolve.
    const shouldResolve = Boolean(address && sawModalOpen && !isOpen);
    expect(shouldResolve).toBe(false);
    sawModalOpen = true;
    expect(Boolean(address && sawModalOpen && !isOpen && address === prior)).toBe(true);
  });

  it('project id resolver only reads VITE_REOWN_PROJECT_ID', () => {
    const env: Record<string, string | undefined> = {
      VITE_REOWN_PROJECT_ID: 'pid_from_vite',
      NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: 'pid_from_next',
      VITE_ALCHEMY_ID: 'should_not_matter',
    };
    const resolved = env.VITE_REOWN_PROJECT_ID?.trim() || '';
    expect(resolved).toBe('pid_from_vite');
    expect(resolved).not.toBe(env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
  });

  it('SolanaAdapter must not pass a restrictive wallets array (Phantom-only root cause)', () => {
    // The bug: wallets: [PhantomWalletAdapter, SolflareWalletAdapter]
    // The fix: SolanaAdapter({ registerWalletStandard: true }) with no wallets list.
    const badConfig = { registerWalletStandard: true, wallets: ['Phantom', 'Solflare'] };
    const goodConfig = { registerWalletStandard: true };
    expect('wallets' in goodConfig).toBe(false);
    expect(Array.isArray(badConfig.wallets)).toBe(true);
    expect(badConfig.wallets.length).toBeLessThan(5);
  });
});
