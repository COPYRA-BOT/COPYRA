import {
  buildLatencyReport,
  env,
  evmSigner,
  executableChains,
  getEvmBlockNumber,
  getSettings,
  getSlot,
  monitorableChains,
  multiUserCustodyEnabled,
  solanaSigner,
  telegram,
  tradingBlockedReason,
} from '@copyra/core';
import { prisma } from '@copyra/db';
import type { FastifyRequest } from 'fastify';
import { authModeFromRequest, readBothSessions } from './auth.js';
import { jsonSafe } from './serialize.js';

const CHAIN_RPC_TIMEOUT_MS = 1_800;
const STATUS_CACHE_MS = 15_000;
const TELEGRAM_CACHE_MS = 60_000;

type ChainHead = {
  chain: string;
  label: string;
  code: string;
  kind: string;
  canExecute: boolean;
  executionBlockedReason: string | null;
  explorerName: string;
  nativeSymbol: string;
  head: string | null;
  latencyMs: number | null;
  error: string | null;
};

type TelegramStatus = {
  tokenValid: boolean;
  botUsername: string | null;
  canPostToChat: boolean;
  chatTitle: string | null;
  error: string | null;
};

let chainCache: { at: number; chains: ChainHead[] } | null = null;
let telegramCache: { at: number; value: TelegramStatus } | null = null;
let chainInflight: Promise<ChainHead[]> | null = null;

function timeoutMs<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(onTimeout());
      }
    }, ms);
    promise
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(onTimeout());
        }
      });
  });
}

/** Status heads for dashboard chains only — skip unused RPCs that used to wedge /api/status. */
const STATUS_CHAINS = new Set(['SOLANA', 'ETHEREUM', 'BASE', 'ARBITRUM', 'BSC']);

