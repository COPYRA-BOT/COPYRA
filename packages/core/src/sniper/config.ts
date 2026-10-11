import { Chain, TradingMode, type UserModeSettings } from '@copyra/db';
import { env } from '../config/env.js';
import { getStrategyConfigFor } from '../engine/settings.js';
import { DEFAULT_PUMP_FUN_PROGRAM_ID } from './constants.js';
import type { SniperConfig, SniperLaunchpad, SniperRuntimeMode } from './types.js';

function parseLaunchpads(raw: string[] | undefined): SniperLaunchpad[] {
  const allowed: SniperLaunchpad[] = ['pump.fun', 'pumpswap', 'raydium', 'unknown'];
  const list = (raw ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return ['pump.fun'];
  return list.filter((x): x is SniperLaunchpad =>
    (allowed as string[]).includes(x),
  ) as SniperLaunchpad[];
}

function parseRuntimeMode(raw: string | undefined): SniperRuntimeMode {
  const n = (raw ?? 'monitor').trim().toLowerCase();
  if (n === 'live' || n === 'onchain' || n === 'monitor') return n;
  return 'monitor';
}

function numUi(ui: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const v = ui?.[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strListUi(ui: Record<string, unknown> | null | undefined, key: string): string[] {
  const v = ui?.[key];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string')
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

/** Host env defaults — dashboard UserModeSettings can tighten further. */
export function sniperHostDefaults(): Omit<
  SniperConfig,
  | 'takeProfitPct'
  | 'stopLossPct'
  | 'exitStrategy'
  | 'tradeAllocationPct'
  | 'reservePct'
  | 'minTradeUsd'
  | 'maxDeploymentPct'
  | 'engineOn'
  | 'emergencyStop'
  | 'tokenBlacklist'
> {
  return {
    enabled: env.SNIPER_ENABLED,
    runtimeMode: parseRuntimeMode(env.SNIPER_MODE),
    maxMarketCapUsd: env.SNIPER_MAX_MARKET_CAP_USD,
    minLiquidityUsd: env.SNIPER_MIN_LIQUIDITY_USD,
    maxPriceImpactBps: env.SNIPER_MAX_PRICE_IMPACT_BPS,
    maxSlippageBps: env.SNIPER_MAX_SLIPPAGE_BPS,
    maxOpenPositions: env.SNIPER_MAX_OPEN_POSITIONS,
    maxPositionSol: env.SNIPER_MAX_POSITION_SOL,
    maxDeployedSol: env.SNIPER_MAX_DEPLOYED_SOL,
    dailyLossLimitSol: env.SNIPER_DAILY_LOSS_LIMIT_SOL,
    allowedLaunchpads: parseLaunchpads(env.SNIPER_ALLOWED_LAUNCHPADS),
    marketDataMaxAgeMs: env.SNIPER_MARKET_DATA_MAX_AGE_MS,
    pumpFunProgramId: env.PUMP_FUN_PROGRAM_ID || DEFAULT_PUMP_FUN_PROGRAM_ID,
  };
}

export function sniperConfigFromModeRow(
  modeRow: UserModeSettings,
  host: { emergencyStop: boolean },
): SniperConfig {
  const ui =
    modeRow.ui && typeof modeRow.ui === 'object' && !Array.isArray(modeRow.ui)
      ? (modeRow.ui as Record<string, unknown>)
      : {};
  const hostDefaults = sniperHostDefaults();
  const runtimeFromUi = typeof ui.sniperRuntimeMode === 'string' ? ui.sniperRuntimeMode : undefined;
  const pads = strListUi(ui, 'allowedLaunchpads');
  const bl = strListUi(ui, 'blacklist');

  return {
    ...hostDefaults,
    enabled: hostDefaults.enabled && (ui.sniperEnabled !== false),
    runtimeMode: runtimeFromUi
      ? parseRuntimeMode(runtimeFromUi)
      : hostDefaults.runtimeMode,
    maxMarketCapUsd: Math.min(
      hostDefaults.maxMarketCapUsd,
      Number(modeRow.maxMarketCapUsd) || hostDefaults.maxMarketCapUsd,
    ),
    minLiquidityUsd: Math.max(
      hostDefaults.minLiquidityUsd,
      Number(modeRow.minLiquidityUsd) || hostDefaults.minLiquidityUsd,
    ),
    maxPriceImpactBps: Math.min(
      hostDefaults.maxPriceImpactBps,
      Math.round(Number(modeRow.maxPriceImpactPct) * 100) || hostDefaults.maxPriceImpactBps,
    ),
    maxSlippageBps: Math.min(
      hostDefaults.maxSlippageBps,
      modeRow.maxSlippageBps || hostDefaults.maxSlippageBps,
    ),
    maxOpenPositions: Math.min(
      hostDefaults.maxOpenPositions,
      modeRow.maxOpenPositions || hostDefaults.maxOpenPositions,
    ),
    maxPositionSol: numUi(ui, 'maxPositionSol', hostDefaults.maxPositionSol),
    maxDeployedSol: numUi(ui, 'maxDeployedSol', hostDefaults.maxDeployedSol),
    dailyLossLimitSol: numUi(ui, 'dailyLossLimitSol', hostDefaults.dailyLossLimitSol),
    allowedLaunchpads: pads.length
      ? parseLaunchpads(pads)
      : hostDefaults.allowedLaunchpads,
    takeProfitPct: Number(modeRow.takeProfitPct),
    stopLossPct: Number(modeRow.stopLossPct),
    exitStrategy: modeRow.exitStrategy === 'TRAILING' ? 'TRAILING' : 'MANUAL',
    tradeAllocationPct: Number(modeRow.tradeAllocationPct ?? 20),
    reservePct: Number(modeRow.reservePct),
    minTradeUsd: Number(modeRow.minTradeUsd),
    maxDeploymentPct: Number(modeRow.maxDeploymentPct),
    engineOn: (modeRow.engine || '').toUpperCase() === 'ON',
    emergencyStop: host.emergencyStop,
    tokenBlacklist: bl.map((a) => a.toLowerCase()),
  };
}

/** Load effective sniper config for one user (UserModeSettings.SNIPER + env). */
export async function getSniperConfigFor(userId: string): Promise<SniperConfig> {
  const { modeRow, host } = await getStrategyConfigFor(userId, TradingMode.SNIPER);
  return sniperConfigFromModeRow(modeRow, host);
}

export function sniperUsesSolCustody(): true {
  return true;
}

export function sniperChain(): Chain {
  return Chain.SOLANA;
}
