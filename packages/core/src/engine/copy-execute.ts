import {
  Chain,
  PositionStatus,
  prisma,
  SignalStatus,
  SkipReason,
  TradeReason,
  TradeSide,
  TxStatus,
  type Token,
  type Trader,
} from '@copyra/db';
import { chainConfig } from '../config/chains.js';
import { env } from '../config/env.js';
import { NATIVE_SENTINEL } from '../evm/kyberswap.js';
import { executeEvmSwap } from '../evm/executor.js';
import { getMarketSnapshot, type TokenMarketData } from '../market/index.js';
import { componentLogger } from '../obs/logger.js';
import { reportError } from '../obs/sentry.js';
import { evmSigner, solanaSigner } from '../security/signer.js';
import { multiUserCustodyEnabled } from '../security/user-custody.js';
import { executeSolanaSwap, lamportsFromSol, WRAPPED_SOL_MINT_STR } from '../solana/executor.js';
import { LockHeldError, withLock } from '../util/redis.js';
import { renderBuy, renderFailure, renderSkip, renderSubmitted } from '../notify/messages.js';
import { telegram } from '../notify/telegram.js';
import { computeExitLevels } from './exits.js';
import { executionGate, wholeUnits } from './execution-gate.js';
import { buildPortfolioState, getPnlSummary, NoTradingWalletError, snapshotBalance } from './portfolio.js';
import { calculatePositionSize } from './sizing.js';
import { getSettings, getStrategyConfig } from './settings.js';
import { TelemetryTracker } from './telemetry.js';
import type { DecodedTransaction, MarketCapTier } from './types.js';

const log = componentLogger('copy-execute');

export interface QualifiedCopyInput {
  chain: Chain;
  trader: Trader;
  token: Token;
  tokenAddress: string;
  decoded: DecodedTransaction;
  market: TokenMarketData;
  signalStrength: number;
  marketCapTier: MarketCapTier;
  detectionId: string;
  sourceTxHash: string;
  observedAt: Date;
}

export interface QualifiedCopyResult {
  status: SignalStatus;
  signalId: string | null;
  positionId: string | null;
  tradeId: string | null;
  txHash: string | null;
}

/** Shared bot key, or per-account custody when MULTI_USER_CUSTODY is on. */
function signerFor(chain: Chain): { available: boolean; address: string | null } {
  if (multiUserCustodyEnabled()) {
    return { available: true, address: null };
  }
  return chain === Chain.SOLANA
    ? { available: solanaSigner.available, address: solanaSigner.address }
    : { available: evmSigner.available, address: evmSigner.address };
}

async function recordFirstBuy(input: QualifiedCopyInput, signalId: string | null): Promise<void> {
  const existing = await prisma.tokenFirstBuy.findUnique({
    where: { chain_tokenAddress: { chain: input.chain, tokenAddress: input.tokenAddress } },
  });
  if (existing) {
    await prisma.tokenFirstBuy.update({
      where: { id: existing.id },
      data: { correlatedBuys: { increment: 1 }, lastCorrelatedAt: new Date() },
    });
    return;
  }
  await prisma.tokenFirstBuy.create({
    data: {
      chain: input.chain,
      tokenAddress: input.tokenAddress,
      tokenId: input.token.id,
      firstTraderId: input.trader.id,
      firstSignalId: signalId,
      firstSourceTx: input.sourceTxHash,
    },
  });
}

/**
 * After a signal has passed market qualification: persist it, then execute only
 * when a real signer, live balance, and fresh quote all exist. Confirmation is
 * the only path to OPEN / EXECUTED.
 */
