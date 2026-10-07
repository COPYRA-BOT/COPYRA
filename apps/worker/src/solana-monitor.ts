import {
  MAX_SUPPORTED_TX_VERSION,
  componentLogger,
  decodeSolanaTransaction,
  getMarketSnapshot,
  getStrategyConfig,
  handleQualifiedCopy,
  isSolanaQuoteAsset,
  markSeenOnce,
  qualifySignal,
  solanaConnection,
  solanaPool,
  telegram,
  renderSkip,
  renderDetection,
} from '@copyra/core';
import { Chain, prisma, SignalStatus, TxClassification } from '@copyra/db';
import { PublicKey } from '@solana/web3.js';

const log = componentLogger('solana-monitor');

/**
 * Real-time Solana trader monitor.
 *
 * Subscribes to confirmed logs for each enabled Solana trader wallet through
 * the configured Helius/Alchemy connection. Every notification is a real
 * signature; nothing is invented.
 */
export async function startSolanaMonitor(): Promise<() => void> {
  const connection = solanaConnection();
  const subscriptions = new Map<string, number>();

  const sync = async () => {
    const traders = await prisma.trader.findMany({
      where: { chain: Chain.SOLANA, enabled: true },
    });
    const wanted = new Set(traders.map((trader) => trader.id));

    for (const [traderId, sub] of subscriptions) {
      if (wanted.has(traderId)) continue;
      await connection.removeOnLogsListener(sub);
      subscriptions.delete(traderId);
      log.info({ traderId }, 'Dropped Solana log subscription');
    }

    for (const trader of traders) {
      if (subscriptions.has(trader.id)) continue;
      let pubkey: PublicKey;
      try {
        pubkey = new PublicKey(trader.address);
      } catch {
        log.warn({ trader: trader.label, address: trader.address }, 'Skipping invalid Solana address');
        continue;
      }
      // 'processed' fires as soon as a leader sees the tx — shaves hundreds of ms vs confirmed.
      const id = connection.onLogs(
        pubkey,
        (logs, ctx) => {
          void handleSignature(trader.id, logs.signature, ctx.slot).catch((error: unknown) => {
            log.error({ err: error, signature: logs.signature }, 'Failed to handle trader log');
          });
        },
        'processed',
      );
      subscriptions.set(trader.id, id);
      log.info({ trader: trader.label, address: trader.address, sub: id }, 'Subscribed to trader logs');
    }

    log.info({ watching: subscriptions.size }, 'Solana wallet subscriptions are current');
  };

  await sync();
  const timer = setInterval(() => {
    void sync().catch((error: unknown) => {
      log.error({ err: error }, 'Failed to refresh trader subscriptions');
    });
  }, 15_000);

  return () => {
    clearInterval(timer);
    for (const id of subscriptions.values()) {
      void connection.removeOnLogsListener(id);
    }
    subscriptions.clear();
  };
}

