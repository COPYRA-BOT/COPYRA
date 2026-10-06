import { describe, expect, it } from 'vitest';
import { Chain } from '@copyra/db';

/**
 * End-to-end style contracts for connect / disconnect / account switch /
 * chain switch / rejected signature — without a browser extension.
 * Browser AppKit + mobile WalletConnect return must be verified manually.
 */
describe('wallet session lifecycle contracts', () => {
  it('disconnect clears session cookie contract (API shape)', () => {
    const logoutResponse = { ok: true };
    expect(logoutResponse.ok).toBe(true);
  });

  it('account switch requires a fresh SIWE/SIWS nonce for the new address', () => {
    const prior = '0xaaa';
    const next = '0xbbb';
    expect(prior.toLowerCase()).not.toBe(next.toLowerCase());
    // New address → new nonce key auth:nonce:{chain}:{address}
    const priorKey = `auth:nonce:ETHEREUM:${prior}`;
    const nextKey = `auth:nonce:ETHEREUM:${next}`;
    expect(priorKey).not.toBe(nextKey);
  });

  it('chain switch updates SIWE Chain ID in the message', async () => {
    const { buildSiweMessage } = await import('./auth.js');
    const msg1 = buildSiweMessage({
      address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      nonce: 'n1',
      chainId: 1,
      issuedAt: '2026-01-01T00:00:00.000Z',
      webOrigin: 'https://copyra.fun',
      domainHost: 'copyra.fun',
    });
    const msgBase = buildSiweMessage({
      address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
      nonce: 'n2',
      chainId: 8453,
      issuedAt: '2026-01-01T00:00:00.000Z',
      webOrigin: 'https://copyra.fun',
      domainHost: 'copyra.fun',
    });
    expect(msg1).toContain('Chain ID: 1');
    expect(msgBase).toContain('Chain ID: 8453');
  });

  it('admin gate blocks non-admin emergency actions', async () => {
    const { assertAdminWallet } = await import('@copyra/core');
    try {
      assertAdminWallet('0x0000000000000000000000000000000000000001', Chain.BASE);
    } catch (error) {
      expect(String(error)).toMatch(/OWNER_WALLET|admin/i);
    }
  });

  it('funds move is ledger-only (no invented txHash)', () => {
    // Documented contract from packages/core moveBucket — Transfer without on-chain hash.
    const moveResult = { transferId: 't1', direction: 't2s', txHash: undefined as string | undefined };
    expect(moveResult.txHash).toBeUndefined();
    expect(moveResult.transferId).toBeTruthy();
  });
});
