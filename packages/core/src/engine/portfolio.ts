import {
  BalanceBucket,
  Chain,
  PositionStatus,
  prisma,
} from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import { getQuoteAssetPriceUsd } from '../market/index.js';
import { componentLogger } from '../obs/logger.js';
import { evmSigner, solanaSigner } from '../security/signer.js';
import { multiUserCustodyEnabled, userCustodyAddress } from '../security/user-custody.js';
import { getErc20Balance, getNativeBalance } from '../evm/tokens.js';
import { getSpendableSol } from '../solana/executor.js';
import type { PortfolioState } from './types.js';

/** Savings reservation for an address (avoids importing funds.ts — circular). */
async function savingsQuoteForAddress(chain: Chain, address: string): Promise<number> {
  const config = chainConfig(chain);
  const assetAddress =
    config.kind === 'solana' ? 'native' : (config.stableAsset ?? 'native').toLowerCase();
  const decimals =
    config.kind === 'solana' ? 9 : (config.stableAssetDecimals ?? config.nativeDecimals);
  const row = await prisma.walletBalance.findUnique({
    where: {
      chain_address_bucket_assetAddress: {
        chain,
        address,
        bucket: BalanceBucket.SAVINGS,
        assetAddress,
      },
    },
  });
  if (!row) return 0;
  return Number(BigInt(row.amountRaw)) / 10 ** decimals;
}

const log = componentLogger('portfolio');

const LIVE_POSITION_STATUSES: PositionStatus[] = [
  PositionStatus.PENDING_OPEN,
  PositionStatus.OPEN,
  PositionStatus.PARTIALLY_CLOSED,
  PositionStatus.CLOSING,
];

export class NoTradingWalletError extends Error {
  readonly code = 'NO_TRADING_WALLET';
  constructor(chain: Chain) {
    super(
      `No trading wallet is configured for ${chain}. Balances cannot be read, so no trade can be sized.`,
    );
    this.name = 'NoTradingWalletError';
  }
}

/** The bot's own trading address on a chain, or null when unconfigured. */
export function tradingWalletAddress(chain: Chain): string | null {
  return chainConfig(chain).kind === 'solana' ? solanaSigner.address : evmSigner.address;
}

export interface OnChainBalance {
  /** Spendable quote-asset balance in whole units, after fee reserve. */
  availableQuote: number;
  /** Raw balance before the fee reserve, for display. */
  totalQuote: number;
  /** Exact on-chain raw units (lamports / token base units). Prefer over re-parsing totalQuote. */
  amountRaw: bigint;
  quotePriceUsd: number;
  totalUsd: number;
  blockOrSlot: bigint;
  readAt: Date;
  address: string;
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
}

/**
 * Reads the trading balance straight from the chain.
 * Solana → native SOL. EVM → USDC (stableAsset) when configured, else native.
 */
export async function readOnChainBalanceForAddress(
  chain: Chain,
  address: string,
): Promise<OnChainBalance> {
  const config = chainConfig(chain);

  if (config.kind === 'solana') {
    const [quotePriceUsd, spendable] = await Promise.all([
      getQuoteAssetPriceUsd(chain),
      getSpendableSol(address),
    ]);
    const totalQuote = Number(spendable.rawLamports) / 1e9;
    return {
      availableQuote: spendable.spendableSol,
      totalQuote,
      amountRaw: spendable.rawLamports,
      quotePriceUsd,
      totalUsd: totalQuote * quotePriceUsd,
      blockOrSlot: spendable.slot,
      readAt: new Date(),
      address,
      assetAddress: 'native',
      assetSymbol: 'SOL',
      assetDecimals: 9,
    };
  }

  // Custody deposits are USDC — never surface native BNB/ETH as "USDC" on the dashboard.
  if (config.stableAsset) {
    const decimals = config.stableAssetDecimals ?? 6;
    const token = await getErc20Balance(chain, config.stableAsset, address);
    const totalQuote = Number(token.amountRaw) / 10 ** decimals;
    return {
      availableQuote: Math.max(0, totalQuote),
      totalQuote,
      amountRaw: token.amountRaw,
      quotePriceUsd: 1,
      totalUsd: totalQuote,
      blockOrSlot: token.blockNumber,
      readAt: new Date(),
      address,
      assetAddress: config.stableAsset.toLowerCase(),
      assetSymbol: config.stableAssetSymbol ?? 'USDC',
      assetDecimals: decimals,
    };
  }

  const quotePriceUsd = await getQuoteAssetPriceUsd(chain);
  const native = await getNativeBalance(chain, address);
  const totalQuote = Number(native.amountRaw) / 10 ** config.nativeDecimals;
  const gasReserve = 0.002;
  return {
    availableQuote: Math.max(0, totalQuote - gasReserve),
    totalQuote,
    amountRaw: native.amountRaw,
    quotePriceUsd,
    totalUsd: totalQuote * quotePriceUsd,
    blockOrSlot: native.blockNumber,
    readAt: new Date(),
    address,
    assetAddress: 'native',
    assetSymbol: config.nativeSymbol,
    assetDecimals: config.nativeDecimals,
  };
}

