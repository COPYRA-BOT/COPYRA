import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Chain, prisma } from '@copyra/db';
import { consumeAuthNonce, env, isOwnerWallet, provisionUserCustody, storeAuthNonce } from '@copyra/core';
import { CustodyFamily } from '@copyra/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import nacl from 'tweetnacl';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { verifyMessage } from 'viem';
import { randomReferralCode } from './account/crypto.js';
import { resolveReferrerId } from './account/users.js';

/** Legacy single cookie — still read for migration, never written for new logins. */
const LEGACY_SESSION_COOKIE = 'copyra_session';
const SESSION_DAYS = 7;

export type AuthMode = 'sol' | 'evm';

const MODE_COOKIES: Record<AuthMode, string> = {
  sol: 'copyra_session_sol',
  evm: 'copyra_session_evm',
};

export function authModeFromChain(chain: Chain): AuthMode {
  return chain === Chain.SOLANA ? 'sol' : 'evm';
}

export function authModeFromRequest(
  request: FastifyRequest,
  preferred?: AuthMode | null,
): AuthMode {
  if (preferred === 'sol' || preferred === 'evm') return preferred;
  const header = String(request.headers['x-copyra-mode'] ?? '')
    .trim()
    .toLowerCase();
  if (header === 'sol' || header === 'evm') return header;
  const query = (request.query ?? {}) as { mode?: string };
  if (query.mode === 'sol' || query.mode === 'evm') return query.mode;
  return 'sol';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieSecure(override?: boolean): boolean {
  if (typeof override === 'boolean') return override;
  return env.PUBLIC_WEB_URL.startsWith('https://');
}

export type SessionView = {
  id: string;
  user: {
    id: string;
    address: string;
    chain: Chain;
    label: string | null;
    email?: string | null;
    googleEmail?: string | null;
  };
};

/** Issue a one-time nonce in Redis (10 minute TTL). */
export async function issueNonce(
  address: string,
  chain: Chain,
): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString('hex');
  const { expiresAt } = await storeAuthNonce(address, chain, nonce);
  return { nonce, expiresAt };
}

export function buildSiweMessage(input: {
  address: string;
  nonce: string;
  chainId: number;
  issuedAt: string;
  webOrigin?: string;
  /** Prefer browser location.host — wallets compare this to the page origin. */
  domainHost?: string;
}): string {
  const origin = (input.webOrigin ?? env.PUBLIC_WEB_URL).replace(/\/+$/, '');
  // Wallets compare domain to location.host (hostname[:port], no scheme).
  const domain = (input.domainHost?.trim() || new URL(origin).host).replace(/^https?:\/\//i, '');
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
  /** Prefer browser location.host — wallets compare this to the page origin. */
  domainHost?: string;
}): string {
  const origin = (input.webOrigin ?? env.PUBLIC_WEB_URL).replace(/\/+$/, '');
  const domain = (input.domainHost?.trim() || new URL(origin).host).replace(/^https?:\/\//i, '');
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
  /** Lowercase EVM / base58 Solana address used when the nonce was issued. */
  storageAddress?: string;
  chain: Chain;
  message: string;
  signature: string;
}): Promise<boolean> {
  const lookupAddress = input.storageAddress ?? input.address;
  const nonce = await consumeAuthNonce(lookupAddress, input.chain);
  if (!nonce) return false;
  if (!input.message.includes(nonce)) return false;

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

  return ok;
}

async function loadSessionByToken(token: string | undefined): Promise<SessionView | null> {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  return session;
}

/**
 * Create a mode-scoped session cookie.
 * SOL and EVM logins are independent — signing into one never clears the other.
 */
