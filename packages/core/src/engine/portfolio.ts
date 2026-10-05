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
import { getNativeBalance } from '../evm/tokens.js';
import { getSpendableSol } from '../solana/executor.js';
import type { PortfolioState } from './types.js';

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
  quotePriceUsd: number;
  totalUsd: number;
  blockOrSlot: bigint;
  readAt: Date;
  address: string;
}

/**
 * Reads the quote-asset balance straight from the chain.
 *
 * Never returns a cached or database value: a sizing decision made against a
 * stale balance is how a bot over-commits and starts producing failed
 * transactions. The read block/slot is returned so staleness is measurable.
 */
export async function readOnChainBalance(chain: Chain): Promise<OnChainBalance> {
  const address = tradingWalletAddress(chain);
  if (!address) throw new NoTradingWalletError(chain);

  const config = chainConfig(chain);
  const quotePriceUsd = await getQuoteAssetPriceUsd(chain);

  if (config.kind === 'solana') {
    const { spendableSol, rawLamports, slot } = await getSpendableSol(address);
    const totalQuote = Number(rawLamports) / 1e9;
    return {
      availableQuote: spendableSol,
      totalQuote,
      quotePriceUsd,
      totalUsd: totalQuote * quotePriceUsd,
      blockOrSlot: slot,
      readAt: new Date(),
      address,
    };
  }

  const native = await getNativeBalance(chain, address);
  const totalQuote = Number(native.amountRaw) / 10 ** config.nativeDecimals;
  // Hold back gas. An EVM exit that cannot pay for itself is a trapped position.
  const gasReserve = 0.002;
  return {
    availableQuote: Math.max(0, totalQuote - gasReserve),
    totalQuote,
    quotePriceUsd,
    totalUsd: totalQuote * quotePriceUsd,
    blockOrSlot: native.blockNumber,
    readAt: new Date(),
    address,
  };
}

/** Persists a balance snapshot so the dashboard can show read-time and source. */
export async function snapshotBalance(
  chain: Chain,
  balance: OnChainBalance,
  bucket: BalanceBucket = BalanceBucket.TRADING,
): Promise<void> {
  const config = chainConfig(chain);
  const raw = BigInt(Math.round(balance.totalQuote * 10 ** config.nativeDecimals)).toString();
  await prisma.walletBalance.upsert({
    where: {
      chain_address_bucket_assetAddress: {
        chain,
        address: balance.address,
        bucket,
        assetAddress: config.quoteAsset || 'native',
      },
    },
    create: {
      chain,
      address: balance.address,
      bucket,
      assetAddress: config.quoteAsset || 'native',
      assetSymbol: config.nativeSymbol,
      decimals: config.nativeDecimals,
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
    },
  });
}

/**
 * Builds the portfolio state the sizing function needs.
 *
 * Balance comes from the chain; deployed capital and position counts come from
 * the database, because those are COPYRA's own bookkeeping of transactions it
 * confirmed on-chain. The reconciliation worker is what keeps the second set
 * honest against the first.
 */
export async function buildPortfolioState(
  chain: Chain,
  tokenAddress: string,
): Promise<{ state: PortfolioState; balance: OnChainBalance }> {
  const balance = await readOnChainBalance(chain);
  const { getSavingsQuote } = await import('./funds.js');
  const savingsQuote = await getSavingsQuote(chain).catch(() => 0);

  const [openPositions, tokenPosition] = await Promise.all([
    prisma.position.findMany({
      where: { status: { in: LIVE_POSITION_STATUSES } },
      select: { id: true, entryValueUsd: true, realizedPnlUsd: true, chain: true },
    }),
    prisma.position.findFirst({
      where: {
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
export async function getPnlSummary(since: Date): Promise<PnlSummary> {
  const [closed, open] = await Promise.all([
    prisma.position.findMany({
      where: { status: PositionStatus.CLOSED, closedAt: { gte: since } },
      select: { realizedPnlQuote: true, realizedPnlUsd: true, feesQuote: true },
    }),
    prisma.position.findMany({
      where: { status: { in: [PositionStatus.OPEN, PositionStatus.PARTIALLY_CLOSED] } },
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
