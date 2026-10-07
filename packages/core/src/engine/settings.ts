import { Chain, ExitStrategy, prisma, type StrategySettings } from '@copyra/db';
import { env } from '../config/env.js';
import { executableChains } from '../config/chains.js';
import { componentLogger } from '../obs/logger.js';
import type { StrategyConfig } from './types.js';

const log = componentLogger('settings');

/**
 * Strategy settings are a single database row, so the API, the worker and the
 * exit monitor can never disagree about risk limits. The spec's defaults are
 * seeded on first read and are never silently changed afterwards (spec §26).
 */
export async function ensureSettings(): Promise<StrategySettings> {
  const existing = await prisma.strategySettings.findUnique({ where: { id: 1 } });
  if (existing) return existing;

  const defaultChains = executableChains().map((c) => c.chain);
  try {
    const created = await prisma.strategySettings.create({
      data: {
        id: 1,
        enabledChains: defaultChains.length > 0 ? defaultChains : [Chain.SOLANA],
      },
    });
    log.info({ enabledChains: created.enabledChains }, 'Seeded default strategy settings from spec');
    return created;
  } catch (error) {
    // API and worker can both seed the singleton on a fresh database.
    const raced = await prisma.strategySettings.findUnique({ where: { id: 1 } });
    if (raced) return raced;
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

/**
 * Converts the database row into the plain config the pure engine functions
 * take. `tradingEnabled` is the AND of the database switch and the
 * `TRADING_ENABLED` env guard, so an operator can hard-disable trading at the
 * host level regardless of what the dashboard says.
 */
export function toStrategyConfig(row: StrategySettings): StrategyConfig {
  return {
    tradingEnabled: row.tradingEnabled && env.TRADING_ENABLED,
    emergencyStop: row.emergencyStop,
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
    enabledChains: row.enabledChains,
  };
}

export async function getStrategyConfig(): Promise<StrategyConfig> {
  return toStrategyConfig(await ensureSettings());
}

/**
 * The reason trading is currently blocked, or null when it is live.
 * Surfaced verbatim in the dashboard so the state is never ambiguous.
 */
export function tradingBlockedReason(
  row: StrategySettings,
  signerAvailable: boolean,
): string | null {
  if (row.emergencyStop) {
    return `Emergency stop engaged${row.emergencyStopReason ? `: ${row.emergencyStopReason}` : ''}.`;
  }
  if (!env.TRADING_ENABLED) {
    return 'TRADING_ENABLED is false in the server environment. This is a host-level guard that the dashboard cannot override.';
  }
  if (!row.tradingEnabled) {
    return 'Trading is switched off in strategy settings.';
  }
  if (!signerAvailable) {
    return 'No server-side signing key is configured, so no transaction can be broadcast. COPYRA will detect, decode, qualify and size signals but will not trade.';
  }
  if (row.enabledChains.length === 0) {
    return 'No chains are enabled.';
  }
  return null;
}

export { ExitStrategy };