export async function readOnChainBalance(chain: Chain): Promise<OnChainBalance> {
  const address = tradingWalletAddress(chain);
  if (!address) throw new NoTradingWalletError(chain);
  return readOnChainBalanceForAddress(chain, address);
}

/** Bot signer address, or the account's custody wallet when multi-user custody is on. */
export async function resolveTradingAddress(
  chain: Chain,
  userId?: string,
): Promise<string | null> {
  if (userId && multiUserCustodyEnabled()) {
    try {
      return await userCustodyAddress(userId, chain);
    } catch (error) {
      log.warn({ err: error, userId, chain }, 'Could not resolve user custody address');
      return null;
    }
  }
  return tradingWalletAddress(chain);
}

/** Persists a balance snapshot so the dashboard can show read-time and source. */
export async function snapshotBalance(
  chain: Chain,
  balance: OnChainBalance,
  bucket: BalanceBucket = BalanceBucket.TRADING,
): Promise<void> {
  const assetAddress = balance.assetAddress || 'native';
  const raw = balance.amountRaw.toString();
  await prisma.walletBalance.upsert({
    where: {
      chain_address_bucket_assetAddress: {
        chain,
        address: balance.address,
        bucket,
        assetAddress,
      },
    },
    create: {
      chain,
      address: balance.address,
      bucket,
      assetAddress,
      assetSymbol: balance.assetSymbol,
      decimals: balance.assetDecimals,
      amountRaw: raw,
      priceUsd: balance.quotePriceUsd,
      valueUsd: balance.totalUsd,
      readAtBlock: balance.blockOrSlot,
      readAt: balance.readAt,
      source: 'rpc',
    },
    update: {
      amountRaw: raw,
      priceUsd: balance.quotePriceUsd,
      valueUsd: balance.totalUsd,
      readAtBlock: balance.blockOrSlot,
      readAt: balance.readAt,
      source: 'rpc',
      assetSymbol: balance.assetSymbol,
      decimals: balance.assetDecimals,
    },
  });
}

/**
 * Builds the portfolio state the sizing function needs.
 *
 * Balance comes from the chain (the account custody wallet when multi-user
 * custody is enabled); deployed capital and position counts come from the
 * database for that same account.
 */