export async function handleQualifiedCopy(input: QualifiedCopyInput): Promise<QualifiedCopyResult> {
  const ownerUserId = input.trader.userId;
  if (!ownerUserId) {
    log.error({ traderId: input.trader.id }, 'Trader missing userId — refusing shared execution');
    return {
      status: SignalStatus.SKIPPED,
      signalId: null,
      positionId: null,
      tradeId: null,
      txHash: null,
    };
  }
  // Per-account lock so two users can copy the same token independently.
  const lockKey = `copy:${ownerUserId}:${input.chain}:${input.tokenAddress}`;
  try {
    return await withLock(lockKey, 120_000, () => runQualifiedCopy(input));
  } catch (error) {
    if (error instanceof LockHeldError) {
      const signal = await prisma.signal.create({
        data: {
          userId: ownerUserId,
          chain: input.chain,
          traderId: input.trader.id,
          tokenId: input.token.id,
          tokenAddress: input.tokenAddress,
          detectionId: input.detectionId,
          sourceTxHash: input.sourceTxHash,
          status: SignalStatus.SKIPPED,
          skipReason: SkipReason.DUPLICATE_SIGNAL,
          skipDetail: 'Another worker is already executing this token for this account.',
          signalStrength: input.signalStrength,
          marketCapUsdAtSignal: input.market.marketCapUsd,
          liquidityUsdAtSignal: input.market.liquidityUsd,
          priceUsdAtSignal: input.market.priceUsd,
          decodedAt: new Date(),
          qualifiedAt: new Date(),
        },
      });
      return { status: SignalStatus.SKIPPED, signalId: signal.id, positionId: null, tradeId: null, txHash: null };
    }
    throw error;
  }
}

