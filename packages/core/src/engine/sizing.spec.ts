import { SkipReason } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { calculatePositionSize } from './sizing.js';
import { market, portfolio, strategyConfig } from './__tests__/fixtures.js';

function size(overrides: Parameters<typeof calculatePositionSize>[0] extends infer T ? Partial<T> : never) {
  return calculatePositionSize({
    config: strategyConfig(),
    portfolio: portfolio(),
    market: market(),
    tier: 2,
    signalStrength: 1,
    absoluteMaxUsd: 10_000,
    ...overrides,
  });
}

describe('calculatePositionSize', () => {
  it('never consumes the protected reserve', () => {
    // $600 trading balance, 20% reserve = $120 locked, $480 available.
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 5, quotePriceUsd: 120, deployedUsd: 0 }),
      absoluteMaxUsd: 10_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.basis.reserveUsd).toBe(120);
      expect(result.basis.availableUsd).toBe(480);
      expect(result.sizeUsd).toBeLessThanOrEqual(480);
    }
  });

  it('caps by trade allocation % of available balance', () => {
    // $1000 balance, 20% reserve → $800 available; 25% alloc → $200 ceiling.
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 10, quotePriceUsd: 100, deployedUsd: 0 }),
      config: strategyConfig({
        reservePct: 20,
        tradeAllocationPct: 25,
        maxDeploymentPct: 100,
        tier1MaxPct: 100,
        tier2MaxPct: 100,
        tier3MaxPct: 100,
        tier4MaxPct: 100,
        minTradeUsd: 1,
      }),
      absoluteMaxUsd: 10_000,
      signalStrength: 1.5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizeUsd).toBeLessThanOrEqual(200.0001);
      expect(result.basis.bindingConstraint).toMatch(/trade allocation/i);
    }
  });

  it('skips when the entire balance sits inside the reserve', () => {
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 0.05, quotePriceUsd: 120 }),
      config: strategyConfig({ reservePct: 100, minTradeUsd: 10 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(SkipReason.RESERVE_PROTECTED);
  });

  it('caps by the 80% max-deployment headroom', () => {
    const result = size({
      portfolio: portfolio({
        tradingBalanceQuote: 10,
        quotePriceUsd: 100,
        deployedUsd: 800,
      }),
      absoluteMaxUsd: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(SkipReason.MAX_DEPLOYMENT_REACHED);
  });

  it('applies the spec market-cap tier percentages as hard ceilings', () => {
    const balance = portfolio({ tradingBalanceQuote: 10, quotePriceUsd: 100 });
    const t1 = size({ tier: 1, portfolio: balance, signalStrength: 1.5, absoluteMaxUsd: 10_000 });
    const t4 = size({ tier: 4, portfolio: balance, signalStrength: 1.5, absoluteMaxUsd: 10_000 });
    expect(t1.ok && t4.ok).toBe(true);
    if (t1.ok && t4.ok) {
      expect(t1.basis.tierMaxPct).toBe(20);
      expect(t4.basis.tierMaxPct).toBe(50);
      expect(t1.sizeUsd).toBeLessThanOrEqual(200);
      expect(t4.sizeUsd).toBeLessThanOrEqual(500);
      expect(t4.sizeUsd).toBeGreaterThan(t1.sizeUsd);
    }
  });

  it('never lets signal strength raise the size above the tier cap', () => {
    const result = size({
      tier: 1,
      signalStrength: 99,
      portfolio: portfolio({ tradingBalanceQuote: 10, quotePriceUsd: 100 }),
      absoluteMaxUsd: 10_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizeUsd).toBeLessThanOrEqual(result.basis.tierCapUsd);
    }
  });

  it('caps by 1% of pool liquidity', () => {
    const result = size({
      market: market({ liquidityUsd: 8_000 }),
      portfolio: portfolio({ tradingBalanceQuote: 50, quotePriceUsd: 100 }),
      absoluteMaxUsd: 10_000,
      config: strategyConfig({ minTradeUsd: 10, minLiquidityUsd: 1 }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizeUsd).toBeCloseTo(80, 6);
      expect(result.basis.bindingConstraint).toContain('liquidity');
    }
  });

  it('honours the operator absolute max below every other ceiling', () => {
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 50, quotePriceUsd: 100 }),
      absoluteMaxUsd: 25,
      market: market({ liquidityUsd: 10_000_000 }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizeUsd).toBe(25);
      expect(result.basis.bindingConstraint).toContain('absolute');
    }
  });

  it('skips when the largest safe size is below the minimum trade', () => {
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 0.2, quotePriceUsd: 100 }),
      config: strategyConfig({ minTradeUsd: 50, reservePct: 20 }),
      absoluteMaxUsd: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([SkipReason.INSUFFICIENT_BALANCE, SkipReason.BELOW_MIN_TRADE_SIZE]).toContain(result.reason);
    }
  });

  it('refuses to size without a quote-asset USD price', () => {
    const result = size({
      portfolio: portfolio({ quotePriceUsd: 0 }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(SkipReason.RPC_UNAVAILABLE);
  });

  it('records every input in the sizing basis so a decision is auditable', () => {
    const result = size({
      portfolio: portfolio({ tradingBalanceQuote: 5, quotePriceUsd: 120 }),
      absoluteMaxUsd: 25,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.basis.tradingBalanceUsd).toBe(600);
      expect(result.basis.reservePct).toBe(20);
      expect(result.basis.chosenUsd).toBe(result.sizeUsd);
      expect(result.sizeQuote).toBeCloseTo(result.sizeUsd / 120, 8);
    }
  });
});
