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
      detail: 'Spend leg amount is zero — no value was exchanged (airdrop-like).',
    };
  }
  if (BigInt(decoded.tokenOut.amountRaw) <= 0n) {
    return {
      qualified: false,
      reason: SkipReason.NOT_A_BUY,
      detail: 'Receive leg amount is zero.',
    };
  }
  if (!input.spendLegIsQuoteAsset) {
    return {
      qualified: false,
      reason: SkipReason.NO_QUOTE_CURRENCY_SPENT,
      detail:
        `Spend leg ${decoded.tokenIn.address} is not a recognised quote asset. ` +
        'The spec requires real SOL/USDC/native expenditure, so token-to-token rotations are not copied.',
    };
  }

  // --- token safety --------------------------------------------------------
  if (input.tokenBlacklisted) {
    return {
      qualified: false,
      reason: SkipReason.BLACKLISTED,
      detail: 'Token is blacklisted.',
    };
  }
  if (decoded.tokenOut.decimals === null) {
    return {
      qualified: false,
      reason: SkipReason.TOKEN_METADATA_UNAVAILABLE,
      detail:
        'Token decimals could not be read from the contract. Decimals are never ' +
        'assumed, because a wrong value silently mis-sizes the trade.',
    };
  }

  // --- market data must exist; a missing market is a skip, not a guess -----
  if (market.missing || market.marketCapUsd === null) {
    return {
      qualified: false,
      reason: SkipReason.TOKEN_METADATA_UNAVAILABLE,
      detail: `No market data from ${market.source}; market cap cannot be validated.`,
    };
  }
  if (market.priceUsd <= 0) {
    return {
      qualified: false,
      reason: SkipReason.NOT_TRADABLE,
      detail: 'Market price is zero or negative.',
    };
  }

  // --- market-cap window from saved strategy settings (spec §4) -----------
  // The dashboard PATCH /api/settings row is the single source of truth the
  // worker reads — never a hard-coded $1M–$20M gate on top of the saved window.
  if (market.marketCapUsd > config.maxMarketCapUsd) {
    return {
      qualified: false,
      reason: SkipReason.MARKET_CAP_TOO_HIGH,
      detail: `Market cap $${Math.round(market.marketCapUsd).toLocaleString()} exceeds the saved $${Math.round(
        config.maxMarketCapUsd,
      ).toLocaleString()} maximum.`,
    };
  }
  if (market.marketCapUsd < config.minMarketCapUsd) {
    return {
      qualified: false,
      reason: SkipReason.MARKET_CAP_TOO_LOW,
      detail: `Market cap $${Math.round(market.marketCapUsd).toLocaleString()} is below the saved $${Math.round(
        config.minMarketCapUsd,
      ).toLocaleString()} minimum.`,
    };
  }

  const tier = marketCapTier(market.marketCapUsd, config.minMarketCapUsd, config.maxMarketCapUsd);
  if (tier === null) {
    // Window invalid (max <= min) — refuse rather than size with a guess.
    return {
      qualified: false,
      reason: SkipReason.MARKET_CAP_TOO_HIGH,
      detail:
        'Saved market-cap window is invalid (min must be below max). Update settings and save again.',
    };
  }

  // --- liquidity (spec §12) ------------------------------------------------
  if (market.liquidityUsd === null) {
    return {
      qualified: false,
      reason: SkipReason.INSUFFICIENT_LIQUIDITY,
      detail: 'Liquidity is unknown; trading into an unmeasurable pool is refused.',
    };
  }
  if (market.liquidityUsd < config.minLiquidityUsd) {
    return {
      qualified: false,
      reason: SkipReason.INSUFFICIENT_LIQUIDITY,
      detail: `Liquidity $${Math.round(market.liquidityUsd).toLocaleString()} is below the $${Math.round(
        config.minLiquidityUsd,
      ).toLocaleString()} minimum.`,
    };
  }

  // --- one-position-per-token (always) + optional first-buy-only ----------
  if (portfolio.existingPositionForToken) {
    return {
      qualified: false,
      reason: SkipReason.POSITION_ALREADY_OPEN,
      detail: 'A COPYRA position in this token is already open. One token = one position.',
    };
  }
  // Saved strategy setting: firstBuyOnly (default) vs every qualifying buy.
  if (config.firstBuyOnly && !input.isFirstBuy) {
    return {
      qualified: false,
      reason: SkipReason.NOT_FIRST_BUY,
      detail:
        'First-buy-only mode is on: this account already copied this token. ' +
        'Switch settings to “Every buy” to allow re-entry after the position closes.',
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
