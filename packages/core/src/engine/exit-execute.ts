import {
  Chain,
  PositionStatus,
  prisma,
  TradeReason,
  TradeSide,
  TxStatus,
  type Position,
} from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import { NATIVE_SENTINEL } from '../evm/kyberswap.js';
import { executeEvmSwap } from '../evm/executor.js';
import { getMarketSnapshot } from '../market/index.js';
import { componentLogger } from '../obs/logger.js';
import { reportError } from '../obs/sentry.js';
import { evmSigner, solanaSigner } from '../security/signer.js';
import { executeSolanaSwap, WRAPPED_SOL_MINT_STR } from '../solana/executor.js';
import { withLock } from '../util/redis.js';
import {
  renderFailure,
  renderSell,
  renderSubmitted,
  renderTrailingActivated,
} from '../notify/messages.js';
import { telegram } from '../notify/telegram.js';
import { evaluateExit, computeTrailingStop, updateHighWaterMark } from './exits.js';
import { executionGate, fractionOfRaw, wholeUnits } from './execution-gate.js';
import { getPnlSummary, readOnChainBalance } from './portfolio.js';
import { getSettings, getStrategyConfig } from './settings.js';
import { TelemetryTracker } from './telemetry.js';

const log = componentLogger('exit-execute');

const LIVE = [PositionStatus.OPEN, PositionStatus.PARTIALLY_CLOSED] as const;

export async function monitorOpenPositions(): Promise<void> {
  const positions = await prisma.position.findMany({
    where: { status: { in: [...LIVE] } },
    include: { token: true },
  });
  for (const position of positions) {
    try {
      await markAndMaybeExit(position);
    } catch (error) {
      await reportError(error, {
        component: 'exit-monitor',
        code: 'POSITION_TICK_FAILED',
        chain: position.chain,
        notify: true,
        context: { positionId: position.id },
      });
    }
  }
}

async function markAndMaybeExit(
  position: Position & { token: { symbol: string | null; decimals: number | null } },
): Promise<void> {
  const config = await getStrategyConfig();
  const settings = await getSettings();
  const market = await getMarketSnapshot(position.chain, position.tokenAddress);
  if (market.missing || market.priceUsd <= 0) {
    log.warn({ positionId: position.id }, 'No live mark; holding rather than exiting on a missing price');
    return;
  }

  const highest = updateHighWaterMark(
    position.highestPriceUsd ? Number(position.highestPriceUsd) : null,
    market.priceUsd,
    position.trailingActive,
  );
  const trailingStop =
    position.trailingActive && highest !== null
      ? computeTrailingStop(highest, config.trailingDropPct)
      : null;

  const entry = Number(position.entryPriceUsd ?? 0);
  const remainingRaw = position.remainingTokenRaw ?? '0';
  const decimals = position.token.decimals ?? 0;
  const remainingTokens = wholeUnits(remainingRaw, decimals);
  const unrealizedUsd = entry > 0 ? (market.priceUsd - entry) * remainingTokens : 0;
  const quotePrice = Number(position.entryQuotePriceUsd ?? 0);
  const unrealizedQuote = quotePrice > 0 ? unrealizedUsd / quotePrice : 0;
  const unrealizedPct = entry > 0 ? ((market.priceUsd - entry) / entry) * 100 : 0;

  await prisma.token.update({
    where: { id: position.tokenId },
    data: {
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCapUsd,
      liquidityUsd: market.liquidityUsd,
      marketSource: market.source,
      marketUpdatedAt: market.fetchedAt,
    },
  });

  await prisma.position.update({
    where: { id: position.id },
    data: {
      lastPriceUsd: market.priceUsd,
      lastPriceAt: market.fetchedAt,
      highestPriceUsd: highest,
      trailingStopPriceUsd: trailingStop,
      unrealizedPnlUsd: unrealizedUsd,
      unrealizedPnlQuote: unrealizedQuote,
      unrealizedPnlPct: unrealizedPct,
    },
  });

  const traderSold = await prisma.detectedTransaction.findFirst({
    where: {
      chain: position.chain,
      tokenInAddress: position.tokenAddress,
      classification: 'SELL',
      observedAt: { gte: position.openedAt ?? position.createdAt },
    },
    select: { id: true },
  });

  const action = evaluateExit({
    config,
    exitStrategy: position.exitStrategy,
    entryPriceUsd: entry,
    currentPriceUsd: market.priceUsd,
    highestPriceUsd: highest,
    trailingActive: position.trailingActive,
    partialTakeProfitDone: position.partialTakeProfitDone,
    traderSold: Boolean(traderSold),
  });

  if (action.action === 'HOLD') return;

  const signerOk = position.chain === Chain.SOLANA ? solanaSigner.available : evmSigner.available;
  const gate = executionGate({
    signerAvailable: signerOk,
    tradingEnabled: true,
    emergencyStop: false,
    emergencyStopReason: null,
  });
  if (!gate.ok) {
    log.info({ positionId: position.id, status: gate.status }, 'Exit signal held — no signer');
    return;
  }

  await withLock(`exit:${position.id}`, 120_000, async () => {
    const fresh = await prisma.position.findUnique({ where: { id: position.id } });
    if (!fresh || !LIVE.includes(fresh.status as (typeof LIVE)[number])) return;
    await executeExit(fresh, action.fraction, action.action === 'SELL' ? action.reason : 'TAKE_PROFIT', action.detail, market.priceUsd, settings.pnlResetAt);
    if (action.action === 'ACTIVATE_TRAILING') {
      await prisma.position.update({
        where: { id: position.id },
        data: {
          trailingActive: true,
          trailingActivatedAt: new Date(),
          partialTakeProfitDone: true,
          highestPriceUsd: market.priceUsd,
          trailingStopPriceUsd: computeTrailingStop(market.priceUsd, config.trailingDropPct),
        },
      });
    }
  });
}

