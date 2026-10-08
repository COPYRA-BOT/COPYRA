import {
  MAX_SUPPORTED_TX_VERSION,
  clearSeen,
  componentLogger,
  decodeSolanaTransaction,
  getMarketSnapshot,
  getStrategyConfig,
  handleQualifiedCopy,
  isSolanaQuoteAsset,
  markSeenOnce,
  qualifySignal,
  sleep,
  solanaPool,
  solanaSubscriptionConnection,
  telegram,
  traderHasPriorBuyOfToken,
  renderSkip,
  renderDetection,
} from '@copyra/core';
import { Chain, prisma, SignalStatus, TxClassification } from '@copyra/db';
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';

const log = componentLogger('solana-monitor');

/** How long we wait for a processed-commitment log to become fetchable. */
const TX_FETCH_ATTEMPTS = 4;
const TX_FETCH_BASE_DELAY_MS = 40;
/** Recent signatures to re-scan per trader on each catch-up tick. */
const CATCHUP_LIMIT = 20;
/** Ignore catch-up signatures older than this (avoids 15–20s “Detected in” spam). */
const CATCHUP_MAX_AGE_MS = 45_000;
/** Outcomes that mean "try again later" — never treat as final. */
const RETRYABLE_OUTCOMES = new Set(['tx-not-found', 'deferred']);
/** Classifications that are noise for Telegram (no copy path). */
const SILENT_CLASSIFICATIONS = new Set<string>([
  TxClassification.UNKNOWN,
  TxClassification.TRANSFER_IN,
  TxClassification.TRANSFER_OUT,
  TxClassification.APPROVAL,
]);

/**
 * Real-time Solana trader monitor.
 *
 * Subscribes to confirmed logs for each enabled Solana trader wallet through
 * the configured Helius/Alchemy connection. Every notification is a real
 * signature; nothing is invented.
 *
 * Also runs a catch-up poll so signatures that raced `getParsedTransaction`
 * (processed log → confirmed fetch returns null) are not permanently lost.
 */
/** Rebuild every onLogs subscription on this interval so a dead Helius WS cannot strand the worker. */
const FORCE_RESUB_MS = 120_000;

export async function startSolanaMonitor(): Promise<() => void> {
  let connection = solanaSubscriptionConnection();
  const subscriptions = new Map<string, number>();
  let syncing = false;
  let lastForceResub = 0;

  const dropAll = async () => {
    for (const [traderId, sub] of subscriptions) {
      try {
        await connection.removeOnLogsListener(sub);
      } catch {
        /* socket may already be dead */
      }
      subscriptions.delete(traderId);
    }
  };

  const sync = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const force = Date.now() - lastForceResub >= FORCE_RESUB_MS;
      if (force) {
        await dropAll();
        connection = solanaSubscriptionConnection(true);
        lastForceResub = Date.now();
        log.info({}, 'Forced Solana log resubscribe (fresh WS)');
      }

      const traders = await prisma.trader.findMany({
        where: { chain: Chain.SOLANA, enabled: true },
      });
      const wanted = new Set(traders.map((trader) => trader.id));

      for (const [traderId, sub] of subscriptions) {
        if (wanted.has(traderId)) continue;
        try {
          await connection.removeOnLogsListener(sub);
        } catch {
          /* ignore */
        }
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

      // Catch up any signatures the live stream dropped (tx-not-found race, reconnect gaps).
      await Promise.all(
        traders.map(async (trader) => {
          try {
            await catchUpTrader(trader.id, trader.address);
          } catch (error) {
            log.warn({ err: error, trader: trader.label }, 'Solana catch-up failed');
          }
        }),
      );

      log.info({ watching: subscriptions.size }, 'Solana wallet subscriptions are current');
    } finally {
      syncing = false;
    }
  };

  await sync();
  const timer = setInterval(() => {
    void sync().catch((error: unknown) => {
      log.error({ err: error }, 'Failed to refresh trader subscriptions');
    });
  }, 15_000);

  return () => {
    clearInterval(timer);
    void dropAll();
  };
}

/**
 * Re-scan recent signatures for a trader. Replays anything not yet finalized,
 * including rows previously marked `tx-not-found`.
 */
async function catchUpTrader(traderId: string, address: string): Promise<void> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    return;
  }

  const fetched = await solanaPool().call('getSignaturesForAddress', (client) =>
    client.getSignaturesForAddress(pubkey, { limit: CATCHUP_LIMIT }),
  );
  const entries = fetched.value ?? [];
  if (entries.length === 0) return;

  const now = Date.now();
  for (const entry of entries) {
    if (entry.err) continue;
    // Skip stale history — live onLogs already covers the hot path.
    if (entry.blockTime && now - entry.blockTime * 1000 > CATCHUP_MAX_AGE_MS) continue;
    const signature = entry.signature;
    const existing = await prisma.processedSignature.findUnique({
      where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
    });
    if (existing && !RETRYABLE_OUTCOMES.has(existing.outcome)) continue;

    if (existing && RETRYABLE_OUTCOMES.has(existing.outcome)) {
      await prisma.processedSignature.delete({
        where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
      });
    }
    await clearSeen(`sol:${signature}:${traderId}`);
    const slot = entry.slot ?? 0;
    await handleSignature(traderId, signature, slot);
  }
}