async function handleSignature(traderId: string, signature: string, slot: number): Promise<void> {
  const first = await markSeenOnce(`sol:${signature}:${traderId}`, 86_400);
  if (!first) return;

  const existing = await prisma.processedSignature.findUnique({
    where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
  });
  if (existing) return;

  const trader = await prisma.trader.findUnique({ where: { id: traderId } });
  if (!trader || !trader.enabled) return;

  const fetched = await solanaPool().call('getParsedTransaction', (client) =>
    client.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
      commitment: 'confirmed', // parse at confirmed for stable balances; detect already used processed logs
    }),
  );
  const tx = fetched.value;
  if (!tx) {
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, traderId, outcome: 'tx-not-found' },
    });
    return;
  }

  const decoded = decodeSolanaTransaction({
    tx,
    signature,
    traderAddress: trader.address,
    observedAt: new Date(),
  });

  const detection = await prisma.detectedTransaction.create({
    data: {
      chain: Chain.SOLANA,
      txHash: signature,
      traderId: trader.id,
      blockNumber: BigInt(slot),
      blockTime: decoded.blockTime,
      classification: decoded.classification,
      venue: decoded.venue,
      tokenInAddress: decoded.tokenIn?.address,
      tokenInSymbol: decoded.tokenIn?.symbol,
      tokenInDecimals: decoded.tokenIn?.decimals,
      tokenInAmountRaw: decoded.tokenIn?.amountRaw,
      tokenOutAddress: decoded.tokenOut?.address,
      tokenOutSymbol: decoded.tokenOut?.symbol,
      tokenOutDecimals: decoded.tokenOut?.decimals,
      tokenOutAmountRaw: decoded.tokenOut?.amountRaw,
      feeRaw: decoded.feeRaw,
      rawDecoded: decoded.raw as object,
      decodedAt: new Date(),
    },
  });

  await prisma.trader.update({
    where: { id: trader.id },
    data: { lastActivityAt: new Date(), lastSignature: signature },
  });

  telegram.send(
    renderDetection({
      chain: Chain.SOLANA,
      traderLabel: trader.label,
      traderAddress: trader.address,
      classification: decoded.classification,
      tokenSymbol: decoded.tokenOut?.symbol ?? decoded.tokenIn?.symbol ?? null,
      tokenAddress: decoded.tokenOut?.address ?? decoded.tokenIn?.address ?? null,
      sourceTxHash: signature,
      detectLatencyMs: decoded.blockTime ? Date.now() - decoded.blockTime.getTime() : null,
    }),
    { kind: 'detection', userId: trader.userId },
  );

  const tokenAddress = decoded.tokenOut?.address ?? decoded.tokenIn?.address;
  if (!tokenAddress) {
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, traderId, outcome: decoded.classification },
    });
    return;
  }

  // Parallelize market + DB lookups — sequential awaits were eating the 1s budget.
  const [token, market, firstBuy, open, config, openPositionCount, accountAlreadyTraded] =
    await Promise.all([
    prisma.token.upsert({
      where: { chain_address: { chain: Chain.SOLANA, address: tokenAddress } },
      create: {
        chain: Chain.SOLANA,
        address: tokenAddress,
        symbol: decoded.tokenOut?.symbol ?? null,
        decimals: decoded.tokenOut?.decimals ?? null,
      },
      update: {
        decimals: decoded.tokenOut?.decimals ?? undefined,
      },
    }),
    getMarketSnapshot(Chain.SOLANA, tokenAddress),
    prisma.tokenFirstBuy.findUnique({
      where: { chain_tokenAddress: { chain: Chain.SOLANA, tokenAddress } },
    }),
    prisma.position.findFirst({
      where: {
        userId: trader.userId,
        chain: Chain.SOLANA,
        tokenAddress,
        status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSING'] },
      },
    }),
    getStrategyConfig(),
    prisma.position.count({
      where: {
        userId: trader.userId,
        status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED'] },
      },
    }),
    // First-buy is per account — another wallet's history must not skip this user.
    prisma.signal.findFirst({
      where: {
        userId: trader.userId,
        chain: Chain.SOLANA,
        tokenAddress,
        status: { in: ['EXECUTED', 'EXECUTING', 'QUALIFIED'] },
      },
      select: { id: true },
    }),
  ]);
  if (!market.missing) {
    void prisma.token
      .update({
        where: { id: token.id },
        data: {
          symbol: market.symbol ?? token.symbol,
          name: market.name ?? token.name,
          priceUsd: market.priceUsd,
          marketCapUsd: market.marketCapUsd,
          fdvUsd: market.fdvUsd,
          liquidityUsd: market.liquidityUsd,
          volume24hUsd: market.volume24hUsd,
          marketSource: market.source,
          marketUpdatedAt: market.fetchedAt,
        },
      })
      .catch(() => undefined);
  }

  const qualification = qualifySignal({
    decoded,
    market,
    config: { ...config, tradingEnabled: true },
    portfolio: {
      tradingBalanceQuote: 0,
      quotePriceUsd: 0,
      deployedUsd: 0,
      openPositionCount,
      existingPositionForToken: open !== null,
      readAtBlock: null,
      readAt: new Date(),
    },
    traderEnabled: trader.enabled,
    tokenBlacklisted: token.blacklisted,
    isFirstBuy: accountAlreadyTraded === null,
    chainCanExecute: true,
    correlatedTraderCount: (firstBuy?.correlatedBuys ?? 0) + 1,
    spendLegIsQuoteAsset: Boolean(decoded.tokenIn && isSolanaQuoteAsset(decoded.tokenIn.address)),
  });

  if (!qualification.qualified) {
    await prisma.signal.create({
      data: {
        userId: trader.userId,
        chain: Chain.SOLANA,
        traderId: trader.id,
        tokenId: token.id,
        tokenAddress,
        detectionId: detection.id,
        sourceTxHash: signature,
        status: SignalStatus.SKIPPED,
        skipReason: qualification.reason,
        skipDetail: qualification.detail,
        marketCapUsdAtSignal: market.marketCapUsd,
        liquidityUsdAtSignal: market.liquidityUsd,
        priceUsdAtSignal: market.priceUsd,
        decodedAt: new Date(),
        qualifiedAt: new Date(),
      },
    });
    telegram.send(
      renderSkip({
        chain: Chain.SOLANA,
        tokenSymbol: market.symbol,
        tokenAddress,
        traderLabel: trader.label,
        traderAddress: trader.address,
        reason: qualification.reason,
        detail: qualification.detail,
        marketCapUsd: market.marketCapUsd,
        liquidityUsd: market.liquidityUsd,
        sourceTxHash: signature,
      }),
      { kind: 'skip', userId: trader.userId },
    );
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, traderId, outcome: `skipped:${qualification.reason}` },
    });
    return;
  }

  const result = await handleQualifiedCopy({
    chain: Chain.SOLANA,
    trader,
    token,
    tokenAddress,
    decoded,
    market,
    signalStrength: qualification.signalStrength,
    marketCapTier: qualification.marketCapTier,
    detectionId: detection.id,
    sourceTxHash: signature,
    observedAt: decoded.blockTime ?? new Date(),
  });

  await prisma.processedSignature.create({
    data: { chain: Chain.SOLANA, signature, traderId, outcome: result.status },
  });

  log.info(
    {
      signature,
      trader: trader.label,
      token: tokenAddress,
      status: result.status,
      txHash: result.txHash,
      classification: decoded.classification,
    },
    'Processed trader transaction',
  );
}

export { TxClassification };
