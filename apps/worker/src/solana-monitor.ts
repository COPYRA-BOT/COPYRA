import {
  MAX_SUPPORTED_TX_VERSION,
  componentLogger,
  decodeSolanaTransaction,
  getMarketSnapshot,
  getStrategyConfig,
  isSolanaQuoteAsset,
  markSeenOnce,
  qualifySignal,
  solanaConnection,
  solanaPool,
  telegram,
  renderSkip,
  renderDetection,
} from '@copyra/core';
import { Chain, prisma, SignalStatus, SkipReason, TxClassification } from '@copyra/db';
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
      const id = connection.onLogs(
        pubkey,
        (logs, ctx) => {
          void handleSignature(trader.id, logs.signature, ctx.slot).catch((error: unknown) => {
            log.error({ err: error, signature: logs.signature }, 'Failed to handle trader log');
          });
        },
        'confirmed',
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
    where: { chain_signature: { chain: Chain.SOLANA, signature } },
  });
  if (existing) return;

  const trader = await prisma.trader.findUnique({ where: { id: traderId } });
  if (!trader || !trader.enabled) return;

  const fetched = await solanaPool().call('getParsedTransaction', (client) =>
    client.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
      commitment: 'confirmed',
    }),
  );
  const tx = fetched.value;
  if (!tx) {
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, outcome: 'tx-not-found' },
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
    { kind: 'detection' },
  );

  const tokenAddress = decoded.tokenOut?.address ?? decoded.tokenIn?.address;
  if (!tokenAddress) {
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, outcome: decoded.classification },
    });
    return;
  }

  const token = await prisma.token.upsert({
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
  });

  const market = await getMarketSnapshot(Chain.SOLANA, tokenAddress);
  if (!market.missing) {
    await prisma.token.update({
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
    });
  }

  const firstBuy = await prisma.tokenFirstBuy.findUnique({
    where: { chain_tokenAddress: { chain: Chain.SOLANA, tokenAddress } },
  });
  const open = await prisma.position.findFirst({
    where: {
      chain: Chain.SOLANA,
      tokenAddress,
      status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED', 'CLOSING'] },
    },
  });

  const config = await getStrategyConfig();
  const qualification = qualifySignal({
    decoded,
    market,
    config,
    portfolio: {
      tradingBalanceQuote: 0,
      quotePriceUsd: 0,
      deployedUsd: 0,
      openPositionCount: await prisma.position.count({
        where: { status: { in: ['PENDING_OPEN', 'OPEN', 'PARTIALLY_CLOSED'] } },
      }),
      existingPositionForToken: open !== null,
      readAtBlock: null,
      readAt: new Date(),
    },
    traderEnabled: trader.enabled,
    tokenBlacklisted: token.blacklisted,
    isFirstBuy: firstBuy === null,
    chainCanExecute: true,
    correlatedTraderCount: (firstBuy?.correlatedBuys ?? 0) + 1,
    spendLegIsQuoteAsset: Boolean(decoded.tokenIn && isSolanaQuoteAsset(decoded.tokenIn.address)),
  });

  if (!qualification.qualified) {
    await prisma.signal.create({
      data: {
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
      { kind: 'skip' },
    );
    await prisma.processedSignature.create({
      data: { chain: Chain.SOLANA, signature, outcome: `skipped:${qualification.reason}` },
    });
    return;
  }

  // Qualified — but execution requires a signer and TRADING_ENABLED.
  const { solanaSigner } = await import('@copyra/core');
  const status = !solanaSigner.available
    ? SignalStatus.BLOCKED_NO_SIGNER
    : !config.tradingEnabled
      ? SignalStatus.BLOCKED_DISABLED
      : SignalStatus.QUALIFIED;

  if (firstBuy === null) {
    await prisma.tokenFirstBuy.create({
      data: {
        chain: Chain.SOLANA,
        tokenAddress,
        tokenId: token.id,
        firstTraderId: trader.id,
        firstSourceTx: signature,
      },
    });
  } else {
    await prisma.tokenFirstBuy.update({
      where: { id: firstBuy.id },
      data: { correlatedBuys: { increment: 1 }, lastCorrelatedAt: new Date() },
    });
  }

  await prisma.signal.create({
    data: {
      chain: Chain.SOLANA,
      traderId: trader.id,
      tokenId: token.id,
      tokenAddress,
      detectionId: detection.id,
      sourceTxHash: signature,
      status,
      skipReason: status === SignalStatus.QUALIFIED ? null : SkipReason.TRADER_DISABLED,
      skipDetail:
        status === SignalStatus.BLOCKED_NO_SIGNER
          ? 'Qualified, but no server-side signing key is configured. No transaction was broadcast.'
          : status === SignalStatus.BLOCKED_DISABLED
            ? 'Qualified, but trading is disabled by the host/settings guard.'
            : null,
      signalStrength: qualification.signalStrength,
      marketCapUsdAtSignal: market.marketCapUsd,
      liquidityUsdAtSignal: market.liquidityUsd,
      priceUsdAtSignal: market.priceUsd,
      decodedAt: new Date(),
      qualifiedAt: new Date(),
    },
  });

  await prisma.processedSignature.create({
    data: { chain: Chain.SOLANA, signature, outcome: status },
  });

  log.info(
    { signature, trader: trader.label, token: tokenAddress, status, classification: decoded.classification },
    'Processed trader transaction',
  );
}

export { TxClassification };
