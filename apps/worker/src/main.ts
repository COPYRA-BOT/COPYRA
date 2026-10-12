import {
  alertOps,
  env,
  initSentry,
  logger,
  monitorOpenPositions,
  reconcilePendingTrades,
  telegram,
} from '@copyra/core';
import { prisma, TradingStrategy, type Prisma } from '@copyra/db';
import { workerActivity, writeWorkerStatusFile } from './activity.js';
import { startEvmMonitor } from './evm-monitor.js';
import {
  requestSolanaForceResub,
  solanaMonitorStats,
  startSolanaMonitor,
} from './solana-monitor.js';

initSentry('copyra-worker');

/**
 * Watchdog silence window. Prefer in-process soft recovery; only process.exit
 * after consecutive dead checks so DO does not mark "Containers repeatedly crashing".
 */
const WATCHDOG_SILENCE_MS = 8 * 60_000;
const WATCHDOG_CHECK_MS = 30_000;
/** Require this many consecutive dead checks before fatalExit. */
const WATCHDOG_DEAD_STREAK = 3;
/** Quiet-market notice only — never respawn solely because no trades were processed. */
const QUIET_MARKET_MS = 45 * 60_000;
/**
 * Exit mark interval. 250ms + Dex/Jupiter on basic-xs pegged CPU and starved
 * heartbeats; 750ms still reacts to SL well within meme wick windows.
 */
const EXIT_TICK_MS = 750;
let lastQuietNoticeAt = 0;
let solDeadStreak = 0;
let evmDeadStreak = 0;

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
    solDeadStreak,
    evmDeadStreak,
    ...solanaMonitorStats,
  };
}

async function heartbeat(status: string, detail: Record<string, unknown> = {}): Promise<void> {
  // Short retries — a frozen beatAt makes ops-watch page "worker down" even when
  // monitors are alive (pool blips during Solana catch-up).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // During DO rolling deploys two worker containers briefly share one row.
      // Never let a stuck/old instance overwrite a peer with a fresher sync clock
      // (that was flipping status between healthy pid and syncAge=37h → Degraded).
      if (status === 'running') {
        const existing = await prisma.workerHeartbeat.findUnique({
          where: { name: 'copyra-worker' },
        });
        const prior =
          existing?.detail && typeof existing.detail === 'object' && !Array.isArray(existing.detail)
            ? (existing.detail as Record<string, unknown>)
            : {};
        const priorSync = Number(prior.lastSolanaSyncAt ?? 0);
        const ourSync = Number(detail.lastSolanaSyncAt ?? workerActivity.lastSolanaSyncAt ?? 0);
        const priorPid = Number(prior.pid ?? 0);
        const ourPid = Number(detail.pid ?? process.pid);
        const peerFresh =
          existing?.status === 'running' &&
          existing.beatAt &&
          Date.now() - existing.beatAt.getTime() < 30_000;
        if (
          peerFresh &&
          priorPid > 0 &&
          priorPid !== ourPid &&
          priorSync > ourSync + 30_000
        ) {
          writeWorkerStatusFile({ status, ...detail, heartbeatDeferred: true });
          return;
        }
      }

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

// Log hard failures but do not exit on every unhandledRejection — Prisma/RPC
// blips were crash-looping the container (DO "Containers repeatedly crashing").
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception in worker — exiting for supervisor restart');
  void fatalExit(
    'worker-crash',
    `Worker <b>uncaught exception</b> — auto-respawning.\n${String(error instanceof Error ? error.message : error).slice(0, 280)}`,
  );
});
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason },
    'Unhandled rejection in worker — continuing (supervisor will respawn only on hard crash)',
  );
});

if (!env.SOLANA_WS_URL && !env.SOLANA_BACKUP_WS_URL) {
  logger.error({}, 'SOLANA_WS_URL missing — copy detection will be blind');
  void alertOps(
    'solana-ws-missing',
    'Copy-trade worker started <b>without SOLANA_WS_URL</b>.\n' +
      'Set App-Level encrypted <code>SOLANA_WS_URL</code> (and optional backup) scoped to ALL components, then Force rebuild <b>worker</b>.',
    { awaitDelivery: true },
  );
}

const stopSolana = await startSolanaMonitor();
const stopEvm = await startEvmMonitor();
workerActivity.lastSolanaSyncAt = Date.now();
workerActivity.lastEvmTickAt = Date.now();

// Only notify after a real cold start / deploy — not every supervisor respawn.
// Recent heartbeat means this is a crash-loop restart (or DO health flap), not a push.
const priorBeat = await prisma.workerHeartbeat.findUnique({ where: { name: 'copyra-worker' } });
const priorAgeMs = priorBeat?.beatAt ? Date.now() - priorBeat.beatAt.getTime() : Number.POSITIVE_INFINITY;
const isColdStart = !priorBeat || priorAgeMs > 5 * 60_000;

