import { describe, expect, it } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  randomReferralCode,
  randomDigits,
} from './crypto.js';

describe('account crypto', () => {
  it('argon2id hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('encrypts TOTP secrets round-trip', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('makes unguessable referral codes and 6-digit email codes', () => {
    expect(randomReferralCode()).toHaveLength(18);
    expect(randomDigits(6)).toMatch(/^\d{6}$/);
  });
});