/**
 * Fetch tx ASAP: try `processed` first (matches log subscription), then escalate
 * to `confirmed`. Keeps detect→decode on the sub-second path without inventing data.
 */
async function fetchParsedTransaction(
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 1; attempt <= TX_FETCH_ATTEMPTS; attempt += 1) {
    // web3.js types only allow Finality (confirmed|finalized); Helius/Alchemy
    // also serve processed, which matches our log subscription and lands earlier.
    const commitment = (attempt === 1 ? 'processed' : 'confirmed') as 'confirmed';
    const fetched = await solanaPool().call('getParsedTransaction', (client) =>
      client.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment,
      }),
    );
    if (fetched.value) return fetched.value;
    if (attempt === TX_FETCH_ATTEMPTS) break;
    const delay = TX_FETCH_BASE_DELAY_MS * attempt;
    log.debug({ signature, attempt, delay, commitment }, 'Parsed tx not ready; retrying');
    await sleep(delay);
  }
  return null;
}

async function handleSignature(traderId: string, signature: string, slot: number): Promise<void> {
  const first = await markSeenOnce(`sol:${signature}:${traderId}`, 86_400);
  if (!first) return;

  const existing = await prisma.processedSignature.findUnique({
    where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
  });
  if (existing && !RETRYABLE_OUTCOMES.has(existing.outcome)) return;
  if (existing && RETRYABLE_OUTCOMES.has(existing.outcome)) {
    await prisma.processedSignature.delete({
      where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
    });
  }

  const trader = await prisma.trader.findUnique({ where: { id: traderId } });
  if (!trader || !trader.enabled) return;

  const tx = await fetchParsedTransaction(signature);
  if (!tx) {
    // Do NOT permanently discard — clear the redis mark and record a retryable outcome
    // so the next catch-up tick can re-fetch once the RPC has the tx.
    await clearSeen(`sol:${signature}:${traderId}`);
    await prisma.processedSignature.upsert({
      where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
      create: { chain: Chain.SOLANA, signature, traderId, outcome: 'tx-not-found' },
      update: { outcome: 'tx-not-found', processedAt: new Date() },
    });
    log.warn({ signature, traderId, slot }, 'Trader tx not fetchable yet; deferred for catch-up');
    return;
  }

  // Already decoded+signaled (e.g. prior partial path) — finalize idempotency and stop.
  const priorDetection = await prisma.detectedTransaction.findUnique({
    where: { chain_txHash_traderId: { chain: Chain.SOLANA, txHash: signature, traderId } },
    include: { signal: { select: { id: true, status: true } } },
  });
  if (priorDetection?.signal) {
    await prisma.processedSignature.upsert({
      where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
      create: {
        chain: Chain.SOLANA,
        signature,
        traderId,
        outcome: String(priorDetection.signal.status),
      },
      update: { outcome: String(priorDetection.signal.status), processedAt: new Date() },
    });
    return;
  }

  const decoded = decodeSolanaTransaction({
    tx,
    signature,
    traderAddress: trader.address,
    observedAt: new Date(),
  });

  const detection =
    priorDetection ??
    (await prisma.detectedTransaction.create({
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
    }));

  await prisma.trader.update({
    where: { id: trader.id },
    data: { lastActivityAt: new Date(), lastSignature: signature },
  });

  const tokenAddress = decoded.tokenOut?.address ?? decoded.tokenIn?.address ?? null;
  // Skip Telegram spam for fee-only / unknown / transfer noise with no tradeable leg.
  const notifyDetection =
    !priorDetection &&
    !SILENT_CLASSIFICATIONS.has(decoded.classification) &&
    Boolean(tokenAddress);
  if (notifyDetection) {
    telegram.send(
      renderDetection({
        chain: Chain.SOLANA,
        traderLabel: trader.label,
        traderAddress: trader.address,
        classification: decoded.classification,
        tokenSymbol: decoded.tokenOut?.symbol ?? decoded.tokenIn?.symbol ?? null,
        tokenAddress,
        sourceTxHash: signature,
        detectLatencyMs: decoded.blockTime ? Date.now() - decoded.blockTime.getTime() : null,
      }),
      { kind: 'detection', userId: trader.userId },
    );
  }

  if (!tokenAddress || decoded.classification !== TxClassification.BUY) {
    await prisma.processedSignature.upsert({
      where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
      create: { chain: Chain.SOLANA, signature, traderId, outcome: decoded.classification },
      update: { outcome: decoded.classification, processedAt: new Date() },
    });
    return;
  }

  // Parallelize market + DB lookups — sequential awaits were eating the 1s budget.
  const [token, market, firstBuy, open, config, openPositionCount, traderAlreadyBought] =
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
    // First-buy-only = this watched trader's first BUY of the token (not our book).
    traderHasPriorBuyOfToken({
      traderId: trader.id,
      chain: Chain.SOLANA,
      tokenAddress,
      excludeTxHash: signature,
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
    isFirstBuy: !traderAlreadyBought,
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

  await prisma.processedSignature.upsert({
    where: { chain_signature_traderId: { chain: Chain.SOLANA, signature, traderId } },
    create: { chain: Chain.SOLANA, signature, traderId, outcome: result.status },
    update: { outcome: result.status, processedAt: new Date() },
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