async function runQualifiedCopy(input: QualifiedCopyInput): Promise<QualifiedCopyResult> {
  const ownerUserId = input.trader.userId;
  const signer = signerFor(input.chain);
  const telemetry = new TelemetryTracker(input.observedAt);
  telemetry.mark('decoded');
  telemetry.mark('qualified');

  // Overlap settings + book lookups so sizing starts sooner on the hot path.
  const [settings, config, open, firstBuy] = await Promise.all([
    getSettings(),
    getStrategyConfig(),
    prisma.position.findFirst({
      where: {
        userId: ownerUserId,
        chain: input.chain,
        tokenAddress: input.tokenAddress,
        status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSING'] },
      },
    }),
    prisma.tokenFirstBuy.findUnique({
      where: { chain_tokenAddress: { chain: input.chain, tokenAddress: input.tokenAddress } },
    }),
  ]);

  // First-buy-only: never open/scale a second book entry in the same token.
  // Every-buy: scale into the existing open position instead of skipping.
  const scaleIn = Boolean(open) && !config.firstBuyOnly;
  if (open && config.firstBuyOnly) {
    const signal = await prisma.signal.create({
      data: {
        userId: ownerUserId,
        chain: input.chain,
        traderId: input.trader.id,
        tokenId: input.token.id,
        tokenAddress: input.tokenAddress,
        detectionId: input.detectionId,
        sourceTxHash: input.sourceTxHash,
        status: SignalStatus.SKIPPED,
        skipReason: SkipReason.POSITION_ALREADY_OPEN,
        skipDetail: 'This account already has an open COPYRA position in this token (first-buy-only).',
        signalStrength: input.signalStrength,
        marketCapUsdAtSignal: input.market.marketCapUsd,
        liquidityUsdAtSignal: input.market.liquidityUsd,
        priceUsdAtSignal: input.market.priceUsd,
        decodedAt: new Date(),
        qualifiedAt: new Date(),
      },
    });
    return { status: SignalStatus.SKIPPED, signalId: signal.id, positionId: null, tradeId: null, txHash: null };
  }

  // Per-mode kill switch / pause (dashboard ui.sol / ui.evm) — independent of the other mode.
  const modeKey = input.chain === Chain.SOLANA ? 'sol' : 'evm';
  const modeUi = (settings.ui as Record<string, { engine?: string } | undefined> | null)?.[modeKey];
  const modeStopped = modeUi?.engine === 'STOPPED' || modeUi?.engine === 'PAUSED';

  const gate = executionGate({
    signerAvailable: signer.available,
    tradingEnabled: config.tradingEnabled && !modeStopped,
    emergencyStop: settings.emergencyStop,
    emergencyStopReason: settings.emergencyStopReason,
  });

  const signal = await prisma.signal.create({
    data: {
      userId: ownerUserId,
      chain: input.chain,
      traderId: input.trader.id,
      tokenId: input.token.id,
      tokenAddress: input.tokenAddress,
      detectionId: input.detectionId,
      sourceTxHash: input.sourceTxHash,
      status: gate.ok ? SignalStatus.QUALIFIED : gate.status,
      skipReason: gate.ok ? null : gate.reason,
      skipDetail: gate.ok ? null : gate.detail,
      signalStrength: input.signalStrength,
      marketCapUsdAtSignal: input.market.marketCapUsd,
      liquidityUsdAtSignal: input.market.liquidityUsd,
      priceUsdAtSignal: input.market.priceUsd,
      decodedAt: new Date(),
      qualifiedAt: new Date(),
    },
  });
  await recordFirstBuy(input, signal.id);

  if (!gate.ok) {
    log.info({ token: input.tokenAddress, status: gate.status }, 'Qualified signal held — no broadcast');
    return { status: gate.status, signalId: signal.id, positionId: null, tradeId: null, txHash: null };
  }

  let portfolio;
  try {
    // Size against THIS account's custody wallet — never the shared bot signer.
    portfolio = await buildPortfolioState(input.chain, input.tokenAddress, ownerUserId);
    await snapshotBalance(input.chain, portfolio.balance);
  } catch (error) {
    if (error instanceof NoTradingWalletError) {
      await prisma.signal.update({
        where: { id: signal.id },
        data: {
          status: SignalStatus.BLOCKED_NO_SIGNER,
          skipReason: SkipReason.TRADER_DISABLED,
          skipDetail:
            error.message +
            ' Deposit SOL/USDC to your COPYRA custody wallet, then resume copying.',
        },
      });
      return {
        status: SignalStatus.BLOCKED_NO_SIGNER,
        signalId: signal.id,
        positionId: null,
        tradeId: null,
        txHash: null,
      };
    }
    throw error;
  }

  telemetry.mark('riskChecked');
  // Size against this account's open-book only (never another wallet's positions).
  const accountOpenCount = await prisma.position.count({
    where: {
      userId: ownerUserId,
      status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED'] },
    },
  });
  const accountPortfolio = {
    ...portfolio.state,
    openPositionCount: accountOpenCount,
    existingPositionForToken: false,
  };
  const sizing = calculatePositionSize({
    config,
    portfolio: accountPortfolio,
    market: input.market,
    tier: input.marketCapTier,
    signalStrength: input.signalStrength,
    absoluteMaxUsd: env.MAX_TRADE_USD,
  });

  if (!sizing.ok) {
    await prisma.signal.update({
      where: { id: signal.id },
      data: {
        status: SignalStatus.SKIPPED,
        skipReason: sizing.reason,
        skipDetail: sizing.detail,
        sizingBasis: sizing.basis as object,
        plannedSizeQuote: sizing.basis.chosenUsd / Math.max(portfolio.state.quotePriceUsd, 1e-12),
        plannedSizeUsd: sizing.basis.chosenUsd,
      },
    });
    telegram.send(
      renderSkip({
        chain: input.chain,
        tokenSymbol: input.market.symbol ?? input.token.symbol,
        tokenAddress: input.tokenAddress,
        traderLabel: input.trader.label,
        traderAddress: input.trader.address,
        reason: sizing.reason,
        detail: sizing.detail,
        marketCapUsd: input.market.marketCapUsd,
        liquidityUsd: input.market.liquidityUsd,
        sourceTxHash: input.sourceTxHash,
      }),
      { kind: 'skip', userId: ownerUserId },
    );
    return { status: SignalStatus.SKIPPED, signalId: signal.id, positionId: null, tradeId: null, txHash: null };
  }

  const chainMeta = chainConfig(input.chain);
  const levels = computeExitLevels(input.market.priceUsd, config);
  const requestedRaw =
    input.chain === Chain.SOLANA
      ? lamportsFromSol(sizing.sizeQuote)
      : BigInt(Math.floor(sizing.sizeQuote * 10 ** chainMeta.nativeDecimals)).toString();

  const position =
    scaleIn && open
      ? open
      : await prisma.position.create({
          data: {
            userId: ownerUserId,
            chain: input.chain,
            tokenId: input.token.id,
            tokenAddress: input.tokenAddress,
            tokenSymbol: input.market.symbol ?? input.token.symbol,
            status: PositionStatus.PENDING_OPEN,
            quoteAsset: chainMeta.quoteAsset,
            quoteAssetSymbol: chainMeta.quoteAssetSymbol,
            exitStrategy: config.exitStrategy,
            requestedQuoteRaw: requestedRaw,
            entryMarketCapUsd: input.market.marketCapUsd,
            entryLiquidityUsd: input.market.liquidityUsd,
            stopLossPriceUsd: levels.stopLossPriceUsd,
            takeProfitPriceUsd: levels.takeProfitPriceUsd,
            correlatedTraders: firstBuy ? firstBuy.correlatedBuys + 1 : 1,
            signalStrength: input.signalStrength,
          },
        });

  const idempotencyKey = `copy:${ownerUserId}:${input.chain}:${input.sourceTxHash}:${input.trader.id}`;
  const trade = await prisma.trade.create({
    data: {
      userId: ownerUserId,
      idempotencyKey,
      positionId: position.id,
      signalId: signal.id,
      chain: input.chain,
      side: TradeSide.BUY,
      reason: TradeReason.COPY,
      tokenAddress: input.tokenAddress,
      tokenSymbol: input.market.symbol ?? input.token.symbol,
      tokenDecimals: input.decoded.tokenOut?.decimals ?? input.token.decimals,
      quoteAsset: chainMeta.quoteAsset,
      quoteAssetSymbol: chainMeta.quoteAssetSymbol,
      quoteDecimals: chainMeta.quoteAssetDecimals,
      status: TxStatus.BUILDING,
      requestedAmountRaw: requestedRaw,
      requestedSlippageBps: config.maxSlippageBps,
      maxAttempts: config.maxExecutionAttempts,
      quoteAssetPriceUsd: portfolio.balance.quotePriceUsd,
    },
  });

  await prisma.signal.update({
    where: { id: signal.id },
    data: {
      status: SignalStatus.EXECUTING,
      positionId: position.id,
      plannedSizeQuote: sizing.sizeQuote,
      plannedSizeUsd: sizing.sizeUsd,
      sizingBasis: sizing.basis as object,
    },
  });

  const outcome =
    input.chain === Chain.SOLANA
      ? await executeSolanaSwap({
          inputMint: WRAPPED_SOL_MINT_STR,
          outputMint: input.tokenAddress,
          amountRaw: requestedRaw,
          slippageBps: config.maxSlippageBps,
          maxPriceImpactPct: config.maxPriceImpactPct,
          quoteMaxAgeMs: config.quoteMaxAgeMs,
          confirmTimeoutMs: config.confirmTimeoutMs,
          maxAttempts: config.maxExecutionAttempts,
          telemetry,
          idempotencyKey,
          userId: ownerUserId,
        })
      : await executeEvmSwap({
          chain: input.chain,
          tokenIn: NATIVE_SENTINEL,
          tokenOut: input.tokenAddress,
          amountInRaw: requestedRaw,
          slippageBps: config.maxSlippageBps,
          maxPriceImpactPct: config.maxPriceImpactPct,
          quoteMaxAgeMs: config.quoteMaxAgeMs,
          confirmTimeoutMs: config.confirmTimeoutMs,
          maxAttempts: config.maxExecutionAttempts,
          telemetry,
          idempotencyKey,
          userId: ownerUserId,
        });

  const fields = telemetry.toTradeFields();
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
      blockhash: outcome.blockhash,
      lastValidBlockHeight: outcome.lastValidBlockHeight,
      ...fields,
      failedAt: outcome.status === TxStatus.CONFIRMED ? null : new Date(),
    },
  });
  await prisma.signal.update({
    where: { id: signal.id },
    data: {
      status: outcome.status === TxStatus.CONFIRMED ? SignalStatus.EXECUTED : SignalStatus.FAILED,
      ...telemetry.toSignalFields(),
    },
  });

  if (outcome.txHash && outcome.status !== TxStatus.CONFIRMED) {
    telegram.send(
      renderSubmitted({
        chain: input.chain,
        side: 'BUY',
        reason: TradeReason.COPY,
        tokenSymbol: input.market.symbol ?? input.token.symbol ?? input.tokenAddress.slice(0, 6),
        amountQuote: sizing.sizeQuote,
        txHash: outcome.txHash,
        broadcastLatencyMs: telemetry.sinceStart('broadcast') ?? null,
      }),
      { kind: 'buy-submitted', tradeId: trade.id, positionId: position.id, userId: ownerUserId },
    );
  }

  if (outcome.status !== TxStatus.CONFIRMED) {
    const keepPending = outcome.status === TxStatus.UNKNOWN || outcome.status === TxStatus.BROADCAST;
    // Scale-in failures must not kill an already-open position.
    if (!scaleIn) {
      await prisma.position.update({
        where: { id: position.id },
        data: { status: keepPending ? PositionStatus.PENDING_OPEN : PositionStatus.OPEN_FAILED },
      });
    }
    telegram.send(
      renderFailure({
        chain: input.chain,
        side: 'BUY',
        tokenSymbol: input.market.symbol ?? input.token.symbol,
        errorCode: outcome.errorCode ?? outcome.status,
        errorMessage: outcome.errorMessage ?? 'Execution did not confirm on-chain.',
        txHash: outcome.txHash,
        attempts: outcome.attempts,
      }),
      { kind: 'buy-failed', tradeId: trade.id, positionId: position.id, userId: ownerUserId },
    );
    if (keepPending) {
      await reportError(new Error(outcome.errorMessage ?? 'confirmation unknown'), {
        component: 'copy-execute',
        code: 'CONFIRMATION_UNKNOWN',
        chain: input.chain,
        notify: true,
        context: { tradeId: trade.id, txHash: outcome.txHash },
      });
    }
    return {
      status: SignalStatus.FAILED,
      signalId: signal.id,
      positionId: position.id,
      tradeId: trade.id,
      txHash: outcome.txHash,
    };
  }

  const decimals = input.decoded.tokenOut?.decimals ?? input.token.decimals ?? 0;
  const tokensReceived = outcome.actualAmountRaw ? wholeUnits(outcome.actualAmountRaw, decimals) : 0;
  const spentQuote = sizing.sizeQuote;
  const thisFillPriceUsd =
    tokensReceived > 0 && portfolio.balance.quotePriceUsd > 0
      ? (spentQuote * portfolio.balance.quotePriceUsd) / tokensReceived
      : input.market.priceUsd;

  let entryPriceUsd = thisFillPriceUsd;
  if (scaleIn) {
    const prevRemaining = BigInt(position.remainingTokenRaw ?? position.tokenAmountRaw ?? '0');
    const added = BigInt(outcome.actualAmountRaw ?? '0');
    const newRemaining = prevRemaining + added;
    const prevQuoteRaw = BigInt(position.actualQuoteRaw ?? '0');
    const newQuoteRaw = prevQuoteRaw + BigInt(requestedRaw);
    const prevTokens = wholeUnits(prevRemaining.toString(), decimals);
    const prevEntry = Number(position.entryPriceUsd ?? 0);
    const prevValue = Number(position.entryValueUsd ?? 0);
    if (prevTokens + tokensReceived > 0) {
      entryPriceUsd =
        (prevEntry * prevTokens + thisFillPriceUsd * tokensReceived) / (prevTokens + tokensReceived);
    }
    const scaledLevels = computeExitLevels(entryPriceUsd, config);
    const feeAdd = outcome.networkFeeRaw
      ? wholeUnits(outcome.networkFeeRaw, chainMeta.nativeDecimals)
      : 0;
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: PositionStatus.OPEN,
        actualQuoteRaw: newQuoteRaw.toString(),
        tokenAmountRaw: (
          BigInt(position.tokenAmountRaw ?? '0') + added
        ).toString(),
        remainingTokenRaw: newRemaining.toString(),
        entryPriceUsd,
        entryQuotePriceUsd: portfolio.balance.quotePriceUsd,
        entryValueUsd: prevValue + sizing.sizeUsd,
        entrySlippagePct: outcome.realizedSlippagePct,
        entryPriceImpactPct: outcome.priceImpactPct,
        stopLossPriceUsd: scaledLevels.stopLossPriceUsd,
        takeProfitPriceUsd: scaledLevels.takeProfitPriceUsd,
        lastPriceUsd: thisFillPriceUsd,
        lastPriceAt: new Date(),
        feesQuote: { increment: feeAdd },
      },
    });
  } else {
    await prisma.position.update({
      where: { id: position.id },
      data: {
        status: PositionStatus.OPEN,
        openedAt: outcome.telemetry.at('confirmed') ?? new Date(),
        actualQuoteRaw: requestedRaw,
        tokenAmountRaw: outcome.actualAmountRaw,
        remainingTokenRaw: outcome.actualAmountRaw,
        entryPriceUsd,
        entryQuotePriceUsd: portfolio.balance.quotePriceUsd,
        entryValueUsd: sizing.sizeUsd,
        entrySlippagePct: outcome.realizedSlippagePct,
        entryPriceImpactPct: outcome.priceImpactPct,
        lastPriceUsd: entryPriceUsd,
        lastPriceAt: new Date(),
        feesQuote: outcome.networkFeeRaw
          ? wholeUnits(outcome.networkFeeRaw, chainMeta.nativeDecimals)
          : 0,
      },
    });
  }

  const mark = await getMarketSnapshot(input.chain, input.tokenAddress).catch(() => input.market);
  const pnl = await getPnlSummary(settings.pnlResetAt, ownerUserId);
  telegram.send(
    renderBuy({
      chain: input.chain,
      tokenSymbol: mark.symbol ?? input.token.symbol ?? input.tokenAddress.slice(0, 6),
      tokenAddress: input.tokenAddress,
      marketCapUsd: mark.marketCapUsd,
      liquidityUsd: mark.liquidityUsd,
      traderLabel: input.trader.label,
      traderAddress: input.trader.address,
      spentQuote,
      spentUsd: sizing.sizeUsd,
      balanceSharePct:
        portfolio.state.tradingBalanceQuote > 0
          ? (spentQuote / portfolio.state.tradingBalanceQuote) * 100
          : null,
      executionPriceUsd: entryPriceUsd,
      requestedSlippageBps: config.maxSlippageBps,
      realizedSlippagePct: outcome.realizedSlippagePct,
      priceImpactPct: outcome.priceImpactPct,
      feeNative: outcome.networkFeeRaw
        ? wholeUnits(outcome.networkFeeRaw, chainMeta.nativeDecimals)
        : null,
      speedMs: telemetry.sinceStart('confirmed') ?? null,
      exitStrategy: config.exitStrategy,
      exitConfig: {
        takeProfitPct: config.takeProfitPct,
        stopLossPct: config.stopLossPct,
        trailingDropPct: config.trailingDropPct,
        trailingPartialSellPct: config.trailingPartialSellPct,
      },
      balanceQuote: portfolio.balance.totalQuote - spentQuote,
      balanceUsd: (portfolio.balance.totalQuote - spentQuote) * portfolio.balance.quotePriceUsd,
      openPnlQuote: pnl.unrealizedPnlQuote,
      txHash: outcome.txHash as string,
    }),
    { kind: 'buy-confirmed', tradeId: trade.id, positionId: position.id, userId: ownerUserId },
  );

  log.info(
    { token: input.tokenAddress, txHash: outcome.txHash, latencyMs: telemetry.sinceStart('confirmed') },
    'Copy buy confirmed on-chain',
  );

  return {
    status: SignalStatus.EXECUTED,
    signalId: signal.id,
    positionId: position.id,
    tradeId: trade.id,
    txHash: outcome.txHash,
  };
}
