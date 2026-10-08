import { initSentry, logger, monitorOpenPositions, reconcilePendingTrades, telegram } from '@copyra/core';
import { prisma, type Prisma } from '@copyra/db';
import { workerActivity } from './activity.js';
import { startEvmMonitor } from './evm-monitor.js';
import { solanaMonitorStats, startSolanaMonitor } from './solana-monitor.js';

initSentry('copyra-worker');

/** If Solana sync or EVM ticks go silent this long, exit so the 24/7 supervisor respawns us. */
const WATCHDOG_SILENCE_MS = 3 * 60_000;
const WATCHDOG_CHECK_MS = 30_000;

async function heartbeat(status: string, detail: Record<string, unknown> = {}): Promise<void> {
  await prisma.workerHeartbeat.upsert({
    where: { name: 'copyra-worker' },
    create: { name: 'copyra-worker', status, detail: detail as Prisma.InputJsonValue, beatAt: new Date() },
    update: { status, detail: detail as Prisma.InputJsonValue, beatAt: new Date() },
  });
}

// Prevent the process from being considered idle by the runtime; copy trading is always on.
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception in worker — keeping process for supervisor restart');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection in worker — keeping process for supervisor restart');
  process.exit(1);
});

const stopSolana = await startSolanaMonitor();
const stopEvm = await startEvmMonitor();
workerActivity.lastSolanaSyncAt = Date.now();
workerActivity.lastEvmTickAt = Date.now();

await heartbeat('running', {
  monitor: 'solana-logs+evm-transfers+exits-fast',
  pid: process.pid,
  alwaysOn: true,
});
logger.info({}, 'COPYRA worker started 24/7. Solana logs, EVM polls, TP/SL marks, and stall watchdog are live');

telegram.send(
  '✅ <b>AUTO REDEPLOY FINISHED</b>\nWorker is live 24/7. Solana subscriptions, EVM polls, TP/SL (250ms), and a stall watchdog (auto-respawn) are active.',
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
  void heartbeat('running', {
    monitor: 'solana+evm+exits',
    pid: process.pid,
    exitTickMs: EXIT_TICK_MS,
    alwaysOn: true,
    lastSolanaSyncAt: workerActivity.lastSolanaSyncAt || null,
    lastSolanaProcessedAt: workerActivity.lastSolanaProcessedAt || null,
    lastEvmTickAt: workerActivity.lastEvmTickAt || null,
    lastEvmProcessedAt: workerActivity.lastEvmProcessedAt || null,
    ...solanaMonitorStats,
  }).catch((error: unknown) => {
    logger.error({ err: error }, 'Heartbeat failed');
  });
  void reconcilePendingTrades().catch((error: unknown) => {
    logger.error({ err: error }, 'Reconcile tick failed');
  });
}, MAINT_TICK_MS);

/**
 * 24/7 watchdog: if Solana sync or EVM poll loops stop updating, exit so
 * scripts/start-production.sh respawns a fresh worker. Heartbeat alone is not
 * enough — that kept ticking during the prior silent stall.
 */
const watchdogTimer = setInterval(() => {
  const now = Date.now();
  const solAge = workerActivity.lastSolanaSyncAt ? now - workerActivity.lastSolanaSyncAt : now;
  const evmAge = workerActivity.lastEvmTickAt ? now - workerActivity.lastEvmTickAt : now;
  const watching = solanaMonitorStats.watching;

  if (watching > 0 && solAge > WATCHDOG_SILENCE_MS) {
    logger.error(
      { solAgeMs: solAge, watching, stats: solanaMonitorStats },
      'Watchdog: Solana monitor silent — exiting for 24/7 respawn',
    );
    telegram.send(
      `⚠️ <b>WORKER WATCHDOG</b>\nSolana monitor silent ${Math.round(solAge / 1000)}s. Respawning copy-trade worker.`,
      { kind: 'worker-watchdog' },
    );
    process.exit(1);
  }

  if (evmAge > WATCHDOG_SILENCE_MS) {
    logger.error({ evmAgeMs: evmAge }, 'Watchdog: EVM monitor silent — exiting for 24/7 respawn');
    telegram.send(
      `⚠️ <b>WORKER WATCHDOG</b>\nEVM monitor silent ${Math.round(evmAge / 1000)}s. Respawning copy-trade worker.`,
      { kind: 'worker-watchdog' },
    );
    process.exit(1);
  }
}, WATCHDOG_CHECK_MS);

// First exit pass immediately so open positions are not waiting a full interval after boot.
void monitorOpenPositions().catch((error: unknown) => {
  logger.error({ err: error }, 'Exit monitor initial tick failed');
});

const shutdown = async () => {
  clearInterval(exitTimer);
  clearInterval(maintTimer);
  clearInterval(watchdogTimer);
  stopSolana();
  stopEvm();
  await heartbeat('stopped', { alwaysOn: false });
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
