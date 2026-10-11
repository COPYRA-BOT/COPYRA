import { SkipReason, TxClassification } from '@copyra/db';
import type {
  MarketCapTier,
  QualificationInput,
  QualificationResult,
} from './types.js';

/**
 * Maps a non-BUY classification to the specific skip reason the spec asks for,
 * so the Telegram "Trade skipped" notification can say exactly why rather than
 * a generic "not a buy".
 */
const CLASSIFICATION_SKIP: Partial<Record<TxClassification, SkipReason>> = {
  SELL: SkipReason.IS_SELL,
  AIRDROP: SkipReason.IS_AIRDROP,
  TRANSFER_IN: SkipReason.IS_TRANSFER,
  TRANSFER_OUT: SkipReason.IS_TRANSFER,
  STAKE: SkipReason.IS_STAKING,
  UNSTAKE: SkipReason.IS_STAKING,
  LP_ADD: SkipReason.IS_LP,
  LP_REMOVE: SkipReason.IS_LP,
  CLAIM: SkipReason.IS_CLAIM,
  BRIDGE: SkipReason.IS_BRIDGE,
  MIGRATION: SkipReason.IS_MIGRATION,
};

/**
 * Classic spec §7 band edges as fractions of the configured [min, max] window.
 * For the default $1M–$20M window these map to $1–3M / $3–7M / $7–12M / $12–20M.
 * When the operator saves a different window (e.g. $50K–$20M), the same relative
 * bands stretch to fill that window so tokens inside the saved min/max always
 * receive a sizing tier — they are never rejected for "outside hard-coded tiers".
 */
const TIER_RELATIVE_EDGES = [0, 2 / 19, 6 / 19, 11 / 19, 1] as const;

/**
 * Market-cap sizing tier within the operator's saved [minMarketCapUsd, maxMarketCapUsd]
 * window. Returns null only when market cap is outside that window (or the window
 * is invalid). Callers that already enforced min/max should always get a tier.
 */
export function marketCapTier(
  marketCapUsd: number,
  minMarketCapUsd = 1_000_000,
  maxMarketCapUsd = 20_000_000,
): MarketCapTier | null {
  if (!(maxMarketCapUsd > minMarketCapUsd)) return null;
  if (marketCapUsd < minMarketCapUsd || marketCapUsd > maxMarketCapUsd) return null;

  const span = maxMarketCapUsd - minMarketCapUsd;
  const rel = (marketCapUsd - minMarketCapUsd) / span;
  if (rel <= TIER_RELATIVE_EDGES[1]) return 1;
  if (rel <= TIER_RELATIVE_EDGES[2]) return 2;
  if (rel <= TIER_RELATIVE_EDGES[3]) return 3;
  return 4;
}

/**
 * Signal strength from correlated traders (spec §6).
 *
 * Deliberately sub-linear and capped. Correlated buys raise *confidence* only;
 * they must never multiply capital allocation. The sizing function applies this
 * as a scale factor strictly between 1.0 and 1.5 of the tier cap's lower bound,
 * and the tier cap remains a hard ceiling above it.
 */
export function computeSignalStrength(correlatedTraderCount: number, weightSum = 1): number {
  const n = Math.max(1, correlatedTraderCount);
  const raw = 1 + Math.log2(n) * 0.25 * Math.max(0.1, weightSum / n);
  return Math.min(1.5, Math.round(raw * 1000) / 1000);
}

/**
 * The full qualification gate (spec §4, §5, §6, §9, §12).
 *
 * Pure: no I/O, no clock reads beyond what is passed in. Every branch returns a
 * machine-readable `SkipReason` plus human detail. There is no partial pass —
 * any failing condition skips the trade entirely.
 *
 * Order matters: cheap local checks precede anything that cost an RPC call, so
 * the common rejection paths are as fast as possible.
 */
