import { Chain } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { AllEndpointsFailedError, RpcPool } from './pool.js';

describe('RpcPool', () => {
  it('fails over to the next endpoint after the primary errors', async () => {
    let primaryHits = 0;
    const pool = new RpcPool<string>(
      { chain: Chain.SOLANA, urls: ['https://primary.example', 'https://fallback.example'] },
      (url) => url,
    );

    const result = await pool.call('getSlot', async (client) => {
      if (client.includes('primary')) {
        primaryHits += 1;
        throw new Error('primary down');
      }
      return 42;
    });

    expect(primaryHits).toBe(1);
    expect(result.value).toBe(42);
    expect(result.endpoint).toBe('https://fallback.example');
  });

  it('takes a repeatedly failing endpoint out of rotation', async () => {
    const pool = new RpcPool<string>(
      {
        chain: Chain.SOLANA,
        urls: ['https://dead.example', 'https://live.example'],
        failureThreshold: 2,
        cooldownMs: 60_000,
      },
      (url) => url,
    );

    await pool.call('a', async (client) => {
      if (client.includes('dead')) throw new Error('fail');
      return 1;
    });
    await pool.call('b', async (client) => {
      if (client.includes('dead')) throw new Error('fail');
      return 2;
    });

    const dead = pool.health().find((h) => h.safeUrl.includes('dead'));
    expect(dead?.healthy).toBe(false);
    expect(dead?.cooldownUntil).toBeGreaterThan(Date.now());

    // Third call should skip the dead primary entirely.
    let sawDead = false;
    await pool.call('c', async (client) => {
      if (client.includes('dead')) sawDead = true;
      return 3;
    });
    expect(sawDead).toBe(false);
  });

  it('throws AllEndpointsFailedError when every endpoint fails', async () => {
    const pool = new RpcPool<string>(
      { chain: Chain.BASE, urls: ['https://a.example', 'https://b.example'] },
      (url) => url,
    );
    await expect(pool.call('x', async () => {
      throw new Error('down');
    })).rejects.toBeInstanceOf(AllEndpointsFailedError);
  });

  it('never logs the raw URL with a query string', () => {
    const pool = new RpcPool<string>(
      { chain: Chain.SOLANA, urls: ['https://mainnet.helius-rpc.com/?api-key=should-not-appear'] },
      (url) => url,
    );
    const [state] = pool.health();
    expect(state?.safeUrl).toBe('https://mainnet.helius-rpc.com');
    expect(state?.safeUrl).not.toContain('should-not-appear');
  });
});
