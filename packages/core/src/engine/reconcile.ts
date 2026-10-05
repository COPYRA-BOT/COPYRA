import { Chain, prisma, PositionStatus, SignalStatus, TxStatus } from '@copyra/db';
import { confirmEvmTransaction } from '../evm/executor.js';
import { componentLogger } from '../obs/logger.js';
import { reportError } from '../obs/sentry.js';
import { confirmSolanaTransaction } from '../solana/executor.js';

const log = componentLogger('reconcile');

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
  return resolved;
}
