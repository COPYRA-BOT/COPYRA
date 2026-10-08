import { env } from '@copyra/core';
import { Chain, prisma, ReferralLedgerKind } from '@copyra/db';

/**
 * Platform fees are NOT collected today (docs/ACCOUNTS_FEES_STOP.md).
 * Accrual stays disabled; claim only moves real ledger claimable (normally 0).
 */
export const REFERRAL_EARNINGS_ENABLED = false;
export const REFERRAL_STOP_REASON = 'PLATFORM_FEES_NOT_COLLECTED' as const;

function publicBaseUrl(): string {
  const raw = (env.PUBLIC_WEB_URL || 'https://copyra.fun').replace(/\/+$/, '');
  try {
    const host = new URL(raw).hostname.toLowerCase();
    // Always share the primary product domain — never the App Platform preview host.
    if (host.endsWith('ondigitalocean.app') || host === 'www.copyra.fun') {
      return 'https://copyra.fun';
    }
  } catch {
    return 'https://copyra.fun';
  }
  return raw || 'https://copyra.fun';
}

export async function referralSummary(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const friends = await prisma.user.findMany({
    where: { referredById: userId },
    select: {
      id: true,
      email: true,
      address: true,
      createdAt: true,
      label: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  const ledger = await prisma.referralLedgerEntry.findMany({
    where: { beneficiaryUserId: userId },
  });

  let earnedRawSol = 0n;
  let earnedRawUsdc = 0n;
  let claimedRawSol = 0n;
  let claimedRawUsdc = 0n;
  for (const row of ledger) {
    const raw = BigInt(row.amountRaw);
    if (row.kind === ReferralLedgerKind.ACCRUAL) {
      if (row.assetSymbol === 'SOL') earnedRawSol += raw;
      else earnedRawUsdc += raw;
    }
    if (row.kind === ReferralLedgerKind.CLAIM) {
      if (row.assetSymbol === 'SOL') claimedRawSol += raw;
      else claimedRawUsdc += raw;
    }
  }

  const claimableSol = earnedRawSol > claimedRawSol ? earnedRawSol - claimedRawSol : 0n;
  const claimableUsdc = earnedRawUsdc > claimedRawUsdc ? earnedRawUsdc - claimedRawUsdc : 0n;
  // USD view: USDC 1:1; SOL left as 0 until a live price is attached at display time by caller.
  const claimableUsd = Number(claimableUsdc) / 1e6;
  const totalEarnedUsd = Number(earnedRawUsdc) / 1e6;

  const refs = friends.map((f) => {
    const daysLeft = Math.max(
      0,
      30 - Math.floor((Date.now() - f.createdAt.getTime()) / 86_400_000),
    );
    const mask = f.email
      ? f.email.replace(/^(.).*(@.*)$/, '$1***$2')
      : f.address?.startsWith('acct_')
        ? 'wallet'
        : `${f.address?.slice(0, 4)}…${f.address?.slice(-4)}`;
    return {
      n: f.label || mask,
      joined: f.createdAt.getTime(),
      daysLeft,
      vol: 0,
      fee: 0,
      earn: 0,
    };
  });

  return {
    link: `${publicBaseUrl()}/?ref=${user.referralCode}`,
    code: user.referralCode,
    refs,
    claimable: claimableUsd,
    claimableSol: Number(claimableSol) / 1e9,
    claimableUsdc: Number(claimableUsdc) / 1e6,
    totalEarned: totalEarnedUsd,
    earningsEnabled: REFERRAL_EARNINGS_ENABLED,
    reason: REFERRAL_EARNINGS_ENABLED ? null : REFERRAL_STOP_REASON,
    note: REFERRAL_EARNINGS_ENABLED
      ? null
      : 'Platform fees are not collected on trades yet. Referral earnings stay at 0 until fees are ledgered from confirmed tx hashes.',
    minClaimUsd: env.REFERRAL_MIN_CLAIM_USD,
  };
}

/**
 * Atomically claim USDC referral credit into the account trading balance ledger.
 * No-op / error when nothing claimable. Does not invent fees.
 */
export async function claimReferralToTrading(
  userId: string,
  mode: 'sol' | 'evm',
): Promise<{ amount: number; asset: string; claimed: boolean; reason?: string }> {
  if (!REFERRAL_EARNINGS_ENABLED) {
    return {
      amount: 0,
      asset: mode === 'sol' ? 'SOL' : 'USDC',
      claimed: false,
      reason: REFERRAL_STOP_REASON,
    };
  }

  const summary = await referralSummary(userId);
  if (summary.claimable < env.REFERRAL_MIN_CLAIM_USD) {
    return {
      amount: 0,
      asset: 'USDC',
      claimed: false,
      reason: 'BELOW_MINIMUM',
    };
  }

  // Real claim path (enabled only after platform fees exist): credit savings→trading style ledger.
  const amountRaw = BigInt(Math.round(summary.claimableUsdc * 1e6));
  const idempotencyKey = `claim:${userId}:${amountRaw.toString()}:${Date.now()}`;
  await prisma.referralLedgerEntry.create({
    data: {
      beneficiaryUserId: userId,
      chain: Chain.BASE,
      amountRaw: amountRaw.toString(),
      assetSymbol: 'USDC',
      kind: ReferralLedgerKind.CLAIM,
      idempotencyKey,
    },
  });

  // Until fee collection exists this branch is unreachable (earningsEnabled false).
  return { amount: summary.claimableUsdc, asset: 'USDC', claimed: true };
}
