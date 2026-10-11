import {
  Chain,
  ExitStrategy,
  PositionStatus,
  prisma,
  SignalStatus,
  SkipReason,
  TradeReason,
  TradeSide,
  TradingMode,
  TradingStrategy,
  TxStatus,
} from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { computeExitLevels } from '../engine/exits.js';
import { buildPortfolioState } from '../engine/portfolio.js';
import { calculatePositionSize } from '../engine/sizing.js';
import { getStrategyConfigFor } from '../engine/settings.js';
import { TelemetryTracker } from '../engine/telemetry.js';
import { componentLogger } from '../obs/logger.js';
import { executeSolanaSwap, lamportsFromSol, WRAPPED_SOL_MINT_STR } from '../solana/executor.js';
import { LockHeldError, withLock } from '../util/redis.js';
import { getSniperConfigFor } from './config.js';
import { enrichSniperToken } from './enrich.js';
import { qualifySniperToken } from './qualify.js';
import type { SniperDiscoveryEvent } from './types.js';

const log = componentLogger('sniper-execute');

const LIVE: PositionStatus[] = [
  PositionStatus.PENDING_OPEN,
  PositionStatus.OPEN,
  PositionStatus.PARTIALLY_CLOSED,
  PositionStatus.CLOSING,
];

async function dailySniperLossSol(userId: string): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const closed = await prisma.position.findMany({
    where: {
      userId,
      strategy: TradingStrategy.SNIPER,
      status: PositionStatus.CLOSED,
      closedAt: { gte: start },
    },
    select: { realizedPnlUsd: true, entryQuotePriceUsd: true },
  });
  let loss = 0;
  for (const p of closed) {
    const pnlUsd = Number(p.realizedPnlUsd ?? 0);
    const solUsd = Number(p.entryQuotePriceUsd ?? 0) || 0;
    if (pnlUsd < 0 && solUsd > 0) loss += Math.abs(pnlUsd) / solUsd;
  }
  return loss;
}

/**
 * Process one discovery for every user with Sniper engine ON.
 * Uses shared Solana signer + Jupiter execution + Redis locks.
 */
export async function handleSniperDiscovery(event: SniperDiscoveryEvent): Promise<void> {
  const users = await prisma.userModeSettings.findMany({
    where: { mode: TradingMode.SNIPER, engine: 'ON' },
    select: { userId: true },
  });
  if (!users.length) {
    log.debug({ mint: event.tokenAddress }, 'No sniper engines ON — discovery ignored for exec');
    return;
  }

  for (const { userId } of users) {
    try {
      await processSniperForUser(userId, event);
    } catch (error) {
      if (error instanceof LockHeldError) {
        log.warn({ userId, mint: event.tokenAddress }, 'Sniper lock held — skip');
        continue;
      }
      log.warn({ userId, err: error, mint: event.tokenAddress }, 'Sniper user processing failed');
    }
  }
}

