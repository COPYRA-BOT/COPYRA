import type { Chain } from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import type { MarketSnapshot } from '../engine/types.js';
import { componentLogger } from '../obs/logger.js';
import { fetchJson, withRetry } from '../util/retry.js';

const log = componentLogger('dexscreener');

/**
 * Dexscreener market data.
 *
 * Used for market cap and pool liquidity, which Jupiter's price endpoint does
 * not provide for arbitrary tokens and which no RPC exposes directly. The
 * deepest pool by USD liquidity is selected, because that is the pool a swap
 * will actually route through and therefore the one whose liquidity constrains
 * the trade.
 *
 * When Dexscreener has no pair for a token, the snapshot is returned with
 * `missing: true` and the qualifier skips the trade. It never falls back to a
 * guessed market cap.
 */

const BASE_URL = 'https://api.dexscreener.com';

interface DexscreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

export interface TokenMarketData extends MarketSnapshot {
  symbol: string | null;
  name: string | null;
  dexId: string | null;
  pairAddress: string | null;
  pairCreatedAt: Date | null;
}

/** Short TTL cache so exit ticks and dual Solana lookups do not re-hit Dexscreener every tick. */
const MARKET_CACHE_TTL_MS = 2_000;
const marketCache = new Map<string, { at: number; value: TokenMarketData }>();

export async function getDexscreenerMarket(
  chain: Chain,
  tokenAddress: string,
): Promise<TokenMarketData> {
  const cacheKey = `${chain}:${tokenAddress.toLowerCase()}`;
  const cached = marketCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MARKET_CACHE_TTL_MS) {
    return cached.value;
  }

  const slug = chainConfig(chain).dexscreenerSlug;
  const fetchedAt = new Date();

  const empty: TokenMarketData = {
    priceUsd: 0,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    source: 'dexscreener',
    fetchedAt,
    missing: true,
    symbol: null,
    name: null,
    dexId: null,
    pairAddress: null,
    pairCreatedAt: null,
  };

  if (!slug) {
    return {
      ...empty,
      source: 'dexscreener (chain unsupported)',
    };
  }

  let pairs: DexscreenerPair[];
  try {
    const { data } = await withRetry(
      () =>
        fetchJson<{ pairs: DexscreenerPair[] | null }>(
          `${BASE_URL}/latest/dex/tokens/${tokenAddress}`,
          { timeoutMs: 2_000, label: 'dexscreener/tokens' },
        ),
      { attempts: 2, baseDelayMs: 50 },
    );
    pairs = data.pairs ?? [];
  } catch (error) {
    log.warn({ chain, tokenAddress, err: error }, 'Dexscreener lookup failed');
    return { ...empty, source: 'dexscreener (unavailable)' };
  }

  const onChain = pairs.filter((p) => p.chainId === slug);
  if (onChain.length === 0) {
    marketCache.set(cacheKey, { at: Date.now(), value: empty });
    return empty;
  }

  // Deepest pool: the one a swap will route through.
  const best = onChain.reduce((a, b) =>
    (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
  );

  const priceUsd = Number.parseFloat(best.priceUsd ?? '0');

  // Aggregate liquidity across all pools for this token on this chain: a token
  // may be split over several pools and the aggregator will route across them.
  const totalLiquidityUsd = onChain.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);

  const snapshot: TokenMarketData = {
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    // Prefer circulating market cap; fall back to FDV, which is what most
    // low-cap launches report, and record which one was used.
    marketCapUsd: best.marketCap ?? best.fdv ?? null,
    fdvUsd: best.fdv ?? null,
    liquidityUsd: totalLiquidityUsd > 0 ? totalLiquidityUsd : null,
    volume24hUsd: onChain.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0) || null,
    source: best.marketCap ? 'dexscreener:marketCap' : 'dexscreener:fdv',
    fetchedAt,
    missing: false,
    symbol: best.baseToken.symbol ?? null,
    name: best.baseToken.name ?? null,
    dexId: best.dexId,
    pairAddress: best.pairAddress,
    pairCreatedAt: best.pairCreatedAt ? new Date(best.pairCreatedAt) : null,
  };
  marketCache.set(cacheKey, { at: Date.now(), value: snapshot });
  return snapshot;
}

/** Batched variant for the position monitor, which marks many tokens per tick. */
export async function getDexscreenerMarkets(
  chain: Chain,
  addresses: string[],
): Promise<Map<string, TokenMarketData>> {
  const out = new Map<string, TokenMarketData>();
  if (addresses.length === 0) return out;

  const slug = chainConfig(chain).dexscreenerSlug;
  if (!slug) return out;

  // The endpoint accepts up to 30 comma-separated addresses.
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    try {
      const { data } = await fetchJson<{ pairs: DexscreenerPair[] | null }>(
        `${BASE_URL}/latest/dex/tokens/${chunk.join(',')}`,
        { timeoutMs: 6_000, label: 'dexscreener/tokens-batch' },
      );
      const fetchedAt = new Date();
      const byToken = new Map<string, DexscreenerPair[]>();

      for (const pair of data.pairs ?? []) {
        if (pair.chainId !== slug) continue;
        const key = pair.baseToken.address.toLowerCase();
        const list = byToken.get(key) ?? [];
        list.push(pair);
        byToken.set(key, list);
      }

      for (const address of chunk) {
        const list = byToken.get(address.toLowerCase());
        if (!list || list.length === 0) continue;
        const best = list.reduce((a, b) =>
          (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
        );
        const priceUsd = Number.parseFloat(best.priceUsd ?? '0');
        out.set(address.toLowerCase(), {
          priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
          marketCapUsd: best.marketCap ?? best.fdv ?? null,
          fdvUsd: best.fdv ?? null,
          liquidityUsd: list.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0) || null,
          volume24hUsd: list.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0) || null,
          source: best.marketCap ? 'dexscreener:marketCap' : 'dexscreener:fdv',
          fetchedAt,
          missing: false,
          symbol: best.baseToken.symbol ?? null,
          name: best.baseToken.name ?? null,
          dexId: best.dexId,
          pairAddress: best.pairAddress,
          pairCreatedAt: best.pairCreatedAt ? new Date(best.pairCreatedAt) : null,
        });
      }
    } catch (error) {
      log.warn({ chain, count: chunk.length, err: error }, 'Batched Dexscreener lookup failed');
    }
  }
  return out;
}
