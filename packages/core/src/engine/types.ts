import type { Chain, ExitStrategy, SkipReason, TxClassification } from '@copyra/db';

/** Market facts, always sourced from a real market-data provider. */
export interface MarketSnapshot {
  priceUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  source: string;
  fetchedAt: Date;
  /** True when the provider had no pair for this token at all. */
  missing: boolean;
}

/** Output of the chain decoder for one monitored-wallet transaction. */
export interface DecodedTransaction {
  chain: Chain;
  txHash: string;
  traderAddress: string;
  blockNumber: bigint | null;
  blockTime: Date | null;
  classification: TxClassification;
  venue: string | null;
  tokenIn: DecodedLeg | null;
  tokenOut: DecodedLeg | null;
  feeRaw: string | null;
  /** Reason the decoder chose this classification. Logged for auditability. */
  classificationBasis: string;
  raw: Record<string, unknown>;
}

export interface DecodedLeg {
  address: string;
  symbol: string | null;
  decimals: number | null;
  amountRaw: string;
}

export interface StrategyConfig {
  tradingEnabled: boolean;
  emergencyStop: boolean;
  exitStrategy: ExitStrategy;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  maxDeploymentPct: number;
  tier1MaxPct: number;
  tier2MaxPct: number;
  tier3MaxPct: number;
  tier4MaxPct: number;
  maxOpenPositions: number;
  reservePct: number;
  minTradeUsd: number;
  maxSlippageBps: number;
  maxPriceImpactPct: number;
  minLiquidityUsd: number;
  quoteMaxAgeMs: number;
  confirmTimeoutMs: number;
  maxExecutionAttempts: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingTriggerPct: number;
  trailingPartialSellPct: number;
  trailingDropPct: number;
  followTraderSells: boolean;
  /**
   * When true, only the watched trader's first buy of a token is copied;
   * their later buys of the same token are skipped. When false (Every buy),
   * additional buys of the same token may be copied (including scale-in).
   */
  firstBuyOnly: boolean;
  /**
   * % of available (post-reserve) balance allowed as a per-trade ceiling.
   * Dashboard "Trade allocation". Does not change tier math — only adds a cap.
   */
  tradeAllocationPct: number;
  enabledChains: Chain[];
}

/** Live account state, read from the chain — never a running tally. */
export interface PortfolioState {
  /** Trading-bucket balance of the chain's quote asset, in quote units. */
  tradingBalanceQuote: number;
  /** USD price of the quote asset at read time. */
  quotePriceUsd: number;
  /** USD value currently deployed into open positions. */
  deployedUsd: number;
  openPositionCount: number;
  /** Open position in this exact token, if any. */
  existingPositionForToken: boolean;
  /** Block/slot the balance was read at, for staleness checks. */
  readAtBlock: bigint | null;
  readAt: Date;
}

export interface QualificationInput {
  decoded: DecodedTransaction;
  market: MarketSnapshot;
  config: StrategyConfig;
  portfolio: PortfolioState;
  traderEnabled: boolean;
  tokenBlacklisted: boolean;
  /**
   * True when this is the watched trader's first observed BUY of this token
   * (no earlier BUY detection for the same trader + token).
   */
  isFirstBuy: boolean;
  chainCanExecute: boolean;
  /** How many monitored traders have bought this token, including this one. */
  correlatedTraderCount: number;
  /**
   * True when the spend leg is a recognised quote asset (SOL/USDC/USDT on
   * Solana, wrapped-native/USDC on EVM). A token-to-token swap is a buy of the
   * received side, but the spec requires real quote-currency expenditure, so it
   * used to hard-skip as NO_QUOTE; non-quote spends are now still copyable
   * (custody always spends the chain quote asset). Kept for telemetry.
   */
  spendLegIsQuoteAsset: boolean;
}

export type QualificationResult =
  | {
      qualified: true;
      signalStrength: number;
      marketCapTier: MarketCapTier;
    }
  | {
      qualified: false;
      reason: SkipReason;
      detail: string;
    };

export type MarketCapTier = 1 | 2 | 3 | 4;

export interface SizingInput {
  config: StrategyConfig;
  portfolio: PortfolioState;
  market: MarketSnapshot;
  tier: MarketCapTier;
  signalStrength: number;
  /** Hard ceiling from MAX_TRADE_USD, applied below everything else. */
  absoluteMaxUsd: number;
}

export type SizingResult =
  | {
      ok: true;
      sizeQuote: number;
      sizeUsd: number;
      basis: SizingBasis;
    }
  | {
      ok: false;
      reason: SkipReason;
      detail: string;
      basis: SizingBasis;
    };

/** Every number that fed the size decision, persisted for audit. */
export interface SizingBasis {
  tradingBalanceQuote: number;
  quotePriceUsd: number;
  tradingBalanceUsd: number;
  reservePct: number;
  reserveUsd: number;
  availableUsd: number;
  maxDeploymentPct: number;
  maxDeploymentUsd: number;
  alreadyDeployedUsd: number;
  deploymentHeadroomUsd: number;
  tier: MarketCapTier;
  tierMaxPct: number;
  tierCapUsd: number;
  liquidityCapUsd: number | null;
  absoluteMaxUsd: number;
  minTradeUsd: number;
  chosenUsd: number;
  bindingConstraint: string;
}

export interface ExitEvaluationInput {
  config: StrategyConfig;
  exitStrategy: ExitStrategy;
  entryPriceUsd: number;
  currentPriceUsd: number;
  highestPriceUsd: number | null;
  trailingActive: boolean;
  partialTakeProfitDone: boolean;
  /** Set when a monitored trader has been seen selling this token. */
  traderSold: boolean;
}

export type ExitAction =
  | { action: 'HOLD'; detail: string }
  | {
      action: 'SELL';
      /** Fraction of the remaining position to sell, 0 < f <= 1. */
      fraction: number;
      reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TRADER_SOLD';
      detail: string;
    }
  | { action: 'ACTIVATE_TRAILING'; fraction: number; detail: string };
