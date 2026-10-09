import { Chain, ExitStrategy, TxClassification } from '@copyra/db';
import type {
  DecodedTransaction,
  MarketSnapshot,
  PortfolioState,
  QualificationInput,
  StrategyConfig,
} from '../types.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

export function strategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    tradingEnabled: true,
    emergencyStop: false,
    exitStrategy: ExitStrategy.MANUAL,
    minMarketCapUsd: 1_000_000,
    maxMarketCapUsd: 20_000_000,
    maxDeploymentPct: 80,
    tier1MaxPct: 20,
    tier2MaxPct: 30,
    tier3MaxPct: 40,
    tier4MaxPct: 50,
    maxOpenPositions: 5,
    reservePct: 20,
    minTradeUsd: 10,
    maxSlippageBps: 100,
    maxPriceImpactPct: 3,
    minLiquidityUsd: 50_000,
    quoteMaxAgeMs: 3_000,
    confirmTimeoutMs: 60_000,
    maxExecutionAttempts: 3,
    takeProfitPct: 20,
    stopLossPct: 10,
    trailingTriggerPct: 20,
    trailingPartialSellPct: 50,
    trailingDropPct: 15,
    followTraderSells: true,
    firstBuyOnly: true,
    tradeAllocationPct: 50,
    enabledChains: [Chain.SOLANA, Chain.BASE],
    ...overrides,
  };
}

export function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    priceUsd: 0.0000231,
    marketCapUsd: 4_200_000,
    fdvUsd: 4_200_000,
    liquidityUsd: 310_000,
    volume24hUsd: 80_000,
    source: 'test-fixture',
    fetchedAt: new Date('2026-10-05T00:00:00.000Z'),
    missing: false,
    ...overrides,
  };
}

export function portfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    tradingBalanceQuote: 5,
    quotePriceUsd: 120,
    deployedUsd: 0,
    openPositionCount: 0,
    existingPositionForToken: false,
    readAtBlock: 453_000_000n,
    readAt: new Date('2026-10-05T00:00:00.000Z'),
    ...overrides,
  };
}

export function decodedBuy(overrides: Partial<DecodedTransaction> = {}): DecodedTransaction {
  return {
    chain: Chain.SOLANA,
    txHash: '5QQ4cZKfWxXaZ959UULnHbsLhRZikm7Ar8WpqSVRmoXdr1CQTT5dYHH3f9JEy8D84k1eSZNHWzdMkXMqxyLzCyLn',
    traderAddress: '5KUc73Yc7rJ8oX1TvunRSjYVb36FUFQwSHNw3LtYTLyr',
    blockNumber: 453414341n,
    blockTime: new Date('2026-10-05T00:14:00.000Z'),
    classification: TxClassification.BUY,
    venue: 'Jupiter v6',
    tokenIn: {
      address: SOL_MINT,
      symbol: 'SOL',
      decimals: 9,
      amountRaw: '1250000000',
    },
    tokenOut: {
      address: TOKEN_MINT,
      symbol: 'BONK',
      decimals: 5,
      amountRaw: '54000000000',
    },
    feeRaw: '5000',
    classificationBasis: 'Wallet spent SOL and received the token.',
    raw: {},
    ...overrides,
  };
}

export function qualifyInput(overrides: Partial<QualificationInput> = {}): QualificationInput {
  return {
    decoded: decodedBuy(),
    market: market(),
    config: strategyConfig(),
    portfolio: portfolio(),
    traderEnabled: true,
    tokenBlacklisted: false,
    isFirstBuy: true,
    chainCanExecute: true,
    correlatedTraderCount: 1,
    spendLegIsQuoteAsset: true,
    ...overrides,
  };
}
