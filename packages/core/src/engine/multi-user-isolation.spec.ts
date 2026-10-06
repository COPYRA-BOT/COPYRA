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
});