export async function createSession(
  address: string,
  chain: Chain,
  reply: FastifyReply,
  meta: {
    userAgent?: string;
    ip?: string;
    secureCookie?: boolean;
    /** Incoming cookies — used to migrate the legacy shared session into the other mode. */
    cookies?: Record<string, string | undefined>;
  },
): Promise<{ userId: string; expiresAt: Date; mode: AuthMode }> {
  const mode = authModeFromChain(chain);
  const otherMode: AuthMode = mode === 'sol' ? 'evm' : 'sol';
  const admin = isOwnerWallet(address, chain);
  const referredById = await resolveReferrerId(meta.cookies ?? {});
  const existing = await prisma.user.findUnique({ where: { address } });
  // Never attach self-referral; never overwrite an existing attribution.
  const safeReferrer =
    referredById && (!existing || existing.id !== referredById) ? referredById : null;
  const user = await prisma.user.upsert({
    where: { address },
    create: {
      address,
      chain,
      isAdmin: admin,
      referralCode: randomReferralCode(),
      referredById: safeReferrer,
    },
    update: { lastSeenAt: new Date(), chain, ...(admin ? { isAdmin: true } : {}) },
  });
  await provisionUserCustody(user.id);
  const family = chain === Chain.SOLANA ? CustodyFamily.SOLANA : CustodyFamily.EVM;
  // Refuse silently if this login wallet is already linked to a different account
  // (unique on family+address). Primary address users already own the row.
  try {
    await prisma.userWalletLink.upsert({
      where: { userId_family: { userId: user.id, family } },
      create: { userId: user.id, family, address },
      update: { address, linkedAt: new Date() },
    });
  } catch {
    /* unique conflict — keep existing link ownership */
  }
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
  const secure = cookieSecure(meta.secureCookie);
  reply.setCookie(MODE_COOKIES[mode], token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
  // Unified account cookie for Account / Referrals / 2FA pages.
  reply.setCookie('copyra_session_acct', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });

  // If the legacy cookie holds the *other* mode's session and that mode has no cookie yet,
  // copy it into the mode-scoped cookie before clearing legacy.
  const legacyToken = meta.cookies?.[LEGACY_SESSION_COOKIE];
  const otherAlready = meta.cookies?.[MODE_COOKIES[otherMode]];
  if (legacyToken && !otherAlready) {
    const legacy = await loadSessionByToken(legacyToken);
    if (legacy && authModeFromChain(legacy.user.chain) === otherMode) {
      const legacyRow = await prisma.session.findUnique({
        where: { tokenHash: hashToken(legacyToken) },
      });
      reply.setCookie(MODE_COOKIES[otherMode], legacyToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure,
        path: '/',
        expires: legacyRow?.expiresAt ?? expiresAt,
      });
    }
  }

  reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
  return { userId: user.id, expiresAt, mode };
}

/** Read the session for one mode (sol | evm). Falls back to legacy cookie when kind matches. */
export async function readSession(
  request: FastifyRequest,
  mode?: AuthMode | null,
): Promise<SessionView | null> {
  const resolved = authModeFromRequest(request, mode);
  const token = request.cookies[MODE_COOKIES[resolved]];
  const scoped = await loadSessionByToken(token);
  if (scoped) {
    await prisma.user.update({
      where: { id: scoped.user.id },
      data: { lastSeenAt: new Date() },
    });
    return scoped;
  }

  // Migration: legacy single cookie only if it matches the requested mode family.
  const legacy = await loadSessionByToken(request.cookies[LEGACY_SESSION_COOKIE]);
  if (!legacy) return null;
  const legacyMode = authModeFromChain(legacy.user.chain);
  if (legacyMode !== resolved) return null;
  await prisma.user.update({
    where: { id: legacy.user.id },
    data: { lastSeenAt: new Date() },
  });
  return legacy;
}

/** Both mode sessions — used by snapshot so SOL and EVM dashboards stay independent. */
export async function readBothSessions(request: FastifyRequest): Promise<{
  sol: SessionView | null;
  evm: SessionView | null;
}> {
  const [sol, evm] = await Promise.all([readSession(request, 'sol'), readSession(request, 'evm')]);
  return { sol, evm };
}

/**
 * Revoke sessions.
 * - mode 'sol' | 'evm' → only that mode (other mode stays signed in)
 * - mode 'all' → both modes + legacy cookie
 */
export async function revokeSession(
  request: FastifyRequest,
  reply: FastifyReply,
  mode: AuthMode | 'all' = 'all',
): Promise<void> {
  const targets: AuthMode[] = mode === 'all' ? ['sol', 'evm'] : [mode];

  for (const m of targets) {
    const cookieName = MODE_COOKIES[m];
    const token = request.cookies[cookieName];
    if (token) {
      await prisma.session.updateMany({
        where: { tokenHash: hashToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(cookieName, { path: '/' });
  }

  if (mode === 'all') {
    const legacy = request.cookies[LEGACY_SESSION_COOKIE];
    if (legacy) {
      await prisma.session.updateMany({
        where: { tokenHash: hashToken(legacy), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: '/' });
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export { MODE_COOKIES, LEGACY_SESSION_COOKIE };