async function processSniperForUser(userId: string, event: SniperDiscoveryEvent): Promise<void> {
  const lockKey = `sniper:${userId}:${event.tokenAddress}`;
  await withLock(lockKey, 120_000, async () => {
    const started = Date.now();
    const config = await getSniperConfigFor(userId);

    const existing = await prisma.sniperSignal.findUnique({
      where: {
        userId_sourceTxHash_tokenAddress: {
          userId,
          sourceTxHash: event.sourceTxHash,
          tokenAddress: event.tokenAddress,
        },
      },
    });
    if (existing) return;

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: Chain.SOLANA, address: event.tokenAddress } },
      create: { chain: Chain.SOLANA, address: event.tokenAddress },
      update: {},
    });

    const probeSize = Math.min(config.maxPositionSol, 0.05);
    const enrich = await enrichSniperToken(event, config, probeSize);

    const [openCount, existingPos, portfolioPack, dailyLoss] = await Promise.all([
      prisma.position.count({
        where: { userId, strategy: TradingStrategy.SNIPER, status: { in: LIVE } },
      }),
      prisma.position.findFirst({
        where: {
          userId,
          strategy: TradingStrategy.SNIPER,
          chain: Chain.SOLANA,
          tokenAddress: event.tokenAddress,
          status: { in: LIVE },
        },
      }),
      buildPortfolioState(Chain.SOLANA, event.tokenAddress, userId, {
        strategy: TradingStrategy.SNIPER,
      }),
      dailySniperLossSol(userId),
    ]);

    const portfolio = portfolioPack.state;
    const deployedSol =
      portfolio.quotePriceUsd > 0 ? portfolio.deployedUsd / portfolio.quotePriceUsd : 0;

    const qualification = qualifySniperToken({
      event,
      enrich,
      config,
      openSniperPositions: openCount,
      existingSniperPositionForToken: Boolean(existingPos),
      deployedSol,
      dailyLossSol: dailyLoss,
    });

    const signal = await prisma.sniperSignal.create({
      data: {
        userId,
        chain: Chain.SOLANA,
        tokenId: token.id,
        tokenAddress: event.tokenAddress,
        tokenSymbol: enrich.symbol,
        launchpad: event.launchpad,
        eventKind: event.eventKind,
        sourceTxHash: event.sourceTxHash,
        creatorAddress: event.creatorAddress,
        bondingState: event.bondingState,
        migrated: event.migrated,
        status: qualification.qualified ? SignalStatus.QUALIFIED : SignalStatus.SKIPPED,
        skipReason: qualification.qualified ? null : qualification.reason,
        skipDetail: qualification.qualified ? null : qualification.detail,
        marketCapUsdAtSignal: enrich.marketCapUsd,
        liquidityUsdAtSignal: enrich.liquidityUsd,
        priceUsdAtSignal: enrich.priceUsd,
        riskScore: qualification.qualified ? qualification.riskScore : null,
        enrichSnapshot: enrich as object,
        detectLatencyMs: Math.max(0, Date.now() - event.observedAt.getTime()),
        qualifyLatencyMs: Date.now() - started,
        qualifiedAt: new Date(),
      },
    });

    if (!qualification.qualified) {
      log.info(
        { userId, mint: event.tokenAddress, reason: qualification.reason },
        'Sniper rejected',
      );
      return;
    }

    if (config.runtimeMode !== 'live') {
      await prisma.sniperSignal.update({
        where: { id: signal.id },
        data: {
          status: SignalStatus.BLOCKED_DISABLED,
          skipDetail: `Runtime mode ${config.runtimeMode} — qualified but not broadcast.`,
        },
      });
      return;
    }

    const { config: strategyConfig } = await getStrategyConfigFor(userId, TradingMode.SNIPER);
    const market = {
      priceUsd: enrich.priceUsd ?? 0,
      marketCapUsd: enrich.marketCapUsd,
      fdvUsd: null,
      liquidityUsd: enrich.liquidityUsd,
      volume24hUsd: enrich.volume24hUsd,
      source: enrich.marketSource ?? 'sniper',
      fetchedAt: new Date(),
      missing: false,
    };

    const sizing = calculatePositionSize({
      config: strategyConfig,
      portfolio,
      market,
      tier: 2,
      signalStrength: 1,
      absoluteMaxUsd: env.MAX_TRADE_USD,
    });

    if (!sizing.ok) {
      await prisma.sniperSignal.update({
        where: { id: signal.id },
        data: {
          status: SignalStatus.SKIPPED,
          skipReason: sizing.reason,
          skipDetail: sizing.detail,
          sizingBasis: sizing.basis as object,
        },
      });
      return;
    }

    const sizeQuote = Math.min(sizing.sizeQuote, config.maxPositionSol);
    if (!(sizeQuote > 0)) {
      await prisma.sniperSignal.update({
        where: { id: signal.id },
        data: {
          status: SignalStatus.SKIPPED,
          skipReason: SkipReason.BELOW_MIN_TRADE_SIZE,
          skipDetail: 'Sniper size capped to zero by maxPositionSol.',
        },
      });
      return;
    }

    const cfg = chainConfig(Chain.SOLANA);
    const levels = computeExitLevels(enrich.priceUsd ?? 0, {
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      trailingTriggerPct: strategyConfig.trailingTriggerPct,
    });
    const requestedRaw = lamportsFromSol(sizeQuote);
    const idempotencyKey = `sniper:${userId}:${event.sourceTxHash}:${event.tokenAddress}`;

    const position = await prisma.position.create({
      data: {
        userId,
        chain: Chain.SOLANA,
        tokenId: token.id,
        tokenAddress: event.tokenAddress,
        tokenSymbol: enrich.symbol,
        strategy: TradingStrategy.SNIPER,
        status: PositionStatus.PENDING_OPEN,
        quoteAsset: WRAPPED_SOL_MINT_STR,
        quoteAssetSymbol: cfg.quoteAssetSymbol,
        exitStrategy:
          config.exitStrategy === 'TRAILING' ? ExitStrategy.TRAILING : ExitStrategy.MANUAL,
        requestedQuoteRaw: requestedRaw,
        entryPriceUsd: enrich.priceUsd,
        entryQuotePriceUsd: portfolio.quotePriceUsd,
        entryMarketCapUsd: enrich.marketCapUsd,
        entryLiquidityUsd: enrich.liquidityUsd,
        stopLossPriceUsd: levels.stopLossPriceUsd,
        takeProfitPriceUsd: levels.takeProfitPriceUsd,
      },
    });

    await prisma.sniperSignal.update({
      where: { id: signal.id },
      data: {
        status: SignalStatus.EXECUTING,
        positionId: position.id,
        plannedSizeQuote: sizeQuote,
        plannedSizeUsd: sizeQuote * portfolio.quotePriceUsd,
        sizingBasis: sizing.basis as object,
      },
    });

    const trade = await prisma.trade.create({
      data: {
        userId,
        idempotencyKey,
        positionId: position.id,
        chain: Chain.SOLANA,
        side: TradeSide.BUY,
        reason: TradeReason.SNIPER,
        tokenAddress: event.tokenAddress,
        tokenSymbol: enrich.symbol,
        tokenDecimals: enrich.decimals,
        quoteAsset: WRAPPED_SOL_MINT_STR,
        quoteAssetSymbol: cfg.quoteAssetSymbol,
        quoteDecimals: cfg.quoteAssetDecimals,
        status: TxStatus.BUILDING,
        requestedAmountRaw: requestedRaw,
        requestedSlippageBps: config.maxSlippageBps,
        maxAttempts: 3,
        quoteAssetPriceUsd: portfolio.quotePriceUsd,
      },
    });

    const telemetry = new TelemetryTracker(event.observedAt);
    const execStarted = Date.now();
    const outcome = await executeSolanaSwap({
      inputMint: WRAPPED_SOL_MINT_STR,
      outputMint: event.tokenAddress,
      amountRaw: requestedRaw,
      slippageBps: config.maxSlippageBps,
      maxPriceImpactPct: Math.max(config.maxPriceImpactBps / 100, 8),
      quoteMaxAgeMs: 1_500,
      confirmTimeoutMs: 6_000,
      maxAttempts: 3,
      telemetry,
      idempotencyKey,
      userId,
      custodyFamily: 'SNIPER',
    });

    if (outcome.status !== TxStatus.CONFIRMED || !outcome.txHash) {
      await prisma.$transaction([
        prisma.trade.update({
          where: { id: trade.id },
          data: {
            status: outcome.status,
            txHash: outcome.txHash,
            errorMessage: outcome.errorMessage,
            errorCode: outcome.errorCode,
            explorerUrl: outcome.explorerUrl,
            failedAt: new Date(),
          },
        }),
        prisma.position.update({
          where: { id: position.id },
          data: { status: PositionStatus.OPEN_FAILED },
        }),
        prisma.sniperSignal.update({
          where: { id: signal.id },
          data: {
            status: SignalStatus.FAILED,
            tradeId: trade.id,
            failedAt: new Date(),
            execLatencyMs: Date.now() - execStarted,
            skipDetail: outcome.errorMessage ?? 'Sniper buy failed',
          },
        }),
      ]);
      return;
    }

    await prisma.$transaction([
      prisma.trade.update({
        where: { id: trade.id },
        data: {
          status: TxStatus.CONFIRMED,
          txHash: outcome.txHash,
          explorerUrl: outcome.explorerUrl,
          confirmedAt: new Date(),
          quotedAmountRaw: outcome.quotedAmountRaw,
          actualAmountRaw: outcome.actualAmountRaw,
          fillRatio: outcome.fillRatio,
          realizedSlippagePct: outcome.realizedSlippagePct,
          priceImpactPct: outcome.priceImpactPct,
        },
      }),
      prisma.position.update({
        where: { id: position.id },
        data: {
          status: PositionStatus.OPEN,
          openedAt: new Date(),
          actualQuoteRaw: requestedRaw,
          tokenAmountRaw: outcome.actualAmountRaw,
          remainingTokenRaw: outcome.actualAmountRaw,
          entryPriceUsd: enrich.priceUsd,
          entryValueUsd: sizeQuote * portfolio.quotePriceUsd,
          entrySlippagePct: outcome.realizedSlippagePct,
          entryPriceImpactPct: outcome.priceImpactPct,
          lastPriceUsd: enrich.priceUsd,
          lastPriceAt: new Date(),
        },
      }),
      prisma.sniperSignal.update({
        where: { id: signal.id },
        data: {
          status: SignalStatus.EXECUTED,
          tradeId: trade.id,
          executedAt: new Date(),
          execLatencyMs: Date.now() - execStarted,
        },
      }),
    ]);

    log.info(
      { userId, mint: event.tokenAddress, tx: outcome.txHash, sizeQuote },
      'Sniper buy confirmed',
    );
  });
}
