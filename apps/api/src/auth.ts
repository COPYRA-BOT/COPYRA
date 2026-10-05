import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Chain, prisma } from '@copyra/db';
import { env } from '@copyra/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyMessage } from 'viem';

const SESSION_COOKIE = 'copyra_session';
const SESSION_DAYS = 7;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieSecure(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  return env.PUBLIC_WEB_URL.startsWith('https://');
}

export async function issueNonce(address: string, chain: Chain): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await prisma.authNonce.create({ data: { nonce, address, chain, expiresAt } });
  return { nonce, expiresAt };
}

export function buildSiweMessage(input: {
  address: string;
  nonce: string;
  chainId: number;
  issuedAt: string;
  webOrigin?: string;
}): string {
  const origin = input.webOrigin ?? env.PUBLIC_WEB_URL;
  const domain = new URL(origin).host;
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    input.address,
    '',
    'Sign in to COPYRA. This proves you control the wallet. COPYRA never asks for your private key.',
    '',
    `URI: ${origin}`,
    `Version: 1`,
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join('\n');
}

export function buildSiwsMessage(input: {
  address: string;
  nonce: string;
  issuedAt: string;
  webOrigin?: string;
}): string {
  const origin = input.webOrigin ?? env.PUBLIC_WEB_URL;
  const domain = new URL(origin).host;
  return [
    `${domain} wants you to sign in with your Solana account:`,
    input.address,
    '',
    'Sign in to COPYRA. This proves you control the wallet. COPYRA never asks for your private key or seed phrase.',
    '',
    `URI: ${origin}`,
    `Version: 1`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join('\n');
}

export async function verifyWalletSignature(input: {
  address: string;
  chain: Chain;
  message: string;
  signature: string;
}): Promise<boolean> {
  const record = await prisma.authNonce.findFirst({
    where: { address: input.address, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { issuedAt: 'desc' },
  });
  if (!record) return false;
  if (!input.message.includes(record.nonce)) return false;

  let ok = false;
  if (input.chain === Chain.SOLANA) {
    try {
      const pubkey = new PublicKey(input.address);
      const sig = bs58.decode(input.signature);
      const message = new TextEncoder().encode(input.message);
      ok = nacl.sign.detached.verify(message, sig, pubkey.toBytes());
    } catch {
      ok = false;
    }
  } else {
    try {
      ok = await verifyMessage({
        address: input.address as `0x${string}`,
        message: input.message,
        signature: input.signature as `0x${string}`,
      });
    } catch {
      ok = false;
    }
  }

  if (!ok) return false;
  await prisma.authNonce.update({ where: { id: record.id }, data: { usedAt: new Date() } });
  return true;
}

export async function createSession(
  address: string,
  chain: Chain,
  reply: FastifyReply,
  meta: { userAgent?: string; ip?: string; secureCookie?: boolean },
): Promise<{ userId: string; expiresAt: Date }> {
  const user = await prisma.user.upsert({
    where: { address },
    create: { address, chain },
    update: { lastSeenAt: new Date(), chain },
  });
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(meta.secureCookie),
    path: '/',
    expires: expiresAt,
  });
  return { userId: user.id, expiresAt };
}

export async function readSession(request: FastifyRequest): Promise<{
  id: string;
  user: { id: string; address: string; chain: Chain; label: string | null };
} | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  await prisma.user.update({ where: { id: session.user.id }, data: { lastSeenAt: new Date() } });
  return session;
}

export async function revokeSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
