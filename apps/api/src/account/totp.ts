import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { decryptSecret, encryptSecret, sha256Hex } from './crypto.js';
import { markTotpUsed } from './redis-codes.js';

export function generateTotpSecret(): string {
  return generateSecret();
}

export function encryptTotpSecret(secret: string): string {
  return encryptSecret(secret);
}

export function decryptTotpSecret(enc: string): string {
  return decryptSecret(enc);
}

export async function totpSetupPayload(emailOrLabel: string, secret: string) {
  const otpauth = generateURI({
    issuer: 'COPYRA',
    label: emailOrLabel,
    secret,
  });
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, otpauth, qrDataUrl };
}

export async function verifyTotpCode(userId: string, secretEnc: string, code: string): Promise<boolean> {
  const secret = decryptTotpSecret(secretEnc);
  const result = await verify({ token: code.trim(), secret });
  const ok = Boolean(result && typeof result === 'object' && 'valid' in result && result.valid);
  if (!ok) return false;
  return markTotpUsed(userId, code.trim());
}

export function makeRecoveryCodes(count = 10): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const code = randomBytes(5).toString('hex');
    plain.push(code);
    hashes.push(sha256Hex(code));
  }
  return { plain, hashes };
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(code.trim().toLowerCase());
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
