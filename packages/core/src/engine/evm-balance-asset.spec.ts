import { describe, expect, it } from 'vitest';
import { Chain } from '@copyra/db';
import { chainConfig } from '../config/chains.js';

/**
 * Locks the dashboard balance asset: EVM custody reads USDC (stableAsset),
 * never native BNB/ETH mislabeled as trading balance.
 */
describe('EVM trading balance asset', () => {
  it('Base / Arbitrum / BSC expose USDC stableAsset for custody reads', () => {
    for (const chain of [Chain.BASE, Chain.ARBITRUM, Chain.BSC]) {
      const config = chainConfig(chain);
      expect(config.kind).toBe('evm');
      expect(config.stableAsset).toBeTruthy();
      expect(config.stableAssetSymbol).toBe('USDC');
      expect(config.stableAssetDecimals).toBeGreaterThan(0);
      // Native gas symbol must not be the dashboard trading unit.
      expect(config.nativeSymbol).not.toBe('USDC');
    }
  });

  it('BSC USDC uses 18 decimals (Binance-Peg); Base/Arb use 6', () => {
    expect(chainConfig(Chain.BSC).stableAssetDecimals).toBe(18);
    expect(chainConfig(Chain.BASE).stableAssetDecimals).toBe(6);
    expect(chainConfig(Chain.ARBITRUM).stableAssetDecimals).toBe(6);
  });
});
