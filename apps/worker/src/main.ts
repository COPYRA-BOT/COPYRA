import { initSentry, logger, monitorOpenPositions, reconcilePendingTrades, telegram } from '@copyra/core';
import { prisma, type Prisma } from '@copyra/db';
import { startEvmMonitor } from './evm-monitor.js';
import { startSolanaMonitor } from './solana-monitor.js';

initSentry('copyra-worker');

async function heartbeat(status: string, detail: Record<string, unknown> = {}): Promise<void> {
  await prisma.workerHeartbeat.upsert({
    where: { name: 'copyra-worker' },
    create: { name: 'copyra-worker', status, detail: detail as Prisma.InputJsonValue, beatAt: new Date() },
    update: { status, detail: detail as Prisma.InputJsonValue, beatAt: new Date() },
  });
}

const stopSolana = await startSolanaMonitor();
const stopEvm = await startEvmMonitor();
await heartbeat('running', { monitor: 'solana-logs+evm-transfers+exits-fast' });
logger.info({}, 'COPYRA worker started. Solana logs, fast EVM polls, and sub-second TP/SL marks are live');

telegram.send(
  '✅ <b>AUTO REDEPLOY FINISHED</b>\nWorker is live again. Solana log subscriptions, fast EVM transfer polls, and TP/SL marks (250ms tick) are active. Closing the dashboard does not stop this process.',
  { kind: 'redeploy-finished' },
);

/** TP/SL / trailing marks — sub-second so exits stay inside the 1s budget. */
const EXIT_TICK_MS = 250;
/** Heartbeat + pending-tx reconcile (not on the buy/exit critical path). */
const MAINT_TICK_MS = 8_000;

const exitTimer = setInterval(() => {
  void monitorOpenPositions().catch((error: unknown) => {
    logger.error({ err: error }, 'Exit monitor tick failed');
  });
}, EXIT_TICK_MS);

const maintTimer = setInterval(() => {
  void heartbeat('running', { monitor: 'solana+evm+exits', pid: process.pid, exitTickMs: EXIT_TICK_MS }).catch(
    (error: unknown) => {
      logger.error({ err: error }, 'Heartbeat failed');
    },
  );
  void reconcilePendingTrades().catch((error: unknown) => {
    logger.error({ err: error }, 'Reconcile tick failed');
  });
}, MAINT_TICK_MS);

// First exit pass immediately so open positions are not waiting a full interval after boot.
void monitorOpenPositions().catch((error: unknown) => {
  logger.error({ err: error }, 'Exit monitor initial tick failed');
});

const shutdown = async () => {
  clearInterval(exitTimer);
  clearInterval(maintTimer);
  stopSolana();
  stopEvm();
  await heartbeat('stopped', {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
