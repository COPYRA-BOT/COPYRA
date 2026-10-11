/**
 * COPYRA Sniper worker — independent of the wallet copy-trade worker.
 * Discovers Pump.fun / PumpSwap launches via Helius WS, qualifies fail-closed,
 * executes via shared Jupiter/signer, and monitors sniper-only exits.
 */
import {
  ensureSettings,
  env,
  handleSniperDiscovery,
  initSentry,
  logger,
  monitorOpenPositions,
  SNIPER_HEARTBEAT_NAME,
  startPumpFunDiscovery,
  telegram,
} from '@copyra/core';
import { prisma, TradingStrategy, type Prisma } from '@copyra/db';
import { writeFileSync } from 'node:fs';

initSentry('sniper-worker');

const EXIT_MS = 1_000;
const HEARTBEAT_MS = 5_000;

let exitInFlight = false;
let discoveryStop: (() => void) | null = null;
let lastDiscoveryAt: string | null = null;
let discoveryCount = 0;

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
        ...extra,
      }),
    );
  } catch {
    /* ignore */
  }
}

async function beat(status: string, detail: Prisma.InputJsonValue): Promise<void> {
  try {
    await prisma.workerHeartbeat.upsert({
      where: { name: SNIPER_HEARTBEAT_NAME },
      create: { name: SNIPER_HEARTBEAT_NAME, status, detail },
      update: { status, detail, beatAt: new Date() },
    });
  } catch (error) {
    logger.warn({ err: error }, 'Sniper heartbeat write failed');
  }
  writeStatus({ status, detail });
}

logger.info(
  {
    sniperEnabled: env.SNIPER_ENABLED,
    sniperMode: env.SNIPER_MODE,
    pumpFun: env.PUMP_FUN_PROGRAM_ID,
  },
  'COPYRA sniper worker starting',
);

await ensureSettings();

if (!env.SNIPER_ENABLED) {
  logger.warn(
    {},
    'SNIPER_ENABLED is false — discovery still listens when engines are ON, but host will reject buys',
  );
}

discoveryStop = await startPumpFunDiscovery(async (event) => {
  discoveryCount += 1;
  lastDiscoveryAt = new Date().toISOString();
  try {
    await handleSniperDiscovery(event);
  } catch (error) {
    logger.error({ err: error, mint: event.tokenAddress }, 'Sniper discovery handler failed');
  }
});

const exitTimer = setInterval(() => {
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

void monitorOpenPositions({ strategy: TradingStrategy.SNIPER }).catch((error: unknown) => {
  logger.error({ err: error }, 'Sniper exit initial tick failed');
});

const heartbeatTimer = setInterval(() => {
  void beat('running', {
    monitor: 'sniper+exits',
    sniperEnabled: env.SNIPER_ENABLED,
    sniperMode: env.SNIPER_MODE,
    lastSolanaSyncAt: Date.now(),
    lastDiscoveryAt,
    discoveryCount,
    pid: process.pid,
  });
}, HEARTBEAT_MS);

void beat('running', {
  monitor: 'sniper+exits',
  sniperEnabled: env.SNIPER_ENABLED,
  sniperMode: env.SNIPER_MODE,
  // Keep a sync-style clock so dashboards that key off lastSolanaSyncAt stay honest.
  lastSolanaSyncAt: Date.now(),
  lastDiscoveryAt,
  discoveryCount,
  boot: true,
  pid: process.pid,
});

telegram.send(
  `🎯 <b>SNIPER WORKER ONLINE</b>\nMode: ${env.SNIPER_MODE}\nHost enabled: ${env.SNIPER_ENABLED ? 'yes' : 'no'}\nPump.fun program: <code>${env.PUMP_FUN_PROGRAM_ID}</code>`,
  { kind: 'worker-online' },
);

const shutdown = async () => {
  clearInterval(exitTimer);
  clearInterval(heartbeatTimer);
  discoveryStop?.();
  await beat('stopping', { pid: process.pid });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Sniper unhandledRejection (kept alive)');
});
