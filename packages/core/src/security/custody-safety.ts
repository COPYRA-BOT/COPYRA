import { Chain, prisma } from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { getQuoteAssetPriceUsd } from '../market/index.js';
import { getSettings } from '../engine/settings.js';
import { normalizeSessionAddress } from '../engine/owner-wallet.js';
import { componentLogger } from '../obs/logger.js';

const log = componentLogger('custody-safety');

export class CustodyBlockedError extends Error {
  readonly code = 'CUSTODY_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'CustodyBlockedError';
  }
}

function denyList(): Set<string> {
  const list = env.ADDRESS_DENY_LIST ?? [];
  return new Set(list.map((a) => a.trim().toLowerCase()));
}

export function assertAddressNotSanctioned(address: string, chain: Chain, context: string): void {
  if (!env.SANCTIONS_BLOCKLIST_ENABLED) return;
  let normalized: string;
  try {
    normalized = normalizeSessionAddress(address, chain);
  } catch {
    throw new CustodyBlockedError(`${context}: invalid address.`);
  }
  const blocked = denyList();
  if (blocked.has(normalized.toLowerCase()) || blocked.has(address.toLowerCase())) {
    throw new CustodyBlockedError(`${context}: address is blocked.`);
  }
}

export async function assertCustodyOperationsAllowed(userId: string): Promise<void> {
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { custodyPausedAt: true } }),
    getSettings(),
  ]);
  if (!user) throw new CustodyBlockedError('Account not found.');
  if (user.custodyPausedAt) {
    throw new CustodyBlockedError('Custody is paused for this account.');
  }
  if (env.GLOBAL_CUSTODY_EMERGENCY_STOP || settings.emergencyStop) {
    throw new CustodyBlockedError('Custody operations are paused (emergency stop).');
  }
}

export async function assertDepositWithinCaps(input: {
  userId: string;
  chain: Chain;
  amountQuote: number;
}): Promise<void> {
  const config = chainConfig(input.chain);
  let priceUsd = 1;
  try {
    priceUsd = await getQuoteAssetPriceUsd(input.chain);
  } catch {
    priceUsd = config.kind === 'solana' ? 150 : 3000;
  }
  const usd = input.amountQuote * priceUsd;

  if (env.PER_USER_DEPOSIT_CAP_USD > 0 && usd > env.PER_USER_DEPOSIT_CAP_USD) {
    throw new CustodyBlockedError(
      `Deposit exceeds per-user cap ($${env.PER_USER_DEPOSIT_CAP_USD.toFixed(2)}).`,
    );
  }

  if (env.GLOBAL_DEPOSIT_CAP_USD <= 0) return;

  const deposits = await prisma.custodyDeposit.findMany({
    where: { status: 'CONFIRMED' },
    select: { amountRaw: true, chain: true },
  });
  let totalUsd = 0;
  for (const row of deposits) {
    const c = chainConfig(row.chain);
    const quote = Number(row.amountRaw) / 10 ** c.nativeDecimals;
    try {
      totalUsd += quote * (await getQuoteAssetPriceUsd(row.chain));
    } catch {
      totalUsd += quote * (c.kind === 'solana' ? 150 : 3000);
    }
  }
  if (totalUsd + usd > env.GLOBAL_DEPOSIT_CAP_USD) {
    throw new CustodyBlockedError(
      `Platform deposit cap reached ($${env.GLOBAL_DEPOSIT_CAP_USD.toFixed(2)}).`,
    );
  }
}

export async function assertWithdrawWithinLimits(input: {
  userId: string;
  chain: Chain;
  amountQuote: number;
  toAddress: string;
}): Promise<void> {
  await assertCustodyOperationsAllowed(input.userId);
  assertAddressNotSanctioned(input.toAddress, input.chain, 'Withdrawal destination');

  const config = chainConfig(input.chain);
  let priceUsd = 1;
  try {
    priceUsd = await getQuoteAssetPriceUsd(input.chain);
  } catch {
    priceUsd = config.kind === 'solana' ? 150 : 3000;
  }
  const usd = input.amountQuote * priceUsd;

  if (env.WITHDRAW_DAILY_LIMIT_USD > 0 && usd > env.WITHDRAW_DAILY_LIMIT_USD) {
    throw new CustodyBlockedError(
      `Single withdrawal exceeds daily limit ($${env.WITHDRAW_DAILY_LIMIT_USD.toFixed(2)}).`,
    );
  }

  const since = new Date(Date.now() - 86_400_000);
  const recent = await prisma.transfer.findMany({
    where: {
      userId: input.userId,
      chain: input.chain,
      txHash: { not: null },
      status: 'CONFIRMED',
      confirmedAt: { gte: since },
    },
    select: { amountRaw: true },
  });
  let windowUsd = usd;
  for (const row of recent) {
    const quote = Number(row.amountRaw) / 10 ** config.nativeDecimals;
    windowUsd += quote * priceUsd;
  }
  if (env.WITHDRAW_DAILY_LIMIT_USD > 0 && windowUsd > env.WITHDRAW_DAILY_LIMIT_USD) {
    throw new CustodyBlockedError(
      `Daily withdrawal limit exceeded ($${env.WITHDRAW_DAILY_LIMIT_USD.toFixed(2)} / 24h).`,
    );
  }

  if (env.WITHDRAW_NEW_ADDRESS_COOLDOWN_HOURS > 0) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { createdAt: true, address: true, chain: true },
    });
    if (user) {
      const linked = normalizeSessionAddress(user.address, user.chain);
      let dest: string;
      try {
        dest = normalizeSessionAddress(input.toAddress, input.chain);
      } catch {
        throw new CustodyBlockedError('Invalid withdrawal destination.');
      }
      if (linked !== dest) {
        const cooldownMs = env.WITHDRAW_NEW_ADDRESS_COOLDOWN_HOURS * 3_600_000;
        if (Date.now() - user.createdAt.getTime() < cooldownMs) {
          throw new CustodyBlockedError(
            `Withdrawals to a new address are blocked for ${env.WITHDRAW_NEW_ADDRESS_COOLDOWN_HOURS}h after sign-up.`,
          );
        }
      }
    }
  }
}

export async function reconcileUserCustody(userId: string, chain: Chain): Promise<{
  address: string;
  onChainRaw: bigint;
  savingsRaw: bigint;
  mismatch: boolean;
}> {
  const { userCustodyAddress } = await import('./user-custody.js');
  const { readOnChainBalanceForAddress } = await import('../engine/portfolio.js');
  const { getSavingsRawForAddress } = await import('../engine/funds.js');

  const address = await userCustodyAddress(userId, chain);
  const balance = await readOnChainBalanceForAddress(chain, address);
  const config = chainConfig(chain);
  const onChainRaw = BigInt(Math.floor(balance.totalQuote * 10 ** config.nativeDecimals));
  const savingsRaw = await getSavingsRawForAddress(chain, address);

  const mismatch = onChainRaw < savingsRaw;
  if (mismatch) {
    log.warn({ userId, chain, address, onChainRaw: onChainRaw.toString(), savingsRaw: savingsRaw.toString() }, 'Custody reconciliation mismatch');
  }
  return { address, onChainRaw, savingsRaw, mismatch };
}
