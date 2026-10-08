import { Chain, prisma, PositionStatus, SignalStatus, TradeSide, TxStatus } from '@copyra/db';
import { confirmEvmTransaction } from '../evm/executor.js';
import { componentLogger } from '../obs/logger.js';
import { reportError } from '../obs/sentry.js';
import { confirmSolanaTransaction } from '../solana/executor.js';

const log = componentLogger('reconcile');

/** BUILDING with no broadcast this long is abandoned — reopen CLOSING books for retry. */
const STALE_BUILDING_MS = 3 * 60_000;

/**
 * Re-reads chain state for trades that left the executor without a verdict.
 * Never promotes a trade to CONFIRMED without a real RPC confirmation.
 */
export async function reconcilePendingTrades(): Promise<number> {
  const pending = await prisma.trade.findMany({
    where: { status: { in: [TxStatus.BROADCAST, TxStatus.LANDED, TxStatus.UNKNOWN] } },
    take: 40,
    orderBy: { createdAt: 'asc' },
  });

  let resolved = 0;
  for (const trade of pending) {
    if (!trade.txHash) continue;
    try {
      const confirmation =
        trade.chain === Chain.SOLANA
          ? await confirmSolanaTransaction(
              trade.txHash,
              Number(trade.lastValidBlockHeight ?? 0),
              8_000,
            )
          : await confirmEvmTransaction(trade.chain, trade.txHash as `0x${string}`, 8_000, 1);

      if (confirmation.status === TxStatus.UNKNOWN) continue;

      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: confirmation.status,
          confirmedAt: confirmation.status === TxStatus.CONFIRMED ? new Date() : trade.confirmedAt,
          failedAt: confirmation.status === TxStatus.CONFIRMED ? null : new Date(),
          confirmations: confirmation.confirmations,
          errorMessage: confirmation.error,
        },
      });

      if (trade.positionId && confirmation.status === TxStatus.FAILED) {
        await prisma.position.updateMany({
          where: { id: trade.positionId, status: PositionStatus.PENDING_OPEN },
          data: { status: PositionStatus.OPEN_FAILED },
        });
        if (trade.signalId) {
          await prisma.signal.update({
            where: { id: trade.signalId },
            data: { status: SignalStatus.FAILED },
          });
        }
      }

      resolved += 1;
      log.info({ tradeId: trade.id, status: confirmation.status, txHash: trade.txHash }, 'Reconciled trade from chain');
    } catch (error) {
      await reportError(error, {
        component: 'reconcile',
        code: 'RECONCILE_FAILED',
        chain: trade.chain,
        notify: false,
        context: { tradeId: trade.id, txHash: trade.txHash },
      });
    }
  }

  // Stuck exits: position CLOSING + trade BUILDING with no txHash (executor died mid-swap).
  // Fail the trade and reopen the book so the 250ms exit tick can sell again.
  const staleBuilding = await prisma.trade.findMany({
    where: {
      status: TxStatus.BUILDING,
      createdAt: { lt: new Date(Date.now() - STALE_BUILDING_MS) },
    },
    take: 20,
    orderBy: { createdAt: 'asc' },
  });
  for (const trade of staleBuilding) {
    try {
      await prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: TxStatus.FAILED,
          errorCode: 'STALE_BUILDING',
          errorMessage:
            'Trade stuck in BUILDING without a broadcast; marked failed so the exit monitor can retry.',
          failedAt: new Date(),
        },
      });
      if (trade.positionId && trade.side === TradeSide.SELL) {
        await prisma.position.updateMany({
          where: { id: trade.positionId, status: PositionStatus.CLOSING },
          data: { status: PositionStatus.OPEN },
        });
      } else if (trade.positionId && trade.side === TradeSide.BUY) {
        await prisma.position.updateMany({
          where: { id: trade.positionId, status: PositionStatus.PENDING_OPEN },
          data: { status: PositionStatus.OPEN_FAILED },
        });
      }
      resolved += 1;
      log.warn({ tradeId: trade.id, positionId: trade.positionId }, 'Reconciled stale BUILDING trade');
    } catch (error) {
      await reportError(error, {
        component: 'reconcile',
        code: 'RECONCILE_STALE_BUILDING_FAILED',
        chain: trade.chain,
        notify: false,
        context: { tradeId: trade.id },
      });
    }
  }

  return resolved;
}