export function qualifySignal(input: QualificationInput): QualificationResult {
  const { decoded, market, config, portfolio } = input;

  // --- kill switches -------------------------------------------------------
  if (config.emergencyStop) {
    return {
      qualified: false,
      reason: SkipReason.TRADER_DISABLED,
      detail: 'Emergency stop is engaged; no new positions are opened.',
    };
  }
  if (!config.tradingEnabled) {
    return {
      qualified: false,
      reason: SkipReason.TRADER_DISABLED,
      detail: 'Trading is disabled in strategy settings.',
    };
  }
  if (!input.traderEnabled) {
    return {
      qualified: false,
      reason: SkipReason.TRADER_DISABLED,
      detail: 'The source trader is disabled.',
    };
  }

  // --- chain ---------------------------------------------------------------
  if (!config.enabledChains.includes(decoded.chain)) {
    return {
      qualified: false,
      reason: SkipReason.CHAIN_NOT_EXECUTABLE,
      detail: `${decoded.chain} is not in the enabled-chain list.`,
    };
  }
  if (!input.chainCanExecute) {
    return {
      qualified: false,
      reason: SkipReason.CHAIN_NOT_EXECUTABLE,
      detail: `${decoded.chain} is monitor-only: no verified swap route provider.`,
    };
  }

  // --- classification: must be a genuine buy -------------------------------
  if (decoded.classification !== TxClassification.BUY) {
    const mapped = CLASSIFICATION_SKIP[decoded.classification] ?? SkipReason.NOT_A_BUY;
    return {
      qualified: false,
      reason: mapped,
      detail: `Classified as ${decoded.classification}: ${decoded.classificationBasis}`,
    };
  }

  // A buy must have an inbound token leg and an outbound spend leg. Without
  // both, the decoder could not prove value was actually exchanged.
  if (!decoded.tokenOut || !decoded.tokenIn) {
    return {
      qualified: false,
      reason: SkipReason.NO_QUOTE_CURRENCY_SPENT,
      detail: 'Decoder did not find both a spend leg and a receive leg.',
    };
  }
  if (BigInt(decoded.tokenIn.amountRaw) <= 0n) {
    return {
      qualified: false,
      reason: SkipReason.NO_QUOTE_CURRENCY_SPENT,
      detail: 'Spend leg amount is zero. No value was exchanged (likely an airdrop).',
    };
  }
  if (BigInt(decoded.tokenOut.amountRaw) <= 0n) {
    return {
      qualified: false,
      reason: SkipReason.NOT_A_BUY,
      detail: 'Receive leg amount is zero.',
    };
  }
  // Token→token rotations (e.g. meme→meme scale-ins) are copyable buy signals:
  // COPYRA always spends the chain quote asset (SOL/USDC) from custody. Market /
  // liq / MC gates below still apply. Zero / missing spend legs above remain
  // skips (airdrops). `spendLegIsQuoteAsset` is retained for telemetry only.

  // --- token safety --------------------------------------------------------
  if (input.tokenBlacklisted) {
    return {
      qualified: false,
      reason: SkipReason.BLACKLISTED,
      detail: 'Token is blacklisted.',
    };
  }
  // Decimals missing: Solana memes (pump) are almost always 6; EVM defaults to 18.
  // Refusing here was skipping real copyable buys while the watched wallet filled.
  // Executor still sizes from quote-asset spend; wrong decimals only affect display.
  if (decoded.tokenOut.decimals === null) {
    /* allow — copy path does not need mint decimals to spend SOL/ETH */
  }

  // --- market data ---------------------------------------------------------
  // Missing Dexscreener/Jupiter MC used to hard-skip as TOKEN_METADATA_UNAVAILABLE
  // and cost real copy fills. When MC is unknown we still copy (mid tier); when
  // MC is known we still enforce the saved window. Price=0 alone is not a skip
  // either — the aggregator quote will fail closed if the token is untradeable.
  const mcKnown =
    !market.missing &&
    market.marketCapUsd !== null &&
    Number.isFinite(market.marketCapUsd) &&
    (market.marketCapUsd as number) > 0;

  let tier: MarketCapTier = 2;
  if (mcKnown) {
    const mc = market.marketCapUsd as number;
    if (mc > config.maxMarketCapUsd) {
      return {
        qualified: false,
        reason: SkipReason.MARKET_CAP_TOO_HIGH,
        detail: `Market cap $${Math.round(mc).toLocaleString()} exceeds the saved $${Math.round(
          config.maxMarketCapUsd,
        ).toLocaleString()} maximum.`,
      };
    }
    if (mc < config.minMarketCapUsd) {
      return {
        qualified: false,
        reason: SkipReason.MARKET_CAP_TOO_LOW,
        detail: `Market cap $${Math.round(mc).toLocaleString()} is below the saved $${Math.round(
          config.minMarketCapUsd,
        ).toLocaleString()} minimum.`,
      };
    }
    const computed = marketCapTier(mc, config.minMarketCapUsd, config.maxMarketCapUsd);
    if (computed === null) {
      return {
        qualified: false,
        reason: SkipReason.MARKET_CAP_TOO_HIGH,
        detail:
          'Saved market-cap window is invalid (min must be below max). Update settings and save again.',
      };
    }
    tier = computed;
  }

  // --- liquidity (spec §12) ------------------------------------------------
  // Unknown liquidity is allowed (new launches / slow indexers). Known liquidity
  // below the saved minimum still skips.
  if (market.liquidityUsd !== null && market.liquidityUsd < config.minLiquidityUsd) {
    return {
      qualified: false,
      reason: SkipReason.INSUFFICIENT_LIQUIDITY,
      detail: `Liquidity $${Math.round(market.liquidityUsd).toLocaleString()} is below the $${Math.round(
        config.minLiquidityUsd,
      ).toLocaleString()} minimum.`,
    };
  }

  // --- buy mode: first buy of the watched trader vs every buy -------------
  // First buy only → copy only that trader's first BUY of this token.
  if (config.firstBuyOnly && !input.isFirstBuy) {
    return {
      qualified: false,
      reason: SkipReason.NOT_FIRST_BUY,
      detail:
        'First-buy-only mode: this watched trader already bought this token earlier. ' +
        'Only their first buy is copied. Switch to “Every buy” to copy additional buys of the same token.',
    };
  }
  // First-buy-only also refuses a second open book entry. Every-buy may scale
  // into an existing open position in the same token.
  if (portfolio.existingPositionForToken && config.firstBuyOnly) {
    return {
      qualified: false,
      reason: SkipReason.POSITION_ALREADY_OPEN,
      detail: 'A COPYRA position in this token is already open. First-buy-only keeps one position per token.',
    };
  }

  // --- position count (spec §9) -------------------------------------------
  if (portfolio.openPositionCount >= config.maxOpenPositions) {
    return {
      qualified: false,
      reason: SkipReason.MAX_POSITIONS_REACHED,
      detail: `${portfolio.openPositionCount}/${config.maxOpenPositions} positions already open.`,
    };
  }

  return {
    qualified: true,
    signalStrength: computeSignalStrength(input.correlatedTraderCount),
    marketCapTier: tier,
  };
}