async function fetchChainHeads(): Promise<ChainHead[]> {
  const configs = monitorableChains().filter((c) => STATUS_CHAINS.has(c.chain));
  return Promise.all(
    configs.map(async (config): Promise<ChainHead> => {
      const base: Omit<ChainHead, 'head' | 'latencyMs' | 'error'> = {
        chain: config.chain,
        label: config.label,
        code: config.code,
        kind: config.kind,
        canExecute: config.canExecute,
        executionBlockedReason: config.executionBlockedReason ?? null,
        explorerName: config.explorerName,
        nativeSymbol: config.nativeSymbol,
      };
      return timeoutMs<ChainHead>(
        (async (): Promise<ChainHead> => {
          try {
            if (config.kind === 'solana') {
              const slot = await getSlot();
              return {
                ...base,
                head: String(slot.slot),
                latencyMs: slot.latencyMs,
                error: null,
              };
            }
            const block = await getEvmBlockNumber(config.chain);
            return {
              ...base,
              head: block.blockNumber.toString(),
              latencyMs: block.latencyMs,
              error: null,
            };
          } catch (err) {
            return {
              ...base,
              head: null,
              latencyMs: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })(),
        CHAIN_RPC_TIMEOUT_MS,
        () => ({
          ...base,
          head: null,
          latencyMs: null,
          error: `rpc-timeout>${CHAIN_RPC_TIMEOUT_MS}ms`,
        }),
      );
    }),
  );
}

/** Cached chain heads — never block the event loop for a dead RPC. */
export async function getCachedChainHeads(force = false): Promise<ChainHead[]> {
  const now = Date.now();
  if (!force && chainCache && now - chainCache.at < STATUS_CACHE_MS) {
    return chainCache.chains;
  }
  if (!force && chainInflight) return chainInflight;
  chainInflight = fetchChainHeads()
    .then((chains) => {
      chainCache = { at: Date.now(), chains };
      return chains;
    })
    .finally(() => {
      chainInflight = null;
    });
  // Stale-while-revalidate: if we have anything, return it immediately.
  if (chainCache && !force) {
    void chainInflight;
    return chainCache.chains;
  }
  return chainInflight;
}

async function getCachedTelegram(): Promise<TelegramStatus> {
  const now = Date.now();
  if (telegramCache && now - telegramCache.at < TELEGRAM_CACHE_MS) {
    return telegramCache.value;
  }
  const value = await timeoutMs<TelegramStatus>(
    telegram
      .verify()
      .then(
        (v): TelegramStatus => ({
          tokenValid: v.tokenValid,
          botUsername: v.botUsername,
          canPostToChat: v.canPostToChat,
          chatTitle: v.chatTitle,
          error: 'error' in v && typeof v.error === 'string' ? v.error : null,
        }),
      )
      .catch(
        (error: unknown): TelegramStatus => ({
          tokenValid: false,
          botUsername: null,
          canPostToChat: false,
          chatTitle: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    2_500,
    (): TelegramStatus =>
      telegramCache?.value ?? {
        tokenValid: false,
        botUsername: null,
        canPostToChat: false,
        chatTitle: null,
        error: 'telegram-timeout',
      },
  );
  telegramCache = { at: Date.now(), value };
  return value;
}

export type LiveStatusPayload = Record<string, unknown>;

/** Short full-payload cache — stops CF/dashboard stampede from wedging basic-xxs → 504. */
const STATUS_PAYLOAD_CACHE_MS = 5_000;
const statusPayloadCache = new Map<string, { at: number; value: LiveStatusPayload }>();

/**
 * Build /api/status payload quickly.
 * Chain RPC + Telegram are cached so dashboard / WS / snapshot cannot wedge the instance.
 */
export async function buildLiveStatus(request?: FastifyRequest): Promise<LiveStatusPayload> {
  let activeUserId: string | undefined;
  if (request) {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    activeUserId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
  }
  const cacheKey = activeUserId ?? 'anon';
  const hit = statusPayloadCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STATUS_PAYLOAD_CACHE_MS) return hit.value;

  const settings = await getSettings();
  const signerAvailable =
    multiUserCustodyEnabled() || solanaSigner.available || evmSigner.available;

  const [chains, telegramStatus, heartbeats] = await Promise.all([
    getCachedChainHeads(),
    getCachedTelegram(),
    prisma.workerHeartbeat.findMany(),
  ]);

  const [openPositions, signals24h, confirmedTrades] = activeUserId
    ? await Promise.all([
        prisma.position.count({
          where: {
            userId: activeUserId,
            status: { in: ['OPEN', 'PARTIALLY_CLOSED', 'PENDING_OPEN'] },
          },
        }),
        prisma.signal.count({
          where: { userId: activeUserId, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
        }),
        prisma.trade.findMany({
          where: { userId: activeUserId, status: 'CONFIRMED', totalLatencyMs: { not: null } },
          select: {
            totalLatencyMs: true,
            quoteLatencyMs: true,
            buildLatencyMs: true,
            signLatencyMs: true,
            broadcastLatencyMs: true,
            confirmLatencyMs: true,
          },
          take: 200,
        }),
      ])
    : [
        0,
        0,
        [] as {
          totalLatencyMs: number | null;
          quoteLatencyMs: number | null;
          buildLatencyMs: number | null;
          signLatencyMs: number | null;
          broadcastLatencyMs: number | null;
          confirmLatencyMs: number | null;
        }[],
      ];

  const confirmSamples = confirmedTrades
    .map((t) => t.totalLatencyMs)
    .filter((n): n is number => typeof n === 'number');
  // Submitted = executor hot path (quote→broadcast), NOT trader blockTime→broadcast
  // (that mixed chain lag into the metric and showed 8s+ while fills were ~1s).
  const broadcastSamples = confirmedTrades
    .map((t) => {
      const parts = [
        t.quoteLatencyMs,
        t.buildLatencyMs,
        t.signLatencyMs,
        t.broadcastLatencyMs,
      ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      if (parts.length >= 2) return parts.reduce((a, b) => a + b, 0);
      if (typeof t.totalLatencyMs === 'number' && typeof t.confirmLatencyMs === 'number') {
        return Math.max(0, t.totalLatencyMs - t.confirmLatencyMs);
      }
      return null;
    })
    .filter((n): n is number => typeof n === 'number');

  // Prefer sniper worker heartbeat for host sniper flags (API container may not
  // have SNIPER_* env when only the sniper component was updated in DO).
  const sniperHb = heartbeats.find(
    (hb) =>
      hb.name === 'copyra-sniper-worker' ||
      String(hb.name ?? '')
        .toLowerCase()
        .includes('sniper'),
  );
  const sniperDetail =
    sniperHb?.detail && typeof sniperHb.detail === 'object' && !Array.isArray(sniperHb.detail)
      ? (sniperHb.detail as Record<string, unknown>)
      : {};
  const sniperEnabledLive =
    typeof sniperDetail.sniperEnabled === 'boolean'
      ? sniperDetail.sniperEnabled
      : env.SNIPER_ENABLED;
  const sniperModeLive =
    typeof sniperDetail.sniperMode === 'string' ? String(sniperDetail.sniperMode) : env.SNIPER_MODE;

  const payload = jsonSafe({
    trading: {
      platformPaused: env.PLATFORM_PAUSED,
      envGuard: env.TRADING_ENABLED,
      solTradingEnabled: env.SOL_TRADING_ENABLED,
      evmTradingEnabled: env.EVM_TRADING_ENABLED,
      sniperEnabled: sniperEnabledLive,
      sniperMode: sniperModeLive,
      settingsEnabled: settings.tradingEnabled,
      emergencyStop: settings.emergencyStop,
      blockedReason: env.PLATFORM_PAUSED
        ? 'Platform paused until next month — trading, sniper, and Telegram are off.'
        : tradingBlockedReason(settings, signerAvailable),
      observeOnly: !signerAvailable || env.PLATFORM_PAUSED,
    },
    signers: {
      solana: { available: solanaSigner.available, address: solanaSigner.address },
      evm: { available: evmSigner.available, address: evmSigner.address },
    },
    multiUserCustody: multiUserCustodyEnabled(),
    rpcConfigured: {
      solana: Boolean(process.env.SOLANA_RPC_URL?.trim()),
      ethereum: Boolean(process.env.EVM_ETHEREUM_RPC_URL?.trim()),
      base: Boolean(process.env.EVM_BASE_RPC_URL?.trim()),
      arbitrum: Boolean(process.env.EVM_ARBITRUM_RPC_URL?.trim()),
      bsc: Boolean(process.env.EVM_BSC_RPC_URL?.trim()),
      polygon: Boolean(process.env.EVM_POLYGON_RPC_URL?.trim()),
      optimism: Boolean(process.env.EVM_OPTIMISM_RPC_URL?.trim()),
    },
    telegram: telegramStatus,
    chains,
    executableChains: executableChains().map((c) => c.chain),
    // Enrich heartbeats so the dashboard can tell "running" vs stale/dead worker.
    workers: heartbeats.map((hb) => {
      const ageMs = hb.beatAt ? Date.now() - new Date(hb.beatAt).getTime() : Number.POSITIVE_INFINITY;
      const detail =
        hb.detail && typeof hb.detail === 'object' && !Array.isArray(hb.detail)
          ? (hb.detail as Record<string, unknown>)
          : {};
      const syncAt = Number(detail.lastSolanaSyncAt ?? 0);
      const wsAt = Number(detail.lastSolanaWsEventAt ?? 0);
      const syncAgeMs = syncAt > 0 ? Date.now() - syncAt : null;
      const wsAgeMs = wsAt > 0 ? Date.now() - wsAt : null;
      // Copy worker: beat alone is not enough — a zombie can keep beatAt +
      // occasional WS while the subscription sync latch is stuck for hours.
      // Sniper worker has no wallet-sync latch; fresh running beat = live.
      const isSniperWorker =
        hb.name === 'copyra-sniper-worker' ||
        String(hb.name ?? '')
          .toLowerCase()
          .includes('sniper');
      const monitorFresh = isSniperWorker
        ? Number.isFinite(ageMs) && ageMs < 90_000
        : syncAgeMs != null && syncAgeMs < 180_000;
      const live =
        Number.isFinite(ageMs) &&
        ageMs < 90_000 &&
        hb.status === 'running' &&
        monitorFresh;
      return {
        ...hb,
        ageMs: Number.isFinite(ageMs) ? ageMs : null,
        live,
        monitorStale: !monitorFresh,
        syncAgeMs,
        wsAgeMs,
      };
    }),
    counts: { openPositions, signals24h, confirmedTrades: confirmedTrades.length },
    latency: buildLatencyReport(broadcastSamples, confirmSamples),
    socials: {
      x: 'https://x.com/copyrafun',
      telegram: 'https://t.me/copyrafun',
      domain: 'https://copyra.fun',
    },
    cachedAt: chainCache?.at ? new Date(chainCache.at).toISOString() : null,
  }) as LiveStatusPayload;
  statusPayloadCache.set(cacheKey, { at: Date.now(), value: payload });
  return payload;
}
