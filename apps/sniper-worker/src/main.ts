/**
 * COPYRA Sniper worker — independent of the wallet copy-trade worker.
 * Discovers Pump.fun / PumpSwap launches via Helius WS, qualifies fail-closed,
 * executes via shared Jupiter/signer, and monitors sniper-only exits.
 */
import { ensureSettings, env, initSentry, logger, monitorOpenPositions, telegram } from '@copyra/core';
import {
  getSniperDiscoveryStats,
  handleSniperDiscovery,
  SNIPER_HEARTBEAT_NAME,
  startPumpFunDiscovery,
} from '@copyra/core/sniper';
import { prisma, TradingStrategy, type Prisma } from '@copyra/db';
import { writeFileSync } from 'node:fs';

initSentry('sniper-worker');

const EXIT_MS = 1_000;
const HEARTBEAT_MS = 5_000;

let exitInFlight = false;
let discoveryStop: (() => void) | null = null;
let lastDiscoveryAt: string | null = null;
let discoveryCount = 0;
let bootError: string | null = null;

function writeStatus(extra: Record<string, unknown> = {}): void {
  try {
    writeFileSync(
      '/tmp/copyra-sniper-status.json',
      JSON.stringify({
        at: new Date().toISOString(),
        name: SNIPER_HEARTBEAT_NAME,
        sniperEnabled: env.SNIPER_ENABLED,
        sniperMode: env.SNIPER_MODE,
        lastDiscoveryAt,
        discoveryCount,
        bootError,
        ...extra,
      }),
    );
  } catch {
    /* ignore */
  }
}

async function beat(status: string, detail: Prisma.InputJsonValue): Promise<void> {
  // Disk first — supervisor stale-kill must see life even when Prisma is slow.
  writeStatus({ status, detail });
  try {
    await prisma.workerHeartbeat.upsert({
      where: { name: SNIPER_HEARTBEAT_NAME },
      create: { name: SNIPER_HEARTBEAT_NAME, status, detail },
      update: { status, detail, beatAt: new Date() },
    });
  } catch (error) {
    logger.warn({ err: error }, 'Sniper heartbeat write failed');
  }
}

function beatDetail(extra: Record<string, unknown> = {}): Prisma.InputJsonValue {
  const stats = getSniperDiscoveryStats();
  const primary = env.SOLANA_WS_URL;
  const backup = env.SOLANA_BACKUP_WS_URL;
  let primaryHost: string | null = null;
  let backupHost: string | null = null;
  try {
    if (primary) primaryHost = new URL(primary).host;
  } catch {
    primaryHost = 'invalid';
  }
  try {
    if (backup) backupHost = new URL(backup).host;
  } catch {
    backupHost = 'invalid';
  }
  const backupDistinct = Boolean(backup && primary && backup !== primary);
  return {
    monitor: 'sniper+exits',
    sniperEnabled: env.SNIPER_ENABLED,
    sniperMode: env.SNIPER_MODE,
    lastSolanaSyncAt: Date.now(),
    lastDiscoveryAt,
    discoveryCount,
    wsConnected: stats.wsConnected,
    wsNotifications: stats.wsNotifications,
    decodeOk: stats.decodeOk,
    decodeFail: stats.decodeFail,
    subs: stats.subs,
    wsUrlHost: stats.wsUrlHost,
    lastNotificationAt: stats.lastNotificationAt,
    reconnects: stats.reconnects,
    hasSolanaRpc: Boolean(env.SOLANA_RPC_URL),
    hasSolanaWs: Boolean(primary || backup),
    hasBackupWs: Boolean(backup),
    backupDistinct,
    primaryWsHost: primaryHost,
    backupWsHost: backupHost,
    bootError,
    pid: process.pid,
    ...extra,
  } as Prisma.InputJsonValue;
}

logger.info(
  {
    sniperEnabled: env.SNIPER_ENABLED,
    sniperMode: env.SNIPER_MODE,
    pumpFun: env.PUMP_FUN_PROGRAM_ID,
  },
  'COPYRA sniper worker starting',
);

// Only notify after a real cold start / deploy — not every supervisor respawn.
// Read prior beat BEFORE writing heartbeats so a crash-loop restart stays quiet.
const priorBeat = await prisma.workerHeartbeat.findUnique({
  where: { name: SNIPER_HEARTBEAT_NAME },
});
const priorAgeMs = priorBeat?.beatAt
  ? Date.now() - priorBeat.beatAt.getTime()
  : Number.POSITIVE_INFINITY;
const isColdStart = !priorBeat || priorAgeMs > 5 * 60_000;

