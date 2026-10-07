import { Chain, SkipReason, TxClassification } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { computeSignalStrength, marketCapTier, qualifySignal } from './qualify.js';
import { decodedBuy, market, portfolio, qualifyInput, strategyConfig, TOKEN_MINT } from './__tests__/fixtures.js';

describe('marketCapTier', () => {
  it('maps the classic $1M–$20M bands when that window is configured', () => {
    expect(marketCapTier(999_999)).toBeNull();
    expect(marketCapTier(1_000_000)).toBe(1);
    expect(marketCapTier(3_000_000)).toBe(1);
    expect(marketCapTier(3_000_001)).toBe(2);
    expect(marketCapTier(7_000_000)).toBe(2);
    expect(marketCapTier(7_000_001)).toBe(3);
    expect(marketCapTier(12_000_000)).toBe(3);
    expect(marketCapTier(12_000_001)).toBe(4);
    expect(marketCapTier(20_000_000)).toBe(4);
    expect(marketCapTier(20_000_001)).toBeNull();
  });

  it('qualifies sub-$1M tokens when the saved window includes them (e.g. $50K–$20M)', () => {
    const min = 50_000;
    const max = 20_000_000;
    expect(marketCapTier(139_278, min, max)).toBe(1);
    expect(marketCapTier(148_688, min, max)).toBe(1);
    expect(marketCapTier(49_999, min, max)).toBeNull();
    expect(marketCapTier(20_000_001, min, max)).toBeNull();
  });
});

describe('computeSignalStrength', () => {
  it('is 1.0 for a single trader and is capped at 1.5', () => {
    expect(computeSignalStrength(1)).toBe(1);
    expect(computeSignalStrength(2)).toBeGreaterThan(1);
    for (const n of [1, 2, 3, 8, 16, 64, 1_000]) {
      const strength = computeSignalStrength(n);
      expect(strength).toBeGreaterThanOrEqual(1);
      expect(strength).toBeLessThanOrEqual(1.5);
    }
    expect(computeSignalStrength(1_000, 1_000)).toBe(1.5);
  });
});

