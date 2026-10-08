import { Chain, CustodyFamily, prisma, type User } from '@copyra/db';
import { provisionUserCustody } from '@copyra/core';
import { accountSentinelAddress, randomReferralCode } from './crypto.js';
import { readReferralCookie } from './redis-codes.js';

export async function resolveReferrerId(
  cookies: Record<string, string | undefined>,
  explicitCode?: string | null,
): Promise<string | null> {
  const code = (explicitCode || readReferralCookie(cookies) || '').trim().toLowerCase();
  if (!code) return null;
  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
  return referrer?.id ?? null;
}

export async function createEmailPendingUser(input: {
  email: string;
  passwordHash: string;
  referredById?: string | null;
}): Promise<User> {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const referralCode = randomReferralCode();
  const address = accountSentinelAddress(id);
  return prisma.user.create({
    data: {
      id,
      address,
      chain: Chain.SOLANA,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      referralCode,
      referredById: input.referredById ?? null,
      emailVerifiedAt: null,
    },
  });
}

export async function activateEmailUser(userId: string): Promise<User> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { emailVerifiedAt: new Date(), lastSeenAt: new Date() },
  });
  await provisionUserCustody(user.id);
  return user;
}

export async function upsertGoogleUser(input: {
  sub: string;
  email: string;
  name: string | null;
  referredById?: string | null;
}): Promise<{ user: User; created: boolean }> {
  const existing = await prisma.user.findUnique({ where: { googleSub: input.sub } });
  if (existing) {
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        googleEmail: input.email,
        googleName: input.name,
        email: existing.email ?? input.email,
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        lastSeenAt: new Date(),
      },
    });
    await provisionUserCustody(user.id);
    return { user, created: false };
  }

  // Email match: link only after Google proof (we have verified email_verified).
  const byEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== input.sub) {
      throw new Error('This email is already linked to a different Google account.');
    }
    const user = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleSub: input.sub,
        googleEmail: input.email,
        googleName: input.name,
        emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
        lastSeenAt: new Date(),
      },
    });
    await provisionUserCustody(user.id);
    return { user, created: false };
  }

  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const user = await prisma.user.create({
    data: {
      id,
      address: accountSentinelAddress(id),
      chain: Chain.SOLANA,
      email: input.email,
      emailVerifiedAt: new Date(),
      googleSub: input.sub,
      googleEmail: input.email,
      googleName: input.name,
      referralCode: randomReferralCode(),
      referredById: input.referredById ?? null,
      label: input.name,
    },
  });
  await provisionUserCustody(user.id);
  return { user, created: true };
}

export async function ensureReferralCode(user: User): Promise<string> {
  if (user.referralCode) return user.referralCode;
  const code = randomReferralCode();
  await prisma.user.update({ where: { id: user.id }, data: { referralCode: code } });
  return code;
}

export async function linkWalletToUser(input: {
  userId: string;
  address: string;
  family: CustodyFamily;
}): Promise<void> {
  const taken = await prisma.userWalletLink.findUnique({
    where: { family_address: { family: input.family, address: input.address } },
  });
  if (taken && taken.userId !== input.userId) {
    throw new Error('This wallet is already linked to another COPYRA account.');
  }
  const otherUser = await prisma.user.findUnique({ where: { address: input.address } });
  if (otherUser && otherUser.id !== input.userId) {
    throw new Error('This wallet is already linked to another COPYRA account.');
  }
  await prisma.userWalletLink.upsert({
    where: { userId_family: { userId: input.userId, family: input.family } },
    create: { userId: input.userId, family: input.family, address: input.address },
    update: { address: input.address, linkedAt: new Date() },
  });
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    address: user.address?.startsWith('acct_') ? null : user.address,
    chain: user.chain,
    label: user.label,
    google: Boolean(user.googleSub),
    twofa: user.totpEnabled,
    referralCode: user.referralCode,
    /** Linked for BUY/SELL Telegram alerts (chat id itself is not exposed). */
    telegramLinked: Boolean(user.telegramChatId),
    telegramChatIdMasked: user.telegramChatId
      ? `${user.telegramChatId.slice(0, 3)}…${user.telegramChatId.slice(-3)}`
      : null,
    wallets: {
      sol: null as string | null,
      evm: null as string | null,
    },
    created: user.createdAt.getTime(),
  };
}
