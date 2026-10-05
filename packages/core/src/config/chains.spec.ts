import { Chain } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import {
  assertExecutable,
  ChainNotExecutableError,
  chainConfig,
  executableChains,
  explorerTxUrl,
} from './chains.js';

describe('chain registry', () => {
  it('marks Solana, Base, Arbitrum and BNB as executable when their RPC is configured', () => {
    const executable = new Set(executableChains().map((c) => c.chain));
    expect(executable.has(Chain.SOLANA)).toBe(true);
    expect(executable.has(Chain.BASE)).toBe(true);
    expect(executable.has(Chain.ARBITRUM)).toBe(true);
    expect(executable.has(Chain.BSC)).toBe(true);
  });

  it('refuses to execute on Arc, Robinhood, Hyperliquid and Tron', () => {
    for (const chain of [Chain.ARC, Chain.ROBINHOOD, Chain.HYPERLIQUID, Chain.TRON]) {
      expect(chainConfig(chain).canExecute).toBe(false);
      expect(chainConfig(chain).routeProvider).toBeNull();
      expect(() => assertExecutable(chain)).toThrow(ChainNotExecutableError);
    }
  });

  it('builds explorer URLs from the real chain + hash, never a generic placeholder', () => {
    expect(explorerTxUrl(Chain.SOLANA, 'Sig111')).toBe('https://solscan.io/tx/Sig111');
    expect(explorerTxUrl(Chain.BASE, '0xabc')).toBe('https://basescan.org/tx/0xabc');
    expect(explorerTxUrl(Chain.ARBITRUM, '0xabc')).toBe('https://arbiscan.io/tx/0xabc');
    expect(explorerTxUrl(Chain.BSC, '0xabc')).toBe('https://bscscan.com/tx/0xabc');
  });
});
