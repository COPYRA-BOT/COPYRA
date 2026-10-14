import { CustodyFamily } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import {
  decryptKeyMaterial,
  deriveCustodySeed,
  deriveEvmAccount,
  deriveSniperKeypair,
  deriveSolanaKeypair,
  encryptKeyMaterial,
} from './user-custody.js';

describe('user custody derivation', () => {
  it('derives distinct Solana and EVM wallets per user id', () => {
    const aSol = deriveSolanaKeypair('user-a').publicKey.toBase58();
    const bSol = deriveSolanaKeypair('user-b').publicKey.toBase58();
    const aEvm = deriveEvmAccount('user-a').address;
    const bEvm = deriveEvmAccount('user-b').address;
    expect(aSol).not.toBe(bSol);
    expect(aEvm).not.toBe(bEvm);
  });

  it('derives sniper custody distinct from SOL copy custody', () => {
    const sol = deriveSolanaKeypair('user-a').publicKey.toBase58();
    const snip = deriveSniperKeypair('user-a').publicKey.toBase58();
    expect(snip).not.toBe(sol);
    expect(deriveSniperKeypair('user-a').publicKey.toBase58()).toBe(snip);
  });

  it('is deterministic for the same user', () => {
    expect(deriveSolanaKeypair('stable').publicKey.toBase58()).toBe(
      deriveSolanaKeypair('stable').publicKey.toBase58(),
    );
    expect(deriveEvmAccount('stable').address).toBe(deriveEvmAccount('stable').address);
  });

  it('encrypts and decrypts key material without exposing plaintext in payload', () => {
    const seed = deriveCustodySeed('u1', CustodyFamily.SOLANA);
    const enc = encryptKeyMaterial(seed);
    expect(enc).not.toContain(seed.toString('hex'));
    const round = decryptKeyMaterial(enc);
    expect(round.equals(seed)).toBe(true);
  });
});

describe('deriveCustodyAddress', () => {
  it('matches keypair-derived addresses', async () => {
    const { CustodyFamily } = await import('@copyra/db');
    const { deriveCustodyAddress, deriveSolanaKeypair, deriveSniperKeypair, deriveEvmAccount } =
      await import('./user-custody.js');
    expect(deriveCustodyAddress('u1', CustodyFamily.SOLANA)).toBe(
      deriveSolanaKeypair('u1').publicKey.toBase58(),
    );
    expect(deriveCustodyAddress('u1', CustodyFamily.SNIPER)).toBe(
      deriveSniperKeypair('u1').publicKey.toBase58(),
    );
    expect(deriveCustodyAddress('u1', CustodyFamily.EVM)).toBe(
      deriveEvmAccount('u1').address.toLowerCase(),
    );
  });
});