// Take over heartbeat from a zombie peer (stuck sync for hours) immediately.
await heartbeat('running', {
  monitor: 'solana-logs+evm-transfers+exits-fast',
  pid: process.pid,
  alwaysOn: true,
  ...beatDetail(),
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

/** Never overlap exit ticks — slow marks must not stack pool waits. */
let exitInFlight = false;
const exitTimer = setInterval(() => {
  if (exitInFlight) return;
  exitInFlight = true;
  // COPY strategy only — sniper exits run on the dedicated sniper worker.
  void monitorOpenPositions({ strategy: TradingStrategy.COPY })
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
 * Soft-recover first; fatalExit only after consecutive dead checks.
 * Avoids DO "Containers repeatedly crashing" from single RPC blips.
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

  const syncStale = solAge > WATCHDOG_SILENCE_MS;
  const wsStale = wsAge == null || wsAge > WATCHDOG_SILENCE_MS;
  const processedStale = processedAge == null || processedAge > WATCHDOG_SILENCE_MS;
  // Never-fired WS while watching is a dead monitor even if sync keeps ticking
  // (sync alone used to hide copy blindness for hours with no Telegram alert).
  const wsNeverFired =
    watching > 0 && workerActivity.lastSolanaWsEventAt === 0 && solAge > 2 * 60_000;
  const solDead =
    watching > 0 && ((syncStale && wsStale && processedStale) || (wsNeverFired && wsStale));

  if (solDead || wsNeverFired) {
    solDeadStreak += 1;
    // Soft recover: force WS resub only — do not invent a sync clock or the
    // dead-streak never accumulates and DO never gets a clean respawn.
    requestSolanaForceResub(
      wsNeverFired ? `watchdog-ws-never-${solDeadStreak}` : `watchdog-dead-streak-${solDeadStreak}`,
    );
    logger.error(
      { solAgeMs: solAge, watching, stats: solanaMonitorStats, processedAge, wsAge, solDeadStreak, wsNeverFired },
      'Watchdog: Solana monitor looks dead — soft recovery (force resub on next sync)',
    );
    if (solDeadStreak === 1 || solDeadStreak % 3 === 0) {
      void alertOps(
        'solana-ws-blind',
        `Copy-trade Solana WS is <b>blind</b> while watching ${watching} traders.\n` +
          `${wsAge != null ? `Last WS event ${Math.round(wsAge / 1000)}s ago` : 'No WS events since boot'}` +
          `${processedAge != null ? ` · last processed ${Math.round(processedAge / 1000)}s ago` : ' · nothing processed'}.\n` +
          `Soft recovery #${solDeadStreak}. Check SOLANA_WS_URL on the <b>worker</b> component.`,
        { cooldownSec: 10 * 60 },
      );
    }
    if (solDeadStreak >= WATCHDOG_DEAD_STREAK) {
      void fatalExit(
        'worker-watchdog-solana',
        `Solana <b>monitor silent</b> after ${solDeadStreak} checks while watching ${watching} traders` +
          `${wsAge != null ? ` · last WS event ${Math.round(wsAge / 1000)}s ago` : ' · no WS events yet'}` +
          `${processedAge != null ? ` · last processed ${Math.round(processedAge / 1000)}s ago` : ''}.` +
          `\nSoft recovery failed. Respawning copy-trade worker.`,
      );
      return;
    }
  } else {
    solDeadStreak = 0;
  }

  if (watching > 0 && syncStale && !(wsStale && processedStale)) {
    // Keep sync clock alive from WS so false "sync silent" pages stop.
    workerActivity.lastSolanaSyncAt = Date.now();
    requestSolanaForceResub('sync-stale-ws-live');
    logger.warn(
      { solAgeMs: solAge, wsAgeMs: wsAge, processedAgeMs: processedAge, watching },
      'Solana sync clock stale but WS/processed still live — refreshed sync clock + force resub',
    );
  }

  if (evmAge > WATCHDOG_SILENCE_MS) {
    evmDeadStreak += 1;
    logger.error(
      { evmAgeMs: evmAge, evmDeadStreak },
      'Watchdog: EVM poll looks silent — waiting for tick timeout/recovery before respawn',
    );
    if (evmDeadStreak >= WATCHDOG_DEAD_STREAK) {
      void fatalExit(
        'worker-watchdog-evm',
        `EVM <b>poll loop silent</b> after ${evmDeadStreak} checks. Respawning copy-trade worker.`,
      );
      return;
    }
  } else {
    evmDeadStreak = 0;
  }

  // Quiet market notice — sync healthy, but nothing processed for a long time.
  // Also page when watching > 0 but NOTHING has ever been processed (WS blind).
  const neverProcessed = watching > 0 && processedAge == null && solAge > QUIET_MARKET_MS;
  if (
    watching > 0 &&
    solAge < 60_000 &&
    ((processedAge != null && processedAge > QUIET_MARKET_MS) || neverProcessed) &&
    now - lastQuietNoticeAt > QUIET_MARKET_MS
  ) {
    lastQuietNoticeAt = now;
    const ageLabel =
      processedAge != null
        ? `${Math.round(processedAge / 60000)}m`
        : 'never since boot';
    logger.warn(
      { processedAgeMs: processedAge, watching, wsAgeMs: wsAge, neverProcessed },
      'Solana monitor quiet — no signatures processed recently',
    );
    void alertOps(
      'solana-quiet',
      `Solana monitor watching ${watching} but <b>no signatures processed for ${ageLabel}</b>.\n` +
        `${wsAge == null ? '⚠️ No WS events since boot — check SOLANA_WS_URL.\n' : ''}` +
        `Catch-up ok/err: ${solanaMonitorStats.catchUpOk}/${solanaMonitorStats.catchUpErr}.`,
      { cooldownSec: QUIET_MARKET_MS / 1000 },
    );
  }
}, WATCHDOG_CHECK_MS);

// First exit pass immediately so open positions are not waiting a full interval after boot.
void monitorOpenPositions({ strategy: TradingStrategy.COPY }).catch((error: unknown) => {
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
