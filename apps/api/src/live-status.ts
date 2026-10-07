import {
  buildLatencyReport,
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
const STATUS_CACHE_MS = 6_000;
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

async function fetchChainHeads(): Promise<ChainHead[]> {
  return Promise.all(
    monitorableChains().map(async (config): Promise<ChainHead> => {
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

/**
 * Build /api/status payload quickly.
 * Chain RPC + Telegram are cached so dashboard / WS / snapshot cannot wedge the instance.
 */
export async function buildLiveStatus(request?: FastifyRequest): Promise<LiveStatusPayload> {
  const settings = await getSettings();
  const signerAvailable =
    multiUserCustodyEnabled() || solanaSigner.available || evmSigner.available;

  const [chains, telegramStatus, heartbeats] = await Promise.all([
    getCachedChainHeads(),
    getCachedTelegram(),
    prisma.workerHeartbeat.findMany(),
  ]);

  let activeUserId: string | undefined;
  if (request) {
    const sessions = await readBothSessions(request);
    const mode = authModeFromRequest(request);
    activeUserId = mode === 'evm' ? sessions.evm?.user.id : sessions.sol?.user.id;
  }

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
          select: { totalLatencyMs: true, broadcastAt: true, sourceDetectedAt: true },
          take: 200,
        }),
      ])
    : [
        0,
        0,
        [] as {
          totalLatencyMs: number | null;
          broadcastAt: Date | null;
          sourceDetectedAt: Date | null;
        }[],
      ];

  const confirmSamples = confirmedTrades
    .map((t) => t.totalLatencyMs)
    .filter((n): n is number => typeof n === 'number');
  const broadcastSamples = confirmedTrades
    .map((t) =>
      t.broadcastAt && t.sourceDetectedAt
        ? t.broadcastAt.getTime() - t.sourceDetectedAt.getTime()
        : null,
    )
    .filter((n): n is number => typeof n === 'number');

  return jsonSafe({
    trading: {
      envGuard: process.env.TRADING_ENABLED === 'true',
      settingsEnabled: settings.tradingEnabled,
      emergencyStop: settings.emergencyStop,
      blockedReason: tradingBlockedReason(settings, signerAvailable),
      observeOnly: !signerAvailable,
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
    workers: heartbeats,
    counts: { openPositions, signals24h, confirmedTrades: confirmedTrades.length },
    latency: buildLatencyReport(broadcastSamples, confirmSamples),
    socials: {
      x: 'https://x.com/copyrafun',
      telegram: 'https://t.me/copyrafun',
      domain: 'https://copyra.fun',
    },
    cachedAt: chainCache?.at ? new Date(chainCache.at).toISOString() : null,
  });
}
