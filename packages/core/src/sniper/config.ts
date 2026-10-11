import { Chain, TradingMode, type UserModeSettings } from '@copyra/db';
import { env } from '../config/env.js';
import { getStrategyConfigFor } from '../engine/settings.js';
import { DEFAULT_PUMP_FUN_PROGRAM_ID } from './constants.js';
import type {
  SniperConfig,
  SniperLaunchpad,
  SniperRuntimeMode,
  SniperTokenScope,
} from './types.js';

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

function parseTokenScope(raw: string | undefined): SniperTokenScope {
  const n = (raw ?? 'NEW').trim().toUpperCase();
  if (n === 'OLD' || n === 'BOTH' || n === 'NEW') return n;
  return 'NEW';
}

function numUi(ui: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const v = ui?.[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function boolUi(
  ui: Record<string, unknown> | null | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const v = ui?.[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
}

function migratedUi(ui: Record<string, unknown> | null | undefined): boolean | null {
  const v = ui?.migratedFilter;
  if (v === true || v === 'migrated' || v === 'yes') return true;
  if (v === false || v === 'bonding' || v === 'no') return false;
  if (v === 'any' || v === null || v === undefined || v === '') return null;
  return null;
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
    tokenScope: 'NEW',
    maxTokenAgeMin: 120,
    minTokenAgeMin: 60,
    minVolume24hUsd: 0,
    requireSocials: false,
    requireProfile: false,
    requireTwitter: false,
    requireWebsite: false,
    migratedOnly: null,
    minHolders: 0,
    maxHolders: 0,
    maxSniperPct: 40,
    maxDevHoldingPct: 15,
    maxTopHolderPct: 35,
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
  const scopeFromUi = typeof ui.tokenScope === 'string' ? ui.tokenScope : undefined;
  const pads = strListUi(ui, 'allowedLaunchpads');
  const bl = strListUi(ui, 'blacklist');

  return {
    ...hostDefaults,
    enabled: hostDefaults.enabled && ui.sniperEnabled !== false,
    runtimeMode: runtimeFromUi ? parseRuntimeMode(runtimeFromUi) : hostDefaults.runtimeMode,
    tokenScope: scopeFromUi ? parseTokenScope(scopeFromUi) : hostDefaults.tokenScope,
    maxTokenAgeMin: numUi(ui, 'maxTokenAgeMin', hostDefaults.maxTokenAgeMin),
    minTokenAgeMin: numUi(ui, 'minTokenAgeMin', hostDefaults.minTokenAgeMin),
    minVolume24hUsd: numUi(ui, 'minVolume24hUsd', hostDefaults.minVolume24hUsd),
    requireSocials: boolUi(ui, 'requireSocials', hostDefaults.requireSocials),
    requireProfile: boolUi(ui, 'requireProfile', hostDefaults.requireProfile),
    requireTwitter: boolUi(ui, 'requireTwitter', hostDefaults.requireTwitter),
    requireWebsite: boolUi(ui, 'requireWebsite', hostDefaults.requireWebsite),
    migratedOnly: migratedUi(ui),
    minHolders: Math.max(0, Math.floor(numUi(ui, 'minHolders', hostDefaults.minHolders))),
    maxHolders: Math.max(0, Math.floor(numUi(ui, 'maxHolders', hostDefaults.maxHolders))),
    maxSniperPct: numUi(ui, 'maxSniperPct', hostDefaults.maxSniperPct),
    maxDevHoldingPct: numUi(ui, 'maxDevHoldingPct', hostDefaults.maxDevHoldingPct),
    maxTopHolderPct: numUi(ui, 'maxTopHolderPct', hostDefaults.maxTopHolderPct),
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
    allowedLaunchpads: pads.length ? parseLaunchpads(pads) : hostDefaults.allowedLaunchpads,
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
