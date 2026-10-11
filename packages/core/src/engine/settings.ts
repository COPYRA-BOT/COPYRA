import {
  Chain,
  ExitStrategy,
  Prisma,
  TradingMode,
  prisma,
  type StrategySettings,
  type UserModeSettings,
} from '@copyra/db';
import { env } from '../config/env.js';
import { executableChains } from '../config/chains.js';
import { componentLogger } from '../obs/logger.js';
import type { StrategyConfig } from './types.js';

const log = componentLogger('settings');

/** Short in-memory cache so exit/detect ticks do not re-hit Postgres every 250ms. */
const SETTINGS_CACHE_TTL_MS = 250;
let settingsCache: { at: number; row: StrategySettings } | null = null;
const userModeCache = new Map<string, { at: number; row: UserModeSettings }>();

export type AuthTradingMode = 'sol' | 'evm' | 'sniper';

export function tradingModeFromAuth(mode: AuthTradingMode): TradingMode {
  if (mode === 'evm') return TradingMode.EVM;
  if (mode === 'sniper') return TradingMode.SNIPER;
  return TradingMode.SOL;
}

export function authModeFromTrading(mode: TradingMode): AuthTradingMode {
  if (mode === TradingMode.EVM) return 'evm';
  if (mode === TradingMode.SNIPER) return 'sniper';
  return 'sol';
}

export function tradingModeFromChain(chain: Chain): TradingMode {
  return chain === Chain.SOLANA ? TradingMode.SOL : TradingMode.EVM;
}

function cacheKey(userId: string, mode: TradingMode): string {
  return `${userId}:${mode}`;
}

/** Call after dashboard PATCH so the next read is fresh. */
export function invalidateSettingsCache(): void {
  settingsCache = null;
  userModeCache.clear();
}

export function invalidateUserModeSettingsCache(userId?: string, mode?: TradingMode): void {
  if (!userId) {
    userModeCache.clear();
    return;
  }
  if (mode) {
    userModeCache.delete(cacheKey(userId, mode));
    return;
  }
  for (const key of userModeCache.keys()) {
    if (key.startsWith(`${userId}:`)) userModeCache.delete(key);
  }
}

/**
 * One-shot ops defaults so the live app copies every qualifying buy and exits
 * on stop-loss only (take profit was firing into Jupiter 429 / bad fills).
 * Idempotent via host.ui.execThroughputFix — does not rewrite qualify/sizing math.
 */
/** Bump when re-applying live defaults (v1 failed: DB CHECK blocked takeProfitPct=0). */
const EXEC_THROUGHPUT_FIX = 2;

