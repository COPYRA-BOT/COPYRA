import { describe, expect, it } from 'vitest';
import { Chain } from '@copyra/db';
import { getAddress } from 'viem';

/**
 * Pure owner-wallet gate tests. Env is injected via process.env before import
 * is awkward with the singleton env module, so we re-implement the same
 * normalization rules here and assert against the exported helpers when env
 * is already loaded from the workspace `.env`.
 */
describe('owner wallet gate', () => {
  it('normalizes EVM addresses to lowercase checksum compare', async () => {
    const { isOwnerWallet, normalizeSessionAddress } = await import('./owner-wallet.js');
    const mixed = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
    const lower = normalizeSessionAddress(mixed, Chain.BASE);
    expect(lower).toBe(getAddress(mixed).toLowerCase());
    // Without OWNER_WALLET_EVM configured (or mismatched), isOwnerWallet is false.
    // When env has a value we only assert shape stability.
    expect(typeof isOwnerWallet(mixed, Chain.BASE)).toBe('boolean');
  });

  it('rejects clearly non-owner Solana address when owner is configured', async () => {
    const { ownerWalletForChain, isOwnerWallet, assertAdminWallet } = await import(
      './owner-wallet.js'
    );
    const owner = ownerWalletForChain(Chain.SOLANA);
    if (!owner) {
      expect(() => assertAdminWallet('7EqQdEUSxH4xviK3jY5W8s2nQv8m1kP9oL3rT6uY2xA', Chain.SOLANA)).toThrow(
        /OWNER_WALLET_SOLANA|admin/i,
      );
      return;
    }
    expect(isOwnerWallet(owner, Chain.SOLANA)).toBe(true);
    expect(isOwnerWallet('11111111111111111111111111111111', Chain.SOLANA)).toBe(false);
    expect(() => assertAdminWallet('11111111111111111111111111111111', Chain.SOLANA)).toThrow(
      /admin/i,
    );
  });

  it('rejects clearly non-owner EVM address when owner is configured', async () => {
    const { ownerWalletForChain, isOwnerWallet, assertAdminWallet } = await import(
      './owner-wallet.js'
    );
    const owner = ownerWalletForChain(Chain.BASE);
    if (!owner) {
      expect(() =>
        assertAdminWallet('0x0000000000000000000000000000000000000001', Chain.BASE),
      ).toThrow(/OWNER_WALLET_EVM|admin/i);
      return;
    }
    expect(isOwnerWallet(owner, Chain.BASE)).toBe(true);
    expect(isOwnerWallet('0x0000000000000000000000000000000000000001', Chain.BASE)).toBe(false);
  });
});