export async function buildPortfolioState(
  chain: Chain,
  tokenAddress: string,
  userId?: string,
): Promise<{ state: PortfolioState; balance: OnChainBalance }> {
  const address = await resolveTradingAddress(chain, userId);
  if (!address) throw new NoTradingWalletError(chain);
  const balance = await readOnChainBalanceForAddress(chain, address);
  const savingsQuote = await savingsQuoteForAddress(chain, address).catch(() => 0);

  const owner = userId ? { userId } : {};
  const [openPositions, tokenPosition] = await Promise.all([
    prisma.position.findMany({
      where: { ...owner, status: { in: LIVE_POSITION_STATUSES } },
      select: { id: true, entryValueUsd: true, realizedPnlUsd: true, chain: true },
    }),
    prisma.position.findFirst({
      where: {
        ...owner,
        chain,
        tokenAddress: chain === Chain.SOLANA ? tokenAddress : tokenAddress.toLowerCase(),
        status: { in: LIVE_POSITION_STATUSES },
      },
      select: { id: true },
    }),
  ]);

  const deployedUsd = openPositions.reduce(
    (sum, p) => sum + Number(p.entryValueUsd ?? 0) - Number(p.realizedPnlUsd ?? 0),
    0,
  );

  return {
    balance,
    state: {
      tradingBalanceQuote: Math.max(0, balance.availableQuote - savingsQuote),
      quotePriceUsd: balance.quotePriceUsd,
      deployedUsd: Math.max(0, deployedUsd),
      openPositionCount: openPositions.length,
      existingPositionForToken: tokenPosition !== null,
      readAtBlock: balance.blockOrSlot,
      readAt: balance.readAt,
    },
  };
}

export interface PnlSummary {
  realizedPnlQuote: number;
  realizedPnlUsd: number;
  unrealizedPnlQuote: number;
  unrealizedPnlUsd: number;
  openPositions: number;
  closedPositions: number;
  winRate: number | null;
  totalFeesQuote: number;
  since: Date;
}

/**
 * Running P&L for the Telegram "Total P&L" line and the dashboard.
 *
 * Measured from `pnlResetAt`, the operator's chosen baseline, and derived
 * entirely from confirmed trades. Unrealised P&L uses the last real price mark
 * the monitor recorded, with the mark time exposed so the UI can show staleness.
 */
export async function getPnlSummary(since: Date, userId?: string): Promise<PnlSummary> {
  const owner = userId ? { userId } : {};
  const [closed, open] = await Promise.all([
    prisma.position.findMany({
      where: { ...owner, status: PositionStatus.CLOSED, closedAt: { gte: since } },
      select: { realizedPnlQuote: true, realizedPnlUsd: true, feesQuote: true },
    }),
    prisma.position.findMany({
      where: {
        ...owner,
        status: { in: [PositionStatus.OPEN, PositionStatus.PARTIALLY_CLOSED] },
      },
      select: {
        unrealizedPnlQuote: true,
        unrealizedPnlUsd: true,
        realizedPnlQuote: true,
        realizedPnlUsd: true,
        feesQuote: true,
      },
    }),
  ]);

  const realizedPnlQuote =
    closed.reduce((s, p) => s + Number(p.realizedPnlQuote), 0) +
    open.reduce((s, p) => s + Number(p.realizedPnlQuote), 0);
  const realizedPnlUsd =
    closed.reduce((s, p) => s + Number(p.realizedPnlUsd), 0) +
    open.reduce((s, p) => s + Number(p.realizedPnlUsd), 0);

  const wins = closed.filter((p) => Number(p.realizedPnlQuote) > 0).length;

  return {
    realizedPnlQuote,
    realizedPnlUsd,
    unrealizedPnlQuote: open.reduce((s, p) => s + Number(p.unrealizedPnlQuote ?? 0), 0),
    unrealizedPnlUsd: open.reduce((s, p) => s + Number(p.unrealizedPnlUsd ?? 0), 0),
    openPositions: open.length,
    closedPositions: closed.length,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : null,
    totalFeesQuote:
      closed.reduce((s, p) => s + Number(p.feesQuote), 0) +
      open.reduce((s, p) => s + Number(p.feesQuote), 0),
    since,
  };
}

export { LIVE_POSITION_STATUSES };
export function logPortfolio(state: PortfolioState): void {
  log.debug(
    {
      tradingBalanceQuote: state.tradingBalanceQuote,
      quotePriceUsd: state.quotePriceUsd,
      deployedUsd: state.deployedUsd,
      openPositionCount: state.openPositionCount,
      readAtBlock: state.readAtBlock?.toString() ?? null,
    },
    'Portfolio state read from chain',
  );
}
