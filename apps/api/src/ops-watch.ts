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

/**
 * Heartbeat is written every ~5s. Allow brief DB/pool blips and DO rolling
 * deploys before paging — 2 min was false-alerting while status stayed "running".
 */
const WORKER_STALE_MS = 5 * 60_000;
/** Require two consecutive stale checks (~90s apart) before alerting. */
const STALE_STREAK_NEEDED = 2;
const CHECK_MS = 45_000;

let wasWorkerDown = false;
let staleStreak = 0;
let wasTradingBlocked: string | null = null;

/**
 * API-side 24/7 watchdog. The worker can die without sending Telegram;
 * this loop watches the heartbeat + trading guards and pings the admin ops chat.
 */
export function startOpsWatch(): () => void {
  const tick = async () => {
    try {
      const [hb, sniperHb, settings] = await Promise.all([
        prisma.workerHeartbeat.findUnique({ where: { name: 'copyra-worker' } }),
        prisma.workerHeartbeat.findUnique({ where: { name: 'copyra-sniper-worker' } }),
        getSettings(),
      ]);

      const beatAge = hb?.beatAt ? Date.now() - hb.beatAt.getTime() : Number.POSITIVE_INFINITY;
      const looksDown = !hb || hb.status === 'stopped' || beatAge > WORKER_STALE_MS;

      if (looksDown) {
        staleStreak += 1;
      } else {
        staleStreak = 0;
      }

      const workerDown = looksDown && staleStreak >= STALE_STREAK_NEEDED;

      if (workerDown && !wasWorkerDown) {
        const ageSec = Number.isFinite(beatAge) ? Math.round(beatAge / 1000) : 'unknown';
        await alertOps(
          'worker-down',
          `Copy-trade <b>worker is DOWN or stale</b>.\n` +
            `Heartbeat age: ${ageSec}s\n` +
            `Status: ${hb?.status ?? 'missing'}\n` +
            `Check DigitalOcean → Runtime Logs → <b>worker</b> component, then Force rebuild that worker.`,
          { awaitDelivery: true },
        );
        wasWorkerDown = true;
      } else if (!looksDown && wasWorkerDown) {
        await alertOpsCleared(
          'worker-down',
          `Copy-trade worker is <b>back</b>.\nHeartbeat age: ${Math.round(beatAge / 1000)}s`,
        );
        wasWorkerDown = false;
      }

      // Blind WS: heartbeat fresh but no Solana log events while watching wallets.
      const detail =
        hb?.detail && typeof hb.detail === 'object' && !Array.isArray(hb.detail)
          ? (hb.detail as Record<string, unknown>)
          : {};
      const watching = Number(detail.watching ?? 0);
      const wsAt = Number(detail.lastSolanaWsEventAt ?? 0);
      const syncAt = Number(detail.lastSolanaSyncAt ?? 0);
      if (!looksDown && watching > 0 && (!wsAt || wsAt <= 0) && syncAt > 0) {
        const syncAge = Date.now() - syncAt;
        if (syncAge < 60_000) {
          await alertOps(
            'copy-ws-blind',
            `Copy-trade worker heartbeat is <b>live</b> but <b>no Solana WS events</b> while watching ${watching} traders.\n` +
              `Detection is blind — no copy trades can fire.\n` +
              `Check App-Level <code>SOLANA_WS_URL</code> on the <b>worker</b> component, then Force rebuild worker.`,
            { cooldownSec: 30 * 60 },
          );
        }
      }

      // Sniper worker down / discovery idle (independent of copy).
      const sniperAge = sniperHb?.beatAt
        ? Date.now() - sniperHb.beatAt.getTime()
        : Number.POSITIVE_INFINITY;
      const sniperDetail =
        sniperHb?.detail && typeof sniperHb.detail === 'object' && !Array.isArray(sniperHb.detail)
          ? (sniperHb.detail as Record<string, unknown>)
          : {};
      if (!sniperHb || sniperAge > WORKER_STALE_MS) {
        await alertOps(
          'sniper-worker-down',
          `Sniper worker is <b>DOWN or stale</b>.\nHeartbeat age: ${Number.isFinite(sniperAge) ? Math.round(sniperAge / 1000) : 'unknown'}s\n` +
            `Check DigitalOcean → Runtime Logs → <b>sniper</b> component.`,
          { cooldownSec: 15 * 60 },
        );
      } else if (sniperDetail.wsConnected === false || sniperDetail.bootError) {
        await alertOps(
          'sniper-ws-idle',
          `Sniper worker is live but discovery WS is <b>idle</b>.\n` +
            `wsConnected=${String(sniperDetail.wsConnected)} · decodeOk=${String(sniperDetail.decodeOk ?? 0)}\n` +
            `${sniperDetail.bootError ? `bootError: ${String(sniperDetail.bootError)}\n` : ''}` +
            `Ensure App-Level <code>SOLANA_WS_URL</code> reaches the <b>sniper</b> component (prefer backup WS to isolate from copy).`,
          { cooldownSec: 30 * 60 },
        );
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
  }, 120_000);
  const timer = setInterval(() => {
    void tick();
  }, CHECK_MS);
  return () => {
    clearTimeout(bootDelay);
    clearInterval(timer);
  };
}
