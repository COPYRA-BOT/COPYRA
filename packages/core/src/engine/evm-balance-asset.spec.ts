import { describe, expect, it } from 'vitest';
import { Chain } from '@copyra/db';
import { chainConfig } from '../config/chains.js';

/**
 * Locks the dashboard balance asset: EVM custody reads USDC (stableAsset),
 * never native BNB/ETH mislabeled as trading balance.
 */
describe('EVM trading balance asset', () => {
  it('Ethereum / Base / Arbitrum / BSC expose USDC stableAsset for custody reads', () => {
    for (const chain of [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC]) {
      const config = chainConfig(chain);
      expect(config.kind).toBe('evm');
      expect(config.stableAsset).toBeTruthy();
      expect(config.stableAssetSymbol).toBe('USDC');
      expect(config.stableAssetDecimals).toBeGreaterThan(0);
      // Native gas symbol must not be the dashboard trading unit.
      expect(config.nativeSymbol).not.toBe('USDC');
    }
  });

  it('BSC USDC uses 18 decimals (Binance-Peg); Ethereum/Base/Arb use 6', () => {
    expect(chainConfig(Chain.BSC).stableAssetDecimals).toBe(18);
    expect(chainConfig(Chain.ETHEREUM).stableAssetDecimals).toBe(6);
    expect(chainConfig(Chain.BASE).stableAssetDecimals).toBe(6);
    expect(chainConfig(Chain.ARBITRUM).stableAssetDecimals).toBe(6);
    expect(chainConfig(Chain.ETHEREUM).nativeSymbol).toBe('ETH');
    expect(chainConfig(Chain.ETHEREUM).stableAsset?.toLowerCase()).toBe(
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    );
  });
});
