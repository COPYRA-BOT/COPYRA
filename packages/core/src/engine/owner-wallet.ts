import { Chain } from '@copyra/db';
import { getAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { env } from '../config/env.js';

/**
 * Owner wallets are the only addresses allowed to deposit, trade, and withdraw.
 * Configure OWNER_WALLET_SOLANA / OWNER_WALLET_EVM as App-Level secrets.
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

/** Throws if the session address is not the configured owner for this chain. */
export function assertOwnerWallet(address: string, chain: Chain): void {
  const owner = ownerWalletForChain(chain);
  if (!owner) {
    throw new Error(
      chain === Chain.SOLANA
        ? 'OWNER_WALLET_SOLANA is not configured. Set it as an App-Level secret, then redeploy.'
        : 'OWNER_WALLET_EVM is not configured. Set it as an App-Level secret, then redeploy.',
    );
  }
  if (!isOwnerWallet(address, chain)) {
    throw new Error(
      'Only the owner wallet may deposit, trade, or withdraw. Connect the configured OWNER_WALLET and sign in again.',
    );
  }
}
