import {
  alertOps,
  initSentry,
  logger,
  monitorOpenPositions,
  reconcilePendingTrades,
  telegram,
} from '@copyra/core';
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

async function fatalExit(kind: string, detail: string, code = 1): Promise<never> {
  try {
    await alertOps(kind, detail, { awaitDelivery: true, cooldownSec: 5 * 60 });
  } catch {
    /* never block exit on telegram */
  }
  process.exit(code);
}

// Prevent the process from being considered idle by the runtime; copy trading is always on.
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception in worker — exiting for supervisor restart');
  void fatalExit(
    'worker-crash',
    `Worker <b>uncaught exception</b> — auto-respawning.\n${String(error instanceof Error ? error.message : error).slice(0, 280)}`,
  );
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection in worker — exiting for supervisor restart');
  void fatalExit(
    'worker-crash',
    `Worker <b>unhandled rejection</b> — auto-respawning.\n${String(reason instanceof Error ? reason.message : reason).slice(0, 280)}`,
  );
});

const stopSolana = await startSolanaMonitor();
const stopEvm = await startEvmMonitor();
workerActivity.lastSolanaSyncAt = Date.now();
workerActivity.lastEvmTickAt = Date.now();

// Only notify after a real cold start / deploy — not every supervisor respawn.
// Recent heartbeat means this is a crash-loop restart (or DO health flap), not a push.
const priorBeat = await prisma.workerHeartbeat.findUnique({ where: { name: 'copyra-worker' } });
const priorAgeMs = priorBeat?.beatAt ? Date.now() - priorBeat.beatAt.getTime() : Number.POSITIVE_INFINITY;
const isColdStart = !priorBeat || priorAgeMs > 5 * 60_000;

await heartbeat('running', {
  monitor: 'solana-logs+evm-transfers+exits-fast',
  pid: process.pid,
  alwaysOn: true,
});
logger.info({ isColdStart, priorAgeMs }, 'COPYRA worker started 24/7. Solana logs, EVM polls, TP/SL, stall watchdog live');

if (isColdStart) {
  telegram.send(
    '✅ <b>WORKER ONLINE</b>\nCopy-trade worker is live after deploy. Solana + EVM monitors and TP/SL watchdog are active.',
    { kind: 'worker-online' },
  );
}

/** TP/SL / trailing marks — sub-second so exits stay inside the 1s budget. */
const EXIT_TICK_MS = 250;
/** Dedicated heartbeat — never share a timer with reconcile (that caused false "worker stale"). */
const HEARTBEAT_MS = 5_000;
/** Pending-tx reconcile (not on the buy/exit critical path). */
const MAINT_TICK_MS = 8_000;

function beatDetail(): Record<string, unknown> {
  return {
    monitor: 'solana+evm+exits',
    pid: process.pid,
    exitTickMs: EXIT_TICK_MS,
    alwaysOn: true,
    lastSolanaSyncAt: workerActivity.lastSolanaSyncAt || null,
    lastSolanaProcessedAt: workerActivity.lastSolanaProcessedAt || null,
    lastEvmTickAt: workerActivity.lastEvmTickAt || null,
    lastEvmProcessedAt: workerActivity.lastEvmProcessedAt || null,
    ...solanaMonitorStats,
  };
}

const exitTimer = setInterval(() => {
  void monitorOpenPositions().catch((error: unknown) => {
    logger.error({ err: error }, 'Exit monitor tick failed');
  });
}, EXIT_TICK_MS);

const heartbeatTimer = setInterval(() => {
  void heartbeat('running', beatDetail()).catch((error: unknown) => {
    logger.error({ err: error }, 'Heartbeat failed');
  });
}, HEARTBEAT_MS);

const maintTimer = setInterval(() => {
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
    void fatalExit(
      'worker-watchdog-solana',
      `Solana monitor <b>silent ${Math.round(solAge / 1000)}s</b> while watching ${watching} traders. Respawning copy-trade worker.`,
    );
    return;
  }

  if (evmAge > WATCHDOG_SILENCE_MS) {
    logger.error({ evmAgeMs: evmAge }, 'Watchdog: EVM monitor silent — exiting for 24/7 respawn');
    void fatalExit(
      'worker-watchdog-evm',
      `EVM monitor <b>silent ${Math.round(evmAge / 1000)}s</b>. Respawning copy-trade worker.`,
    );
  }
}, WATCHDOG_CHECK_MS);

// First exit pass immediately so open positions are not waiting a full interval after boot.
void monitorOpenPositions().catch((error: unknown) => {
  logger.error({ err: error }, 'Exit monitor initial tick failed');
});

const shutdown = async () => {
  clearInterval(exitTimer);
  clearInterval(heartbeatTimer);
  clearInterval(maintTimer);
  clearInterval(watchdogTimer);
  stopSolana();
  stopEvm();
  // Graceful SIGTERM is normal on DO deploy — do not page the operator.
  // Crash / watchdog still alert via fatalExit → alertOps.
  await heartbeat('stopped', { alwaysOn: false });
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
