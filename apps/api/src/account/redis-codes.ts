import { createHash, randomBytes } from 'node:crypto';
import { redis } from '@copyra/core';
import { constantTimeEqual, sha256Hex } from './crypto.js';

const EMAIL_CODE_TTL_SEC = 600; // 10 min
const EMAIL_RESEND_COOLDOWN_SEC = 60;
const EMAIL_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_TTL_SEC = 600;
const REF_COOKIE_TTL_SEC = 60 * 60 * 24 * 30;
const WEBAUTHN_CHALLENGE_TTL_SEC = 300;
const TOTP_REPLAY_TTL_SEC = 90;
const STEPUP_TTL_SEC = 300;

function hashCode(code: string): string {
  return sha256Hex(code.trim());
}

export async function storeEmailVerifyCode(email: string, code: string): Promise<void> {
  const r = redis();
  const key = `acct:email-code:${email.toLowerCase()}`;
  await r.set(
    key,
    JSON.stringify({ hash: hashCode(code), attempts: 0 }),
    'EX',
    EMAIL_CODE_TTL_SEC,
  );
  await r.set(`acct:email-resend:${email.toLowerCase()}`, '1', 'EX', EMAIL_RESEND_COOLDOWN_SEC);
}

export async function emailResendAllowed(email: string): Promise<boolean> {
  const hit = await redis().get(`acct:email-resend:${email.toLowerCase()}`);
  return !hit;
}

export async function consumeEmailVerifyCode(
  email: string,
  code: string,
): Promise<'ok' | 'invalid' | 'locked'> {
  const r = redis();
  const key = `acct:email-code:${email.toLowerCase()}`;
  const raw = await r.get(key);
  if (!raw) return 'invalid';
  let parsed: { hash: string; attempts: number };
  try {
    parsed = JSON.parse(raw) as { hash: string; attempts: number };
  } catch {
    await r.del(key);
    return 'invalid';
  }
  if (parsed.attempts >= EMAIL_MAX_ATTEMPTS) {
    await r.del(key);
    return 'locked';
  }
  if (!constantTimeEqual(parsed.hash, hashCode(code))) {
    parsed.attempts += 1;
    const ttl = await r.ttl(key);
    await r.set(key, JSON.stringify(parsed), 'EX', ttl > 0 ? ttl : EMAIL_CODE_TTL_SEC);
    return parsed.attempts >= EMAIL_MAX_ATTEMPTS ? 'locked' : 'invalid';
  }
  await r.del(key);
  return 'ok';
}

export async function storePasswordResetCode(email: string, code: string): Promise<void> {
  const r = redis();
  await r.set(
    `acct:pw-reset:${email.toLowerCase()}`,
    JSON.stringify({ hash: hashCode(code), attempts: 0 }),
    'EX',
    PASSWORD_RESET_TTL_SEC,
  );
}

export async function consumePasswordResetCode(
  email: string,
  code: string,
): Promise<'ok' | 'invalid' | 'locked'> {
  const r = redis();
  const key = `acct:pw-reset:${email.toLowerCase()}`;
  const raw = await r.get(key);
  if (!raw) return 'invalid';
  let parsed: { hash: string; attempts: number };
  try {
    parsed = JSON.parse(raw) as { hash: string; attempts: number };
  } catch {
    await r.del(key);
    return 'invalid';
  }
  if (parsed.attempts >= EMAIL_MAX_ATTEMPTS) {
    await r.del(key);
    return 'locked';
  }
  if (!constantTimeEqual(parsed.hash, hashCode(code))) {
    parsed.attempts += 1;
    const ttl = await r.ttl(key);
    await r.set(key, JSON.stringify(parsed), 'EX', ttl > 0 ? ttl : PASSWORD_RESET_TTL_SEC);
    return parsed.attempts >= EMAIL_MAX_ATTEMPTS ? 'locked' : 'invalid';
  }
  await r.del(key);
  return 'ok';
}

export async function rateLimitHit(bucket: string, max: number, windowSec: number): Promise<boolean> {
  const r = redis();
  const key = `acct:rl:${bucket}`;
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowSec);
  return n > max;
}

export async function rememberReferralCode(code: string, replySet: (name: string, value: string, maxAge: number) => void): Promise<void> {
  replySet('copyra_ref', code.trim().toLowerCase(), REF_COOKIE_TTL_SEC);
}

export function readReferralCookie(cookies: Record<string, string | undefined>): string | null {
  const v = cookies.copyra_ref?.trim();
  return v ? v.toLowerCase() : null;
}

export async function storeWebAuthnChallenge(userId: string, challenge: string): Promise<void> {
  await redis().set(`acct:webauthn:${userId}`, challenge, 'EX', WEBAUTHN_CHALLENGE_TTL_SEC);
}

export async function takeWebAuthnChallenge(userId: string): Promise<string | null> {
  const r = redis();
  const key = `acct:webauthn:${userId}`;
  const v = await r.get(key);
  if (v) await r.del(key);
  return v;
}

/** TOTP replay protection: one window code usable once. */
export async function markTotpUsed(userId: string, code: string): Promise<boolean> {
  const key = `acct:totp-used:${userId}:${createHash('sha256').update(code).digest('hex').slice(0, 16)}`;
  const ok = await redis().set(key, '1', 'EX', TOTP_REPLAY_TTL_SEC, 'NX');
  return ok === 'OK';
}

export async function storeStepUp(userId: string, kind: 'totp' | 'wallet'): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await redis().set(`acct:stepup:${userId}`, JSON.stringify({ token: sha256Hex(token), kind }), 'EX', STEPUP_TTL_SEC);
  return token;
}

export async function consumeStepUp(userId: string, token: string): Promise<boolean> {
  const r = redis();
  const key = `acct:stepup:${userId}`;
  const raw = await r.get(key);
  if (!raw) return false;
  let parsed: { token: string };
  try {
    parsed = JSON.parse(raw) as { token: string };
  } catch {
    return false;
  }
  if (!constantTimeEqual(parsed.token, sha256Hex(token))) return false;
  await r.del(key);
  return true;
}
