import {
  alertOps,
  alertOpsCleared,
  evmSigner,
  getSettings,
  logger,
  multiUserCustodyEnabled,
  solanaSigner,
  tradingBlockedReason,
} from '@copyra/core';
import { prisma } from '@copyra/db';

const log = logger.child({ component: 'ops-watch' });

/** Worker heartbeat older than this → treat as down. */
const WORKER_STALE_MS = 2 * 60_000;
const CHECK_MS = 45_000;

let wasWorkerDown = false;
let wasTradingBlocked: string | null = null;

/**
 * API-side 24/7 watchdog. The worker can die without sending Telegram;
 * this loop watches the heartbeat + trading guards and pings the operator.
 */
export function startOpsWatch(): () => void {
  const tick = async () => {
    try {
      const [hb, settings] = await Promise.all([
        prisma.workerHeartbeat.findUnique({ where: { name: 'copyra-worker' } }),
        getSettings(),
      ]);

      const beatAge = hb?.beatAt ? Date.now() - hb.beatAt.getTime() : Number.POSITIVE_INFINITY;
      const workerDown = !hb || hb.status === 'stopped' || beatAge > WORKER_STALE_MS;

      if (workerDown && !wasWorkerDown) {
        const ageSec = Number.isFinite(beatAge) ? Math.round(beatAge / 1000) : 'unknown';
        await alertOps(
          'worker-down',
          `Copy-trade <b>worker is DOWN or stale</b>.\n` +
            `Heartbeat age: ${ageSec}s\n` +
            `Status: ${hb?.status ?? 'missing'}\n` +
            `Check DigitalOcean logs / restart the api service.`,
          { awaitDelivery: true },
        );
        wasWorkerDown = true;
      } else if (!workerDown && wasWorkerDown) {
        await alertOpsCleared(
          'worker-down',
          `Copy-trade worker is <b>back</b>.\nHeartbeat age: ${Math.round(beatAge / 1000)}s`,
        );
        wasWorkerDown = false;
      }

      const signerAvailable =
        multiUserCustodyEnabled() || solanaSigner.available || evmSigner.available;
      const blocked = tradingBlockedReason(settings, signerAvailable);
      const tradingOff = Boolean(blocked) || !settings.tradingEnabled || settings.emergencyStop;

      if (tradingOff) {
        const reason =
          blocked ||
          (settings.emergencyStop ? 'Emergency stop engaged' : 'Trading disabled in settings');
        if (wasTradingBlocked !== reason) {
          await alertOps(
            'trading-off',
            `Trading is <b>OFF / blocked</b>.\nReason: ${reason}\nNo new copy trades will broadcast until this is cleared.`,
            { awaitDelivery: true, cooldownSec: 30 * 60 },
          );
          wasTradingBlocked = reason;
        }
      } else if (wasTradingBlocked) {
        await alertOpsCleared('trading-off', 'Trading is <b>ON</b> again. Copy execution unblocked.');
        wasTradingBlocked = null;
      }
    } catch (error) {
      log.error({ err: error }, 'Ops watch tick failed');
    }
  };

  // Delay first check so a normal DigitalOcean redeploy (API up before worker)
  // does not page the operator with a false "worker down".
  const bootDelay = setTimeout(() => {
    void tick();
  }, 90_000);
  const timer = setInterval(() => {
    void tick();
  }, CHECK_MS);
  return () => {
    clearTimeout(bootDelay);
    clearInterval(timer);
  };
}
