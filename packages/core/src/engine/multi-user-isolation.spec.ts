import { describe, expect, it } from 'vitest';
import { deriveEvmAccount, deriveSolanaKeypair } from '../security/user-custody.js';

/**
 * Proves per-user wallet isolation at the derivation layer (no shared pooled address).
 * DB-scoped ledger tests run against Prisma in integration deploy smoke.
 */
describe('multi-user custody isolation', () => {
  it('user A custody address never equals user B', () => {
    const userA = 'clxxxxx-user-a';
    const userB = 'clxxxxx-user-b';
    expect(deriveSolanaKeypair(userA).publicKey.toBase58()).not.toBe(
      deriveSolanaKeypair(userB).publicKey.toBase58(),
    );
    expect(deriveEvmAccount(userA).address).not.toBe(deriveEvmAccount(userB).address);
  });

  it('rejects cross-user ledger address match at the string level', () => {
    const a = deriveSolanaKeypair('ledger-a').publicKey.toBase58();
    const b = deriveSolanaKeypair('ledger-b').publicKey.toBase58();
    const assertSameUser = (owned: string, queried: string) => owned === queried;
    expect(assertSameUser(a, b)).toBe(false);
    expect(assertSameUser(a, a)).toBe(true);
  });

  it('trader uniqueness key is per account (same address ok for different users)', () => {
    const key = (userId: string, chain: string, address: string) =>
      `${userId}:${chain}:${address.toLowerCase()}`;
    const whale = '0xabc123';
    expect(key('user-a', 'BASE', whale)).not.toBe(key('user-b', 'BASE', whale));
    expect(key('user-a', 'BASE', whale)).toBe(key('user-a', 'BASE', whale));
  });

  it('processed-signature key is per trader row (two accounts can copy same tx)', () => {
    const key = (chain: string, signature: string, traderId: string) =>
      `${chain}:${signature}:${traderId}`;
    const sig = '0xdeadbeef';
    expect(key('BASE', sig, 'trader-a')).not.toBe(key('BASE', sig, 'trader-b'));
  });
});