describe('qualifySignal', () => {
  it('qualifies a genuine first buy inside the market-cap window', () => {
    const result = qualifySignal(qualifyInput());
    expect(result).toEqual({
      qualified: true,
      signalStrength: 1,
      marketCapTier: 2,
    });
  });

  it('skips when emergency stop is engaged', () => {
    const result = qualifySignal(qualifyInput({ config: strategyConfig({ emergencyStop: true }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.TRADER_DISABLED);
  });

  it('skips when trading is disabled', () => {
    const result = qualifySignal(qualifyInput({ config: strategyConfig({ tradingEnabled: false }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.TRADER_DISABLED);
  });

  it('skips a monitor-only chain', () => {
    const result = qualifySignal(qualifyInput({ chainCanExecute: false }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.CHAIN_NOT_EXECUTABLE);
  });

  it('skips a chain that is not in the enabled list', () => {
    const result = qualifySignal(
      qualifyInput({
        decoded: decodedBuy({ chain: Chain.ETHEREUM }),
        config: strategyConfig({ enabledChains: [Chain.SOLANA] }),
      }),
    );
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.CHAIN_NOT_EXECUTABLE);
  });

  it.each([
    [TxClassification.SELL, SkipReason.IS_SELL],
    [TxClassification.AIRDROP, SkipReason.IS_AIRDROP],
    [TxClassification.TRANSFER_IN, SkipReason.IS_TRANSFER],
    [TxClassification.TRANSFER_OUT, SkipReason.IS_TRANSFER],
    [TxClassification.STAKE, SkipReason.IS_STAKING],
    [TxClassification.LP_ADD, SkipReason.IS_LP],
    [TxClassification.CLAIM, SkipReason.IS_CLAIM],
    [TxClassification.BRIDGE, SkipReason.IS_BRIDGE],
    [TxClassification.MIGRATION, SkipReason.IS_MIGRATION],
  ] as const)('maps %s to %s', (classification, reason) => {
    const result = qualifySignal(qualifyInput({ decoded: decodedBuy({ classification }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(reason);
  });

  it('skips a token-to-token rotation with no quote-asset spend', () => {
    const result = qualifySignal(qualifyInput({ spendLegIsQuoteAsset: false }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.NO_QUOTE_CURRENCY_SPENT);
  });

  it('skips a zero-spend buy (airdrop-shaped)', () => {
    const result = qualifySignal(
      qualifyInput({
        decoded: decodedBuy({
          tokenIn: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, amountRaw: '0' },
        }),
      }),
    );
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.NO_QUOTE_CURRENCY_SPENT);
  });

  it('skips a blacklisted token', () => {
    const result = qualifySignal(qualifyInput({ tokenBlacklisted: true }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.BLACKLISTED);
  });

  it('skips when decimals cannot be read', () => {
    const result = qualifySignal(
      qualifyInput({
        decoded: decodedBuy({
          tokenOut: { address: TOKEN_MINT, symbol: 'BONK', decimals: null, amountRaw: '1' },
        }),
      }),
    );
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.TOKEN_METADATA_UNAVAILABLE);
  });

  it('skips when market data is missing rather than guessing a cap', () => {
    const result = qualifySignal(qualifyInput({ market: market({ missing: true, marketCapUsd: null }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.TOKEN_METADATA_UNAVAILABLE);
  });

  it('skips market cap above the saved maximum', () => {
    const result = qualifySignal(qualifyInput({ market: market({ marketCapUsd: 21_000_000 }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.MARKET_CAP_TOO_HIGH);
  });

  it('skips market cap below the saved minimum', () => {
    const result = qualifySignal(qualifyInput({ market: market({ marketCapUsd: 500_000 }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.MARKET_CAP_TOO_LOW);
  });

  it('qualifies a $139K token when saved min is $50K (no hard-coded $1M floor)', () => {
    const result = qualifySignal(
      qualifyInput({
        config: strategyConfig({
          minMarketCapUsd: 50_000,
          maxMarketCapUsd: 20_000_000,
          minLiquidityUsd: 30_000,
        }),
        market: market({ marketCapUsd: 139_278, liquidityUsd: 32_300 }),
      }),
    );
    expect(result.qualified).toBe(true);
    if (result.qualified) expect(result.marketCapTier).toBe(1);
  });

  it('skips insufficient liquidity', () => {
    const result = qualifySignal(qualifyInput({ market: market({ liquidityUsd: 10_000 }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.INSUFFICIENT_LIQUIDITY);
  });

  it('skips unknown liquidity rather than treating it as unlimited', () => {
    const result = qualifySignal(qualifyInput({ market: market({ liquidityUsd: null }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.INSUFFICIENT_LIQUIDITY);
  });

  it('enforces first-buy-only: a later buy of the same token is skipped', () => {
    const result = qualifySignal(qualifyInput({ isFirstBuy: false }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.NOT_FIRST_BUY);
  });

  it('enforces one-token-one-position when a COPYRA position is already open', () => {
    const result = qualifySignal(qualifyInput({ portfolio: portfolio({ existingPositionForToken: true }) }));
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.POSITION_ALREADY_OPEN);
  });

  it('skips when the max open-position count is already reached', () => {
    const result = qualifySignal(
      qualifyInput({
        config: strategyConfig({ maxOpenPositions: 3 }),
        portfolio: portfolio({ openPositionCount: 3 }),
      }),
    );
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reason).toBe(SkipReason.MAX_POSITIONS_REACHED);
  });

  it('treats correlated traders as one token, raising strength only', () => {
    const first = qualifySignal(qualifyInput({ correlatedTraderCount: 1 }));
    const third = qualifySignal(qualifyInput({ correlatedTraderCount: 3 }));
    expect(first.qualified).toBe(true);
    expect(third.qualified).toBe(true);
    if (first.qualified && third.qualified) {
      expect(third.signalStrength).toBeGreaterThan(first.signalStrength);
      expect(third.signalStrength).toBeLessThanOrEqual(1.5);
      expect(third.marketCapTier).toBe(first.marketCapTier);
    }
  });
});
