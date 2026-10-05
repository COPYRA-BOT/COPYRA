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
await heartbeat('running', { monitor: 'solana-logs+evm-transfers+exits' });
logger.info({}, 'COPYRA worker started — Solana logs, EVM polls, and exit marks are live');

telegram.send(
  '🟢 <b>WORKER ONLINE</b>\nSolana log subscriptions, Base/Arb/BNB transfer polls, and TP/SL marks are active. Closing the dashboard does not stop this process.',
  { kind: 'worker-online' },
);

const timer = setInterval(() => {
  void heartbeat('running', { monitor: 'solana+evm+exits', pid: process.pid }).catch((error: unknown) => {
    logger.error({ err: error }, 'Heartbeat failed');
  });
  void monitorOpenPositions().catch((error: unknown) => {
    logger.error({ err: error }, 'Exit monitor tick failed');
  });
  void reconcilePendingTrades().catch((error: unknown) => {
    logger.error({ err: error }, 'Reconcile tick failed');
  });
}, 8_000);

const shutdown = async () => {
  clearInterval(timer);
  stopSolana();
  stopEvm();
  await heartbeat('stopped', {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
