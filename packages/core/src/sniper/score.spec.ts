import { describe, expect, it } from 'vitest';
import type { SniperEnrichment } from './types.js';
import {
  computeSniperEntryScore,
  discoveryStatusFor,
  SNIPER_AUTO_EXEC_MIN_SCORE,
} from './score.js';

function enrich(partial: Partial<SniperEnrichment> = {}): SniperEnrichment {
  return {
    symbol: 'TEST',
    name: 'Test',
    decimals: 6,
    priceUsd: 0.001,
    marketCapUsd: 180_000,
    liquidityUsd: 94_000,
    volume24hUsd: 320_000,
    marketSource: 'dexscreener',
    marketAgeMs: 1_000,
    tokenAgeMin: 12,
    pairCreatedAt: null,
    imageUrl: null,
    hasTwitter: true,
    hasWebsite: true,
    hasTelegram: false,
    hasProfile: true,
    mintAuthority: 'none',
    freezeAuthority: 'none',
    holderCount: 1_240,
    topHolderPct: 18,
    devHoldingPct: 4,
    sniperPct: 12,
    migrated: false,
    swapActivityOk: true,
    buyRouteOk: true,
    sellRouteOk: true,
    executionRoute: 'jupiter',
    priceImpactBps: 100,
    expectedSlippageBps: 80,
    blacklistHit: false,
    enrichErrors: [],
    ...partial,
  };
}

describe('computeSniperEntryScore', () => {
  it('scores a strong launch at or above auto-exec threshold', () => {
    expect(computeSniperEntryScore(enrich())).toBeGreaterThanOrEqual(SNIPER_AUTO_EXEC_MIN_SCORE);
  });

  it('scores a weak launch below threshold', () => {
    expect(
      computeSniperEntryScore(
        enrich({
          liquidityUsd: 8_000,
          marketCapUsd: 30_000,
          volume24hUsd: 2_000,
          holderCount: 40,
          sniperPct: 55,
          topHolderPct: 60,
          hasTwitter: false,
          hasWebsite: false,
          buyRouteOk: false,
          sellRouteOk: false,
        }),
      ),
    ).toBeLessThan(SNIPER_AUTO_EXEC_MIN_SCORE);
  });
});

describe('discoveryStatusFor', () => {
  it('maps score bands', () => {
    expect(discoveryStatusFor({ entryScore: 91, qualified: true, rejected: false })).toBe(
      'ENTRY_SIGNAL',
    );
    expect(discoveryStatusFor({ entryScore: 70, qualified: false, rejected: false })).toBe(
      'ACCUMULATION',
    );
    expect(discoveryStatusFor({ entryScore: 40, qualified: false, rejected: false })).toBe(
      'WATCHING',
    );
    expect(discoveryStatusFor({ entryScore: 40, qualified: false, rejected: true })).toBe(
      'REJECTED',
    );
  });
});