async function applyExecutionThroughputDefaults(host: StrategySettings): Promise<StrategySettings> {
  const ui =
    host.ui && typeof host.ui === 'object' && !Array.isArray(host.ui)
      ? ({ ...(host.ui as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  if (ui.execThroughputFix === EXEC_THROUGHPUT_FIX) return host;

  try {
    const updated = await prisma.strategySettings.update({
      where: { id: host.id },
      data: {
        takeProfitPct: 0,
        firstBuyOnly: false,
        // Meme copy needs headroom; 2–3% was rejecting real Jupiter routes.
        maxPriceImpactPct: 8,
        ui: { ...ui, execThroughputFix: EXEC_THROUGHPUT_FIX } as Prisma.InputJsonValue,
        updatedBy: 'exec-throughput-fix-v2',
      },
    });
    const modeResult = await prisma.userModeSettings.updateMany({
      data: {
        takeProfitPct: 0,
        firstBuyOnly: false,
        maxPriceImpactPct: 8,
        updatedBy: 'exec-throughput-fix-v2',
      },
    });
    userModeCache.clear();
    log.info(
      {
        takeProfitPct: 0,
        firstBuyOnly: false,
        maxPriceImpactPct: 8,
        userModeRows: modeResult.count,
      },
      'Applied execution throughput defaults v2 (SL-only, Every buy, impact 8%)',
    );
    return updated;
  } catch (error) {
    // If migration has not landed yet, do not brick boot — retry next ensureSettings.
    log.warn(
      { err: error },
      'exec-throughput-fix-v2 deferred (likely awaiting takeProfitPct>=0 migration)',
    );
    return host;
  }
}

/**
 * Host/global strategy row — emergency stop, chain allow-list, seed defaults.
 * Per-user SOL/EVM risk lives in UserModeSettings.
 */
export async function ensureSettings(): Promise<StrategySettings> {
  const hit = settingsCache;
  if (hit && Date.now() - hit.at < SETTINGS_CACHE_TTL_MS) return hit.row;

  const existing = await prisma.strategySettings.findUnique({ where: { id: 1 } });
  if (existing) {
    const applied = await applyExecutionThroughputDefaults(existing);
    settingsCache = { at: Date.now(), row: applied };
    return applied;
  }

  const defaultChains = executableChains().map((c) => c.chain);
  try {
    const created = await prisma.strategySettings.create({
      data: {
        id: 1,
        enabledChains: defaultChains.length > 0 ? defaultChains : [Chain.SOLANA],
        takeProfitPct: 0,
        firstBuyOnly: false,
        ui: { execThroughputFix: EXEC_THROUGHPUT_FIX } as Prisma.InputJsonValue,
        updatedBy: 'exec-throughput-fix',
      },
    });
    log.info({ enabledChains: created.enabledChains }, 'Seeded default strategy settings from spec');
    settingsCache = { at: Date.now(), row: created };
    return created;
  } catch (error) {
    const raced = await prisma.strategySettings.findUnique({ where: { id: 1 } });
    if (raced) {
      const applied = await applyExecutionThroughputDefaults(raced);
      settingsCache = { at: Date.now(), row: applied };
      return applied;
    }
    throw error;
  }
}

export async function getSettings(): Promise<StrategySettings> {
  return ensureSettings();
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

type RiskRow = {
  exitStrategy: ExitStrategy;
  minMarketCapUsd: unknown;
  maxMarketCapUsd: unknown;
  maxDeploymentPct: unknown;
  tier1MaxPct: unknown;
  tier2MaxPct: unknown;
  tier3MaxPct: unknown;
  tier4MaxPct: unknown;
  maxOpenPositions: number;
  reservePct: unknown;
  minTradeUsd: unknown;
  maxSlippageBps: number;
  maxPriceImpactPct: unknown;
  minLiquidityUsd: unknown;
  quoteMaxAgeMs: number;
  confirmTimeoutMs: number;
  maxExecutionAttempts: number;
  takeProfitPct: unknown;
  stopLossPct: unknown;
  trailingTriggerPct: unknown;
  trailingPartialSellPct: unknown;
  trailingDropPct: unknown;
  followTraderSells: boolean;
  firstBuyOnly: boolean;
  tradeAllocationPct?: unknown;
};

/**
 * Converts a risk row into the plain config pure engine functions take.
 * `tradingEnabled` / `emergencyStop` / `enabledChains` come from the host row
 * (and env) unless overridden by the caller for a user-mode engine state.
 */
export function toStrategyConfig(
  row: RiskRow,
  host: Pick<StrategySettings, 'tradingEnabled' | 'emergencyStop' | 'enabledChains'>,
  opts?: { modeEngine?: string },
): StrategyConfig {
  const modeEngine = (opts?.modeEngine ?? 'ON').toUpperCase();
  const modeOn = modeEngine === 'ON';
  const allocRaw = row.tradeAllocationPct !== undefined ? num(row.tradeAllocationPct) : 50;
  const tradeAllocationPct = Number.isFinite(allocRaw)
    ? Math.min(100, Math.max(1, allocRaw))
    : 50;

  return {
    tradingEnabled: host.tradingEnabled && env.TRADING_ENABLED && modeOn,
    emergencyStop: host.emergencyStop,
    exitStrategy: row.exitStrategy,
    minMarketCapUsd: num(row.minMarketCapUsd),
    maxMarketCapUsd: num(row.maxMarketCapUsd),
    maxDeploymentPct: num(row.maxDeploymentPct),
    tier1MaxPct: num(row.tier1MaxPct),
    tier2MaxPct: num(row.tier2MaxPct),
    tier3MaxPct: num(row.tier3MaxPct),
    tier4MaxPct: num(row.tier4MaxPct),
    maxOpenPositions: row.maxOpenPositions,
    reservePct: num(row.reservePct),
    minTradeUsd: num(row.minTradeUsd),
    maxSlippageBps: row.maxSlippageBps,
    maxPriceImpactPct: num(row.maxPriceImpactPct),
    minLiquidityUsd: num(row.minLiquidityUsd),
    quoteMaxAgeMs: row.quoteMaxAgeMs,
    confirmTimeoutMs: row.confirmTimeoutMs,
    maxExecutionAttempts: row.maxExecutionAttempts,
    takeProfitPct: num(row.takeProfitPct),
    stopLossPct: num(row.stopLossPct),
    trailingTriggerPct: num(row.trailingTriggerPct),
    trailingPartialSellPct: num(row.trailingPartialSellPct),
    trailingDropPct: num(row.trailingDropPct),
    followTraderSells: row.followTraderSells,
    firstBuyOnly: row.firstBuyOnly !== false,
    tradeAllocationPct,
    enabledChains: host.enabledChains,
  };
}

/** Host-level config (no user mode). Prefer getStrategyConfigFor on the hot path. */
export async function getStrategyConfig(): Promise<StrategyConfig> {
  const host = await ensureSettings();
  return toStrategyConfig(host, host, { modeEngine: 'ON' });
}

function seedDataFromHost(host: StrategySettings, mode: TradingMode) {
  const legacyUi =
    host.ui && typeof host.ui === 'object' && !Array.isArray(host.ui)
      ? (host.ui as Record<string, unknown>)
      : {};
  const modeKey = authModeFromTrading(mode);
  const modeUi =
    legacyUi[modeKey] && typeof legacyUi[modeKey] === 'object' && !Array.isArray(legacyUi[modeKey])
      ? (legacyUi[modeKey] as Record<string, unknown>)
      : {};
  const engineRaw = typeof modeUi.engine === 'string' ? modeUi.engine.toUpperCase() : '';
  const engine =
    engineRaw === 'ON' || engineRaw === 'PAUSED' || engineRaw === 'STOPPED'
      ? engineRaw
      : host.tradingEnabled
        ? 'ON'
        : 'PAUSED';
  const alloc = Number(modeUi.alloc);
  const maxTok = Number(modeUi.maxTok);

  return {
    engine,
    exitStrategy: host.exitStrategy,
    minMarketCapUsd: host.minMarketCapUsd,
    maxMarketCapUsd: host.maxMarketCapUsd,
    maxDeploymentPct: host.maxDeploymentPct,
    tier1MaxPct: host.tier1MaxPct,
    tier2MaxPct: host.tier2MaxPct,
    tier3MaxPct: host.tier3MaxPct,
    tier4MaxPct: host.tier4MaxPct,
    maxOpenPositions: host.maxOpenPositions,
    tradeAllocationPct: Number.isFinite(alloc) && alloc > 0 ? alloc : 50,
    maxCapitalPerTokenPct: Number.isFinite(maxTok) && maxTok > 0 ? maxTok : 50,
    reservePct: host.reservePct,
    minTradeUsd: host.minTradeUsd,
    autoTransferFromSavings: host.autoTransferFromSavings,
    maxSlippageBps: host.maxSlippageBps,
    maxPriceImpactPct: host.maxPriceImpactPct,
    minLiquidityUsd: host.minLiquidityUsd,
    quoteMaxAgeMs: host.quoteMaxAgeMs,
    confirmTimeoutMs: host.confirmTimeoutMs,
    maxExecutionAttempts: host.maxExecutionAttempts,
    takeProfitPct: host.takeProfitPct,
    stopLossPct: host.stopLossPct,
    trailingTriggerPct: host.trailingTriggerPct,
    trailingPartialSellPct: host.trailingPartialSellPct,
    trailingDropPct: host.trailingDropPct,
    followTraderSells: host.followTraderSells,
    firstBuyOnly: host.firstBuyOnly,
    ui: Object.keys(modeUi).length > 0 ? modeUi : undefined,
    updatedBy: 'seed:user_mode_settings',
  };
}

/** Sniper seed defaults — fail-closed launch filters (independent of copy SOL mode). */
function sniperSeedOverrides(host: StrategySettings) {
  return {
    engine: 'PAUSED' as const,
    exitStrategy: ExitStrategy.MANUAL,
    minMarketCapUsd: 1,
    maxMarketCapUsd: 20_000_000,
    maxDeploymentPct: 50,
    maxOpenPositions: 5,
    tradeAllocationPct: 20,
    maxCapitalPerTokenPct: 20,
    reservePct: host.reservePct,
    minTradeUsd: Math.min(Number(host.minTradeUsd) || 10, 10),
    maxSlippageBps: 300,
    maxPriceImpactPct: 8,
    minLiquidityUsd: 10_000,
    takeProfitPct: 20,
    stopLossPct: 10,
    trailingTriggerPct: 20,
    trailingPartialSellPct: 50,
    trailingDropPct: 15,
    followTraderSells: false,
    firstBuyOnly: false,
    ui: {
      sniperRuntimeMode: 'monitor',
      sniperEnabled: true,
      maxPositionSol: 0.25,
      maxDeployedSol: 2,
      dailyLossLimitSol: 1,
      allowedLaunchpads: ['pump.fun'],
      blacklist: '',
    },
  };
}

/** Load or seed the user's SOL/EVM/SNIPER strategy row. */
export async function ensureUserModeSettings(
  userId: string,
  mode: TradingMode | AuthTradingMode,
): Promise<UserModeSettings> {
  const tradingMode =
    typeof mode === 'string' && (mode === 'sol' || mode === 'evm' || mode === 'sniper')
      ? tradingModeFromAuth(mode)
      : (mode as TradingMode);

  const key = cacheKey(userId, tradingMode);
  const hit = userModeCache.get(key);
  if (hit && Date.now() - hit.at < SETTINGS_CACHE_TTL_MS) return hit.row;

  const existing = await prisma.userModeSettings.findUnique({
    where: { userId_mode: { userId, mode: tradingMode } },
  });
  if (existing) {
    userModeCache.set(key, { at: Date.now(), row: existing });
    return existing;
  }

  const host = await ensureSettings();
  try {
    const base = seedDataFromHost(host, tradingMode);
    const seed =
      tradingMode === TradingMode.SNIPER
        ? { ...base, ...sniperSeedOverrides(host) }
        : base;
    const created = await prisma.userModeSettings.create({
      data: {
        userId,
        mode: tradingMode,
        ...seed,
        ui:
          seed.ui === undefined
            ? undefined
            : (seed.ui as Prisma.InputJsonValue),
      },
    });
    log.info({ userId, mode: tradingMode, engine: created.engine }, 'Seeded user mode settings');
    userModeCache.set(key, { at: Date.now(), row: created });
    return created;
  } catch (error) {
    const raced = await prisma.userModeSettings.findUnique({
      where: { userId_mode: { userId, mode: tradingMode } },
    });
    if (raced) {
      userModeCache.set(key, { at: Date.now(), row: raced });
      return raced;
    }
    throw error;
  }
}

export async function getUserModeSettings(
  userId: string,
  mode: TradingMode | AuthTradingMode,
): Promise<UserModeSettings> {
  return ensureUserModeSettings(userId, mode);
}

/** Effective strategy for one user's SOL or EVM mode (worker + API hot path). */
export async function getStrategyConfigFor(
  userId: string,
  mode: TradingMode | AuthTradingMode | Chain,
): Promise<{ config: StrategyConfig; modeRow: UserModeSettings; host: StrategySettings }> {
  const tradingMode =
    typeof mode === 'string' && (mode === 'sol' || mode === 'evm' || mode === 'sniper')
      ? tradingModeFromAuth(mode)
      : typeof mode === 'string' && Object.values(Chain).includes(mode as Chain)
        ? tradingModeFromChain(mode as Chain)
        : (mode as TradingMode);

  const [host, modeRow] = await Promise.all([
    ensureSettings(),
    ensureUserModeSettings(userId, tradingMode),
  ]);
  const config = toStrategyConfig(modeRow, host, { modeEngine: modeRow.engine });
  return { config, modeRow, host };
}

/**
 * The reason trading is currently blocked, or null when it is live.
 * Surfaced verbatim in the dashboard so the state is never ambiguous.
 */
export function tradingBlockedReason(
  row: StrategySettings,
  signerAvailable: boolean,
  modeRow?: Pick<UserModeSettings, 'engine'> | null,
): string | null {
  if (row.emergencyStop) {
    return `Emergency stop engaged${row.emergencyStopReason ? `: ${row.emergencyStopReason}` : ''}.`;
  }
  if (!env.TRADING_ENABLED) {
    return 'TRADING_ENABLED is false in the server environment. This is a host-level guard that the dashboard cannot override.';
  }
  if (!env.SOL_TRADING_ENABLED && !env.EVM_TRADING_ENABLED) {
    return 'SOL_TRADING_ENABLED and EVM_TRADING_ENABLED are both false in the server environment.';
  }
  if (!row.tradingEnabled) {
    return 'Trading is switched off in strategy settings.';
  }
  if (modeRow) {
    const eng = (modeRow.engine || '').toUpperCase();
    if (eng === 'STOPPED') return 'This mode is stopped (kill switch). Resume or clear kill switch to trade.';
    if (eng === 'PAUSED') return 'This mode is paused. Resume from the dashboard to trade.';
  }
  if (!signerAvailable) {
    return 'No server-side signing key is configured, so no transaction can be broadcast. COPYRA will detect, decode, qualify and size signals but will not trade.';
  }
  if (row.enabledChains.length === 0) {
    return 'No chains are enabled.';
  }
  return null;
}

export { ExitStrategy, TradingMode };
