import {
  alertOps,
  initSentry,
  logger,
  monitorOpenPositions,
  reconcilePendingTrades,
  telegram,
} from '@copyra/core';
import { prisma, type Prisma } from '@copyra/db';
import { workerActivity, writeWorkerStatusFile } from './activity.js';
import { startEvmMonitor } from './evm-monitor.js';
import { solanaMonitorStats, startSolanaMonitor } from './solana-monitor.js';

initSentry('copyra-worker');

/** If Solana sync or EVM ticks go silent this long, exit so the 24/7 supervisor respawns us.
 *  5 min matches ops-watch — tighter windows were killing the worker during RPC/pool blips
 *  and DO rolling deploys (two containers briefly share the DB). */
const WATCHDOG_SILENCE_MS = 5 * 60_000;
const WATCHDOG_CHECK_MS = 30_000;
/** Quiet-market notice only — never respawn solely because no trades were processed. */
const QUIET_MARKET_MS = 45 * 60_000;
const EXIT_TICK_MS = 250;
let lastQuietNoticeAt = 0;

function beatDetail(): Record<string, unknown> {
  return {
    monitor: 'solana+evm+exits',
    pid: process.pid,
    exitTickMs: EXIT_TICK_MS,
    alwaysOn: true,
    lastSolanaSyncAt: workerActivity.lastSolanaSyncAt || null,
    lastSolanaProcessedAt: workerActivity.lastSolanaProcessedAt || null,
    lastSolanaWsEventAt: workerActivity.lastSolanaWsEventAt || null,
    lastSolanaSlot: workerActivity.lastSolanaSlot || null,
    lastEvmTickAt: workerActivity.lastEvmTickAt || null,
    lastEvmProcessedAt: workerActivity.lastEvmProcessedAt || null,
    ...solanaMonitorStats,
  };
}

async function heartbeat(status: string, detail: Record<string, unknown> = {}): Promise<void> {
  // Short retries — a frozen beatAt makes ops-watch page "worker down" even when
  // monitors are alive (pool blips during Solana catch-up).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.workerHeartbeat.upsert({
        where: { name: 'copyra-worker' },
        create: {
          name: 'copyra-worker',
          status,
          detail: detail as Prisma.InputJsonValue,
          beatAt: new Date(),
        },
        update: { status, detail: detail as Prisma.InputJsonValue, beatAt: new Date() },
      });
      writeWorkerStatusFile({ status, ...detail });
      return;
    } catch (error) {
      lastErr = error;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fatalExit(kind: string, detail: string, code = 1): Promise<never> {
  try {
    await heartbeat('stopping', { ...beatDetail(), fatalKind: kind });
  } catch {
    /* ignore */
  }
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

/** Dedicated heartbeat — never share a timer with reconcile (that caused false "worker stale"). */
const HEARTBEAT_MS = 5_000;
/** Pending-tx reconcile (not on the buy/exit critical path). */
const MAINT_TICK_MS = 8_000;

/** Never overlap exit ticks — 250ms interval + slow marks was stacking pool waits. */
let exitInFlight = false;
const exitTimer = setInterval(() => {
  if (exitInFlight) return;
  exitInFlight = true;
  void monitorOpenPositions()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Exit monitor tick failed');
    })
    .finally(() => {
      exitInFlight = false;
    });
}, EXIT_TICK_MS);

/** Never overlap heartbeat upserts — stacked pool waits froze beatAt for minutes. */
let heartbeatInFlight = false;
const heartbeatTimer = setInterval(() => {
  if (heartbeatInFlight) return;
  heartbeatInFlight = true;
  void heartbeat('running', beatDetail())
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Heartbeat failed');
    })
    .finally(() => {
      heartbeatInFlight = false;
    });
}, HEARTBEAT_MS);

let maintInFlight = false;
const maintTimer = setInterval(() => {
  if (maintInFlight) return;
  maintInFlight = true;
  void reconcilePendingTrades()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Reconcile tick failed');
    })
    .finally(() => {
      maintInFlight = false;
    });
}, MAINT_TICK_MS);

/**
 * 24/7 watchdog: respawn only when the monitor LOOPS stall (sync/tick clocks).
 * Absence of buys/skips is NOT a stall — quiet markets stay up and keep listening.
 * Heartbeat alone is not enough — that kept ticking during the prior silent stall.
 */
const watchdogTimer = setInterval(() => {
  const now = Date.now();
  const solAge = workerActivity.lastSolanaSyncAt ? now - workerActivity.lastSolanaSyncAt : now;
  const evmAge = workerActivity.lastEvmTickAt ? now - workerActivity.lastEvmTickAt : now;
  const watching = solanaMonitorStats.watching;
  const processedAge = workerActivity.lastSolanaProcessedAt
    ? now - workerActivity.lastSolanaProcessedAt
    : null;
  const wsAge = workerActivity.lastSolanaWsEventAt
    ? now - workerActivity.lastSolanaWsEventAt
    : null;

  if (watching > 0 && solAge > WATCHDOG_SILENCE_MS) {
    logger.error(
      { solAgeMs: solAge, watching, stats: solanaMonitorStats, processedAge, wsAge },
      'Watchdog: Solana sync loop silent — exiting for 24/7 respawn',
    );
    void fatalExit(
      'worker-watchdog-solana',
      `Solana <b>sync loop silent ${Math.round(solAge / 1000)}s</b> while watching ${watching} traders` +
        `${wsAge != null ? ` · last WS event ${Math.round(wsAge / 1000)}s ago` : ' · no WS events yet'}` +
        `${processedAge != null ? ` · last processed ${Math.round(processedAge / 1000)}s ago` : ''}.` +
        `\nThis is a monitor stall (not "no trades"). Respawning copy-trade worker.`,
    );
    return;
  }

  if (evmAge > WATCHDOG_SILENCE_MS) {
    logger.error({ evmAgeMs: evmAge }, 'Watchdog: EVM poll loop silent — exiting for 24/7 respawn');
    void fatalExit(
      'worker-watchdog-evm',
      `EVM <b>poll loop silent ${Math.round(evmAge / 1000)}s</b>. Respawning copy-trade worker.`,
    );
    return;
  }

  // Quiet market notice — sync healthy, but nothing processed for a long time.
  if (
    watching > 0 &&
    solAge < 60_000 &&
    processedAge != null &&
    processedAge > QUIET_MARKET_MS &&
    now - lastQuietNoticeAt > QUIET_MARKET_MS
  ) {
    lastQuietNoticeAt = now;
    logger.warn(
      { processedAgeMs: processedAge, watching, wsAgeMs: wsAge },
      'Solana monitor healthy but quiet — no signatures processed recently',
    );
    void alertOps(
      'solana-quiet',
      `Solana monitor is <b>healthy</b> (sync ok, watching ${watching}) but <b>no signatures processed for ${Math.round(processedAge / 60000)}m</b>.\n` +
        `This usually means tracked wallets had no qualifying activity — not a stalled worker.\n` +
        `Catch-up ok/err: ${solanaMonitorStats.catchUpOk}/${solanaMonitorStats.catchUpErr}.`,
      { cooldownSec: QUIET_MARKET_MS / 1000 },
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
