import { createHash, randomBytes } from 'node:crypto';
import { env, provisionUserCustody } from '@copyra/core';
import { prisma } from '@copyra/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MODE_COOKIES, type AuthMode, type SessionView } from '../auth.js';

const SESSION_DAYS = 7;
const ACCOUNT_COOKIE = 'copyra_session_acct';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieSecure(): boolean {
  return env.PUBLIC_WEB_URL.startsWith('https://');
}

/**
 * Create a server session for an account (email/Google/wallet-linked).
 * Sets account cookie + both mode cookies so existing SOL/EVM routes keep working.
 */
export async function createAccountSession(
  userId: string,
  reply: FastifyReply,
  meta: { userAgent?: string; ip?: string },
): Promise<{ expiresAt: Date }> {
  await provisionUserCustody(userId);
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  });
  const secure = cookieSecure();
  const opts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    expires: expiresAt,
  };
  reply.setCookie(ACCOUNT_COOKIE, token, opts);
  reply.setCookie(MODE_COOKIES.sol, token, opts);
  reply.setCookie(MODE_COOKIES.evm, token, opts);
  await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date() } });
  return { expiresAt };
}

export async function readAccountSession(request: FastifyRequest): Promise<SessionView | null> {
  const token =
    request.cookies[ACCOUNT_COOKIE] ||
    request.cookies[MODE_COOKIES.sol] ||
    request.cookies[MODE_COOKIES.evm];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  return session;
}

export async function revokeAccountSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tokens = [
    request.cookies[ACCOUNT_COOKIE],
    request.cookies[MODE_COOKIES.sol],
    request.cookies[MODE_COOKIES.evm],
  ].filter(Boolean) as string[];
  for (const token of tokens) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  const secure = cookieSecure();
  for (const name of [ACCOUNT_COOKIE, MODE_COOKIES.sol, MODE_COOKIES.evm]) {
    reply.clearCookie(name, { path: '/', secure, sameSite: 'lax' });
  }
}

export { ACCOUNT_COOKIE };
export type { AuthMode };
