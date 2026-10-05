import { Chain } from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import type { MarketSnapshot } from '../engine/types.js';
import { componentLogger } from '../obs/logger.js';
import { getJupiterPrices } from '../solana/jupiter.js';
import { getDexscreenerMarket, getDexscreenerMarkets, type TokenMarketData } from './dexscreener.js';

const log = componentLogger('market');

export type { TokenMarketData };
export { getDexscreenerMarket, getDexscreenerMarkets };

/**
 * Unified market data.
 *
 * Dexscreener supplies market cap and liquidity. For Solana the price is
 * cross-checked against Jupiter's price feed, because Jupiter is the venue
 * COPYRA actually trades through — if the two disagree materially, the
 * aggregator's own number is the one that will determine the fill, so it wins
 * and the divergence is logged.
 */
const PRICE_DIVERGENCE_WARN_PCT = 5;

export async function getMarketSnapshot(
  chain: Chain,
  tokenAddress: string,
): Promise<TokenMarketData> {
  const dex = await getDexscreenerMarket(chain, tokenAddress);

  if (chain !== Chain.SOLANA || dex.missing) return dex;

  try {
    const prices = await getJupiterPrices([tokenAddress]);
    const jupiter = prices.get(tokenAddress);
    if (!jupiter) return dex;

    if (dex.priceUsd > 0) {
      const divergence = Math.abs((jupiter.usdPrice - dex.priceUsd) / dex.priceUsd) * 100;
      if (divergence > PRICE_DIVERGENCE_WARN_PCT) {
        log.warn(
          { tokenAddress, dexscreenerPrice: dex.priceUsd, jupiterPrice: jupiter.usdPrice, divergence },
          'Price sources diverge; using the Jupiter price because it determines the fill',
        );
      }
    }

    // Rescale market cap by the price ratio so cap and price stay consistent.
    const ratio = dex.priceUsd > 0 ? jupiter.usdPrice / dex.priceUsd : 1;
    return {
      ...dex,
      priceUsd: jupiter.usdPrice,
      marketCapUsd: dex.marketCapUsd !== null ? dex.marketCapUsd * ratio : null,
      fdvUsd: dex.fdvUsd !== null ? dex.fdvUsd * ratio : null,
      source: `${dex.source}+jupiter:price`,
    };
  } catch (error) {
    log.warn({ tokenAddress, err: error }, 'Jupiter price cross-check failed; using Dexscreener alone');
    return dex;
  }
}

/** USD price of a chain's quote asset. Required before any trade is sized. */
export async function getQuoteAssetPriceUsd(chain: Chain): Promise<number> {
  const config = chainConfig(chain);

  if (chain === Chain.SOLANA) {
    const prices = await getJupiterPrices([config.quoteAsset]);
    const price = prices.get(config.quoteAsset);
    if (!price) {
      throw new Error(
        `SOL price unavailable from Jupiter. A trade cannot be sized without the quote-asset price.`,
      );
    }
    return price.usdPrice;
  }

  const market = await getDexscreenerMarket(chain, config.quoteAsset);
  if (market.missing || market.priceUsd <= 0) {
    throw new Error(
      `${config.quoteAssetSymbol} price unavailable on ${chain}. A trade cannot be sized without the quote-asset price.`,
    );
  }
  return market.priceUsd;
}

export function emptySnapshot(source: string): MarketSnapshot {
  return {
    priceUsd: 0,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: null,
    volume24hUsd: null,
    source,
    fetchedAt: new Date(),
    missing: true,
  };
}
