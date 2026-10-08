import { Chain } from '@copyra/db';
import { getAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { env } from '../config/env.js';

/**
 * Admin wallets (OWNER_WALLET_*) grant dashboard admin actions only — not a deposit gate
 * when MULTI_USER_CUSTODY is enabled. Configure as App-Level secrets.
 */
export function ownerWalletForChain(chain: Chain): string | null {
  if (chain === Chain.SOLANA) {
    const raw = env.OWNER_WALLET_SOLANA?.trim();
    if (!raw) return null;
    try {
      return new PublicKey(raw).toBase58();
    } catch {
      return null;
    }
  }
  const raw = env.OWNER_WALLET_EVM?.trim();
  if (!raw) return null;
  try {
    return getAddress(raw).toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeSessionAddress(address: string, chain: Chain): string {
  if (chain === Chain.SOLANA) return new PublicKey(address).toBase58();
  return getAddress(address).toLowerCase();
}

export function isOwnerWallet(address: string, chain: Chain): boolean {
  const owner = ownerWalletForChain(chain);
  if (!owner) return false;
  try {
    return normalizeSessionAddress(address, chain) === owner;
  } catch {
    return false;
  }
}

/** @deprecated Use assertAdminWallet for admin-only routes. Kept for tests. */
export function assertOwnerWallet(address: string, chain: Chain): void {
  assertAdminWallet(address, chain);
}

/** Throws when the session address is not a configured admin wallet for this chain. */
export function assertAdminWallet(address: string, chain: Chain): void {
  const owner = ownerWalletForChain(chain);
  if (!owner) {
    throw new Error(
      chain === Chain.SOLANA
        ? 'OWNER_WALLET_SOLANA is not configured for admin actions.'
        : 'OWNER_WALLET_EVM is not configured for admin actions.',
    );
  }
  if (!isOwnerWallet(address, chain)) {
    throw new Error('Admin action requires the configured owner wallet.');
  }
}

export function isAdminWallet(address: string, chain: Chain): boolean {
  return isOwnerWallet(address, chain);
}