// Heartbeat before heavier boot work so /api/status shows the component immediately.
void beat('starting', beatDetail({ boot: true }));

try {
  await ensureSettings();
} catch (error) {
  bootError = error instanceof Error ? error.message : String(error);
  logger.error({ err: error }, 'Sniper ensureSettings failed — continuing with host env only');
}

if (env.PLATFORM_PAUSED) {
  logger.warn({}, 'PLATFORM_PAUSED — sniper discovery and exits are idle');
} else if (!env.SNIPER_ENABLED) {
  logger.warn(
    {},
    'SNIPER_ENABLED is false — discovery still listens when engines are ON, but host will reject buys',
  );
}

if (!env.PLATFORM_PAUSED && !env.SOLANA_WS_URL && !env.SOLANA_BACKUP_WS_URL) {
  logger.error(
    {},
    'Sniper has no Solana WS (and could not derive from SOLANA_RPC_URL) — discovery will idle',
  );
} else if (!env.PLATFORM_PAUSED) {
  logger.info(
    {
      hasWs: Boolean(env.SOLANA_WS_URL),
      hasBackupWs: Boolean(env.SOLANA_BACKUP_WS_URL),
      derivedFromRpc: Boolean(env.SOLANA_RPC_URL && env.SOLANA_WS_URL),
      preferBackup: Boolean(env.SOLANA_BACKUP_WS_URL),
    },
    'Sniper Solana WS endpoint available',
  );
  if (env.SNIPER_ENABLED && !env.SOLANA_BACKUP_WS_URL) {
    logger.warn(
      {},
      'SNIPER_ENABLED without SOLANA_BACKUP_WS_URL — Pump.fun flood shares the copy-trade primary WSS and can blind detection',
    );
    telegram.send(
      '⚠️ <b>SNIPER SHARES COPY WS</b>\n' +
        'Set App-Level <code>SOLANA_BACKUP_WS_URL</code> (<b>wss://</b>, separate provider/key) so sniper does not starve copy-trade <code>SOLANA_WS_URL</code>.',
      { kind: 'sniper-ws-shared' },
    );
  }
}

if (env.PLATFORM_PAUSED) {
  discoveryStop = () => undefined;
} else {
  try {
    discoveryStop = await startPumpFunDiscovery(async (event) => {
      discoveryCount += 1;
      lastDiscoveryAt = new Date().toISOString();
      try {
        await handleSniperDiscovery(event);
      } catch (error) {
        logger.error({ err: error, mint: event.tokenAddress }, 'Sniper discovery handler failed');
      }
    });
  } catch (error) {
    bootError = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Sniper discovery failed to start — will keep heartbeating');
    discoveryStop = () => undefined;
    telegram.send(
      `🚨 <b>SNIPER DISCOVERY IDLE</b>\n${bootError}\n` +
        `Set App-Level <code>SOLANA_WS_URL</code> / <code>SOLANA_BACKUP_WS_URL</code> on the sniper component, then Force rebuild <b>sniper</b>.`,
      { kind: 'sniper-ws-idle' },
    );
  }
}

const exitTimer = setInterval(() => {
  if (env.PLATFORM_PAUSED) return;
  if (exitInFlight) return;
  exitInFlight = true;
  void monitorOpenPositions({ strategy: TradingStrategy.SNIPER })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Sniper exit tick failed');
    })
    .finally(() => {
      exitInFlight = false;
    });
}, EXIT_MS);

if (!env.PLATFORM_PAUSED) {
  void monitorOpenPositions({ strategy: TradingStrategy.SNIPER }).catch((error: unknown) => {
    logger.error({ err: error }, 'Sniper exit initial tick failed');
  });
}

const heartbeatTimer = setInterval(() => {
  void beat('running', beatDetail());
}, HEARTBEAT_MS);

void beat('running', beatDetail({ boot: true }));

logger.info({ isColdStart, priorAgeMs }, 'COPYRA sniper worker started');

if (isColdStart) {
  telegram.send(
    `🎯 <b>SNIPER WORKER ONLINE</b>\nMode: ${env.SNIPER_MODE}\nHost enabled: ${env.SNIPER_ENABLED ? 'yes' : 'no'}\nPump.fun program: <code>${env.PUMP_FUN_PROGRAM_ID}</code>`,
    { kind: 'sniper-worker-online' },
  );
}

const shutdown = async () => {
  clearInterval(exitTimer);
  clearInterval(heartbeatTimer);
  discoveryStop?.();
  await beat('stopping', beatDetail());
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Sniper unhandledRejection (kept alive)');
});