async function executeExit(
  position: Position,
  fraction: number,
  reason: TradeReason,
  detail: string,
  markPriceUsd: number,
  pnlResetAt: Date,
): Promise<void> {
  const config = await getStrategyConfig();
  const chainMeta = chainConfig(position.chain);
  const remaining = position.remainingTokenRaw ?? '0';
  const sellRaw = fractionOfRaw(remaining, fraction);
  if (sellRaw === '0') {
    log.warn({ positionId: position.id }, 'Exit size rounded to zero raw units; not broadcasting');
    return;
  }

  await prisma.position.update({
    where: { id: position.id },
    data: { status: PositionStatus.CLOSING },
  });

  const telemetry = new TelemetryTracker();
  const idempotencyKey = `exit:${position.id}:${reason}:${sellRaw}`;
  const existing = await prisma.trade.findUnique({ where: { idempotencyKey } });
  if (existing?.status === TxStatus.CONFIRMED) return;

  const trade = existing
    ? existing
    : await prisma.trade.create({
        data: {
          idempotencyKey,
          positionId: position.id,
          chain: position.chain,
          side: TradeSide.SELL,
          reason,
          tokenAddress: position.tokenAddress,
          tokenSymbol: position.tokenSymbol,
          quoteAsset: chainMeta.quoteAsset,
          quoteAssetSymbol: chainMeta.quoteAssetSymbol,
          quoteDecimals: chainMeta.quoteAssetDecimals,
          status: TxStatus.BUILDING,
          requestedAmountRaw: sellRaw,
          requestedSlippageBps: config.maxSlippageBps,
          maxAttempts: config.maxExecutionAttempts,
        },
      });

  const outcome =
    position.chain === Chain.SOLANA
      ? await executeSolanaSwap({
          inputMint: position.tokenAddress,
          outputMint: WRAPPED_SOL_MINT_STR,
          amountRaw: sellRaw,
          slippageBps: config.maxSlippageBps,
          maxPriceImpactPct: config.maxPriceImpactPct,
          quoteMaxAgeMs: config.quoteMaxAgeMs,
          confirmTimeoutMs: config.confirmTimeoutMs,
          maxAttempts: config.maxExecutionAttempts,
          telemetry,
          idempotencyKey,
        })
      : await executeEvmSwap({
          chain: position.chain,
          tokenIn: position.tokenAddress,
          tokenOut: NATIVE_SENTINEL,
          amountInRaw: sellRaw,
          slippageBps: config.maxSlippageBps,
          maxPriceImpactPct: config.maxPriceImpactPct,
          quoteMaxAgeMs: config.quoteMaxAgeMs,
          confirmTimeoutMs: config.confirmTimeoutMs,
          maxAttempts: config.maxExecutionAttempts,
          telemetry,
          idempotencyKey,
        });

  await prisma.trade.update({
    where: { id: trade.id },
    data: {
      status: outcome.status,
      txHash: outcome.txHash,
      explorerUrl: outcome.explorerUrl,
      blockNumber: outcome.slot,
      confirmations: outcome.confirmations,
      quotedAmountRaw: outcome.quotedAmountRaw,
      actualAmountRaw: outcome.actualAmountRaw,
      fillRatio: outcome.fillRatio,
      realizedSlippagePct: outcome.realizedSlippagePct,
      priceImpactPct: outcome.priceImpactPct,
      networkFeeRaw: outcome.networkFeeRaw,
      routeProvider: outcome.routeProvider,
      routeSummary: outcome.routeSummary as object | undefined,
      attempt: outcome.attempts,
      attemptLog: outcome.attemptLog as object,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      ...telemetry.toTradeFields(),
      failedAt: outcome.status === TxStatus.CONFIRMED ? null : new Date(),
    },
  });

  if (outcome.txHash && outcome.status !== TxStatus.CONFIRMED) {
    telegram.send(
      renderSubmitted({
        chain: position.chain,
        side: 'SELL',
        reason,
        tokenSymbol: position.tokenSymbol ?? position.tokenAddress.slice(0, 6),
        amountQuote: 0,
        txHash: outcome.txHash,
        broadcastLatencyMs: telemetry.sinceStart('broadcast') ?? null,
      }),
      { kind: 'sell-submitted', tradeId: trade.id, positionId: position.id },
    );
  }

  if (outcome.status !== TxStatus.CONFIRMED) {
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: fraction >= 1 ? PositionStatus.OPEN : PositionStatus.PARTIALLY_CLOSED,
      },
    });
    telegram.send(
      renderFailure({
        chain: position.chain,
        side: 'SELL',
        tokenSymbol: position.tokenSymbol,
        errorCode: outcome.errorCode ?? outcome.status,
        errorMessage: outcome.errorMessage ?? detail,
        txHash: outcome.txHash,
        attempts: outcome.attempts,
      }),
      { kind: 'sell-failed', tradeId: trade.id, positionId: position.id },
    );
    return;
  }

  const exitQuote = outcome.actualAmountRaw
    ? wholeUnits(outcome.actualAmountRaw, chainMeta.quoteAssetDecimals)
    : 0;
  const remainingAfter = BigInt(remaining) - BigInt(sellRaw);
  const closed = remainingAfter <= 0n || fraction >= 1;
  const entryQuote = position.actualQuoteRaw
    ? wholeUnits(position.actualQuoteRaw, chainMeta.quoteAssetDecimals) * fraction
    : Number(position.entryValueUsd ?? 0);
  const pnlQuote = exitQuote - entryQuote;
  const pnlPct =
    Number(position.entryPriceUsd ?? 0) > 0
      ? ((markPriceUsd - Number(position.entryPriceUsd)) / Number(position.entryPriceUsd)) * 100
      : 0;

  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: closed ? PositionStatus.CLOSED : PositionStatus.PARTIALLY_CLOSED,
      remainingTokenRaw: remainingAfter > 0n ? remainingAfter.toString() : '0',
      realizedPnlQuote: { increment: pnlQuote },
      realizedPnlUsd: { increment: pnlQuote * Number(position.entryQuotePriceUsd ?? 0) },
      feesQuote: {
        increment: outcome.networkFeeRaw ? wholeUnits(outcome.networkFeeRaw, chainMeta.nativeDecimals) : 0,
      },
      closedAt: closed ? new Date() : null,
      closeReason: closed ? reason : position.closeReason,
      lastPriceUsd: markPriceUsd,
      lastPriceAt: new Date(),
    },
  });

  const balance = await readOnChainBalance(position.chain).catch(() => null);
  const total = await getPnlSummary(pnlResetAt);
  const source = await prisma.signal.findFirst({
    where: { positionId: position.id },
    include: { trader: true },
  });

  if (reason === TradeReason.TAKE_PROFIT && !closed) {
    telegram.send(
      renderTrailingActivated({
        chain: position.chain,
        tokenSymbol: position.tokenSymbol ?? 'TOKEN',
        entryPriceUsd: Number(position.entryPriceUsd ?? 0),
        currentPriceUsd: markPriceUsd,
        soldPct: fraction * 100,
        trailingDropPct: config.trailingDropPct,
        trailingStopPriceUsd: computeTrailingStop(markPriceUsd, config.trailingDropPct),
        txHash: outcome.txHash as string,
      }),
      { kind: 'trailing-armed', tradeId: trade.id, positionId: position.id },
    );
  }

  telegram.send(
    renderSell({
      chain: position.chain,
      reason,
      tokenSymbol: position.tokenSymbol ?? 'TOKEN',
      marketCapUsd: position.entryMarketCapUsd ? Number(position.entryMarketCapUsd) : null,
      liquidityUsd: position.entryLiquidityUsd ? Number(position.entryLiquidityUsd) : null,
      traderLabel: source?.trader.label ?? 'COPYRA',
      traderAddress: source?.trader.address ?? '',
      entryPriceUsd: position.entryPriceUsd ? Number(position.entryPriceUsd) : null,
      exitPriceUsd: markPriceUsd,
      entryQuote,
      exitQuote,
      feeNative: outcome.networkFeeRaw ? wholeUnits(outcome.networkFeeRaw, chainMeta.nativeDecimals) : null,
      speedMs: telemetry.sinceStart('confirmed') ?? null,
      heldMs: position.openedAt ? Date.now() - position.openedAt.getTime() : null,
      pnlQuote,
      pnlPct,
      balanceQuote: balance?.totalQuote ?? 0,
      balanceUsd: balance?.totalUsd ?? null,
      totalPnlQuote: total.realizedPnlQuote,
      txHash: outcome.txHash as string,
      portionPct: fraction * 100,
    }),
    { kind: 'sell-confirmed', tradeId: trade.id, positionId: position.id },
  );
}
