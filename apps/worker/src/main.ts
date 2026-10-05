import { initSentry, logger, telegram } from '@copyra/core';
import { prisma } from '@copyra/db';
import { startSolanaMonitor } from './solana-monitor.js';

initSentry('copyra-worker');

async function heartbeat(status: string, detail: Record<string, unknown> = {}): Promise<void> {
  await prisma.workerHeartbeat.upsert({
    where: { name: 'copyra-worker' },
    create: { name: 'copyra-worker', status, detail, beatAt: new Date() },
    update: { status, detail, beatAt: new Date() },
  });
}

const stopMonitor = await startSolanaMonitor();
await heartbeat('running', { monitor: 'solana-logs' });
logger.info({}, 'COPYRA worker started — Solana log subscriptions are live');

telegram.send(
  '🟢 <b>WORKER ONLINE</b>\nSolana trader-wallet subscriptions are active. The dashboard being closed does not stop this process.',
  { kind: 'worker-online' },
);

const timer = setInterval(() => {
  void heartbeat('running', { monitor: 'solana-logs', pid: process.pid }).catch((error: unknown) => {
    logger.error({ err: error }, 'Heartbeat failed');
  });
}, 15_000);

const shutdown = async () => {
  clearInterval(timer);
  stopMonitor();
  await heartbeat('stopped', {});
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
