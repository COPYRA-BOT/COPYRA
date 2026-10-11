import { SkipReason } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { qualifySniperToken } from './qualify.js';
import type { SniperConfig, SniperDiscoveryEvent, SniperEnrichment } from './types.js';

const baseConfig = (): SniperConfig => ({
  enabled: true,
  runtimeMode: 'live',
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
  maxMarketCapUsd: 20_000_000,
  minLiquidityUsd: 10_000,
  maxPriceImpactBps: 800,
  maxSlippageBps: 300,
  maxOpenPositions: 5,
  maxPositionSol: 0.5,
  maxDeployedSol: 5,
  dailyLossLimitSol: 2,
  allowedLaunchpads: ['pump.fun'],
  marketDataMaxAgeMs: 30_000,
  pumpFunProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  takeProfitPct: 20,
  stopLossPct: 10,
  exitStrategy: 'MANUAL',
  tradeAllocationPct: 20,
  reservePct: 20,
  minTradeUsd: 5,
  maxDeploymentPct: 80,
  engineOn: true,
  emergencyStop: false,
  tokenBlacklist: [],
});

const event = (): SniperDiscoveryEvent => ({
  launchpad: 'pump.fun',
  eventKind: 'create',
  sourceTxHash: 'Sig111',
  tokenAddress: 'Mint111111111111111111111111111111111111111',
  creatorAddress: 'Creator111',
  bondingState: 'bonding_curve',
  migrated: false,
  observedAt: new Date(),
  slot: 1,
});

const enrichOk = (): SniperEnrichment => ({
  symbol: 'TEST',
  name: 'Test',
  decimals: 6,
  priceUsd: 0.0001,
  marketCapUsd: 500_000,
  liquidityUsd: 25_000,
  volume24hUsd: 40_000,
  marketSource: 'dexscreener',
  marketAgeMs: 2_000,
  tokenAgeMin: 15,
  pairCreatedAt: new Date().toISOString(),
  imageUrl: null,
  hasTwitter: true,
  hasWebsite: true,
  hasTelegram: false,
  hasProfile: true,
  mintAuthority: null,
  freezeAuthority: null,
  topHolderPct: 12,
  holderCount: 200,
  devHoldingPct: 5,
  sniperPct: 18,
  migrated: false,
  swapActivityOk: true,
  buyRouteOk: true,
  sellRouteOk: true,
  executionRoute: 'jupiter',
  priceImpactBps: 120,
  expectedSlippageBps: 80,
  blacklistHit: false,
  enrichErrors: [],
});

describe('qualifySniperToken', () => {
  it('qualifies a fully enriched safe launch', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: enrichOk(),
      config: baseConfig(),
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0.1,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(true);
    if (result.qualified) expect(result.riskScore).toBeGreaterThan(0);
  });

  it('rejects when market data is missing (fail closed)', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: { ...enrichOk(), marketCapUsd: null, liquidityUsd: null },
      config: baseConfig(),
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.SNIPER_DATA_UNAVAILABLE);
  });

  it('rejects mint authority still set', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: { ...enrichOk(), mintAuthority: 'Auth111' },
      config: baseConfig(),
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.SNIPER_TOKEN_CONTROLS);
  });

  it('records monitor-only after filters pass', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: enrichOk(),
      config: { ...baseConfig(), runtimeMode: 'monitor' },
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
    if (!result.qualified) {
      expect(result.reason).toBe(SkipReason.SNIPER_DISABLED);
      expect(result.detail).toMatch(/passed filters/i);
    }
  });

  it('rejects old tokens when scope is NEW', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: { ...enrichOk(), tokenAgeMin: 999 },
      config: { ...baseConfig(), tokenScope: 'NEW', maxTokenAgeMin: 60 },
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.SNIPER_ACTIVITY);
  });

  it('rejects when sell route missing', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: { ...enrichOk(), sellRouteOk: false },
      config: baseConfig(),
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.SNIPER_NO_ROUTE);
  });

  it('rejects missing twitter when required', () => {
    const result = qualifySniperToken({
      event: event(),
      enrich: { ...enrichOk(), hasTwitter: false, hasProfile: true },
      config: { ...baseConfig(), requireTwitter: true },
      openSniperPositions: 0,
      existingSniperPositionForToken: false,
      deployedSol: 0,
      dailyLossSol: 0,
    });
    expect(result.qualified).toBe(false);
  });
});
