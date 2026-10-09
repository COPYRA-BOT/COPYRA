import {
  MAX_SUPPORTED_TX_VERSION,
  clearSeen,
  componentLogger,
  decodeSolanaTransaction,
  getMarketSnapshot,
  getStrategyConfigFor,
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
import {
  touchSolanaProcessed,
  touchSolanaSync,
  touchSolanaWsEvent,
  workerActivity,
} from './activity.js';

const log = componentLogger('solana-monitor');

/** How long we wait for a processed-commitment log to become fetchable. */
const TX_FETCH_ATTEMPTS = 4;
const TX_FETCH_BASE_DELAY_MS = 40;
/** Recent signatures to re-scan per trader on each catch-up tick. */
const CATCHUP_LIMIT = 12;
/** Steady-state catch-up window — wide enough to recover RPC gaps without flood. */
const CATCHUP_MAX_AGE_MS = 120_000;
/** First sync after boot / forced WS resub — recover activity missed during a stall. */
const CATCHUP_RECOVERY_AGE_MS = 3 * 60_000;
/** Minimum gap between catch-up passes (subscriptions still refresh every sync). */
const CATCHUP_MIN_GAP_MS = 45_000;
/** Traders per catch-up pass — round-robin so each pass finishes fast and /health stays green. */
const CATCHUP_PER_PASS = 3;
/** Per-trader catch-up budget (must exceed getSignatures timeout inside catchUpTrader). */
const CATCHUP_TRADER_TIMEOUT_MS = 20_000;
/** Hard cap for one catch-up pass (must always clear `catchingUp`). */
const CATCHUP_PASS_TIMEOUT_MS = 60_000;
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
const FORCE_RESUB_MS = 180_000;
/** If WS delivers nothing while we are watching traders, force a fresh socket sooner. */
const WS_QUIET_RESUB_MS = 120_000;

/** Latest Solana monitor stats — merged into worker heartbeat by main. */
export const solanaMonitorStats: {
  watching: number;
  catchUpOk: number;
  catchUpErr: number;
  maxAgeMs: number;
  catchUpAt: string | null;
  lastForceResubAt: string | null;
  wsBound: boolean;
} = {
  watching: 0,
  catchUpOk: 0,
  catchUpErr: 0,
  maxAgeMs: 0,
  catchUpAt: null,
  lastForceResubAt: null,
  wsBound: false,
};

export async function startSolanaMonitor(): Promise<() => void> {
  let connection = solanaSubscriptionConnection();
  const subscriptions = new Map<string, number>();
  let syncing = false;
  /** Only one catch-up pass at a time — stacked ticks starved Prisma/API → site 504s. */
  let catchingUp = false;
  let lastCatchUpStartedAt = 0;
  /** Round-robin offset so all wallets get catch-up without one long blocking pass. */
  let catchUpCursor = 0;
  let lastForceResub = 0;
  let forceResubSoon = false;
  const bootAt = Date.now();
  /** Keep the wide recovery window for a few minutes after boot / forced resub. */
  let recoveryUntil = Date.now() + 3 * 60_000;

  const bindWsLifecycle = (conn: typeof connection) => {
    try {
      const ws = (conn as unknown as { _rpcWebSocket?: { on?: (ev: string, fn: () => void) => void } })
        ._rpcWebSocket;
      if (!ws?.on) {
        solanaMonitorStats.wsBound = false;
        return;
      }
      ws.on('close', () => {
        log.warn({}, 'Solana subscription WebSocket closed — scheduling force resub');
        forceResubSoon = true;
      });
      ws.on('error', () => {
        log.warn({}, 'Solana subscription WebSocket error — scheduling force resub');
        forceResubSoon = true;
      });
      solanaMonitorStats.wsBound = true;
    } catch {
      solanaMonitorStats.wsBound = false;
    }
  };
  bindWsLifecycle(connection);

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
    touchSolanaSync();
    try {
      const wsQuietMs = workerActivityAgeMs();
      const quietForce =
        subscriptions.size > 0 &&
        wsQuietMs > WS_QUIET_RESUB_MS &&
        Date.now() - lastForceResub > 60_000;
      const force =
        forceResubSoon || Date.now() - lastForceResub >= FORCE_RESUB_MS || quietForce;
      if (force) {
        forceResubSoon = false;
        await dropAll();
        touchSolanaSync();
        connection = solanaSubscriptionConnection(true);
        bindWsLifecycle(connection);
        lastForceResub = Date.now();
        solanaMonitorStats.lastForceResubAt = new Date().toISOString();
        recoveryUntil = Date.now() + 3 * 60_000;
        log.info({ quietForce, wsQuietMs }, 'Forced Solana log resubscribe (fresh WS)');
      }

      const traders = await prisma.trader.findMany({
        where: { chain: Chain.SOLANA, enabled: true },
      });
      touchSolanaSync();
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
            touchSolanaWsEvent(ctx.slot);
            void handleSignature(trader.id, logs.signature, ctx.slot).catch((error: unknown) => {
              log.error({ err: error, signature: logs.signature }, 'Failed to handle trader log');
            });
          },
          'processed',
        );
        subscriptions.set(trader.id, id);
        log.info({ trader: trader.label, address: trader.address, sub: id }, 'Subscribed to trader logs');
      }

      const maxAgeMs =
        Date.now() < recoveryUntil || Date.now() - bootAt < 3 * 60_000
          ? CATCHUP_RECOVERY_AGE_MS
          : CATCHUP_MAX_AGE_MS;

      solanaMonitorStats.watching = subscriptions.size;
      solanaMonitorStats.maxAgeMs = maxAgeMs;
      log.info({ watching: subscriptions.size, maxAgeMs }, 'Solana wallet subscriptions are current');
      touchSolanaSync();

      // Catch-up OUTSIDE the subscription critical path. Never stack passes —
      // overlapping catch-ups exhausted the Prisma pool (api+worker share the
      // host), froze heartbeats, and made Cloudflare return 504 on copyra.fun.
      // Round-robin a few traders per pass so WS detection stays primary and
      // each pass finishes before App Platform health checks flap.
      const catchUpDue = Date.now() - lastCatchUpStartedAt >= CATCHUP_MIN_GAP_MS;
      if (catchingUp || !catchUpDue || traders.length === 0) {
        log.debug(
          { watching: subscriptions.size, catchingUp, catchUpDue },
          'Solana catch-up skipped (in-flight or min gap)',
        );
      } else {
        const n = traders.length;
        const slice: typeof traders = [];
        for (let i = 0; i < Math.min(CATCHUP_PER_PASS, n); i++) {
          slice.push(traders[(catchUpCursor + i) % n]!);
        }
        catchUpCursor = (catchUpCursor + slice.length) % n;
        catchingUp = true;
        lastCatchUpStartedAt = Date.now();
        void (async () => {
          let catchUpOk = 0;
          let catchUpErr = 0;
          const passDeadline = Date.now() + CATCHUP_PASS_TIMEOUT_MS;
          try {
            for (let i = 0; i < slice.length; i++) {
              if (Date.now() > passDeadline) {
                catchUpErr += slice.length - i;
                log.warn({ left: slice.length - i }, 'Solana catch-up pass hit hard timeout');
                break;
              }
              const trader = slice[i]!;
              try {
                await Promise.race([
                  catchUpTrader(trader.id, trader.address, maxAgeMs),
                  sleep(CATCHUP_TRADER_TIMEOUT_MS).then(() => {
                    throw new Error(`catch-up timed out after ${CATCHUP_TRADER_TIMEOUT_MS}ms`);
                  }),
                ]);
                catchUpOk += 1;
              } catch (error) {
                catchUpErr += 1;
                log.warn({ err: error, trader: trader.label }, 'Solana catch-up failed');
              }
              // Keep watchdog clock alive mid-pass; yield for heartbeat/API.
              touchSolanaSync();
              if (i + 1 < slice.length) await sleep(250);
            }
          } finally {
            solanaMonitorStats.catchUpOk = catchUpOk;
            solanaMonitorStats.catchUpErr = catchUpErr;
            solanaMonitorStats.catchUpAt = new Date().toISOString();
            catchingUp = false;
            touchSolanaSync();
            log.info(
              { catchUpOk, catchUpErr, maxAgeMs, slice: slice.length },
              'Solana catch-up tick finished',
            );
          }
        })();
      }
      touchSolanaSync();
    } catch (error) {
      log.error({ err: error }, 'Solana sync failed — will retry next tick');
      forceResubSoon = true;
      touchSolanaSync();
    } finally {
      syncing = false;
    }
  };

  await sync();
  const timer = setInterval(() => {
    void sync().catch((error: unknown) => {
      log.error({ err: error }, 'Failed to refresh trader subscriptions');
      touchSolanaSync();
    });
  }, 15_000);

  return () => {
    clearInterval(timer);
    void dropAll();
  };
}

function workerActivityAgeMs(): number {
  if (!workerActivity.lastSolanaWsEventAt) {
    // No WS event yet after boot — do not force-resub until FORCE_RESUB_MS.
    return 0;
  }
  return Date.now() - workerActivity.lastSolanaWsEventAt;
}

/**
 * Re-scan recent signatures for a trader. Replays anything not yet finalized,
 * including rows previously marked `tx-not-found`.
 */
async function catchUpTrader(
  traderId: string,
  address: string,
  maxAgeMs: number = CATCHUP_MAX_AGE_MS,
): Promise<void> {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(address);
  } catch {
    return;
  }

  const fetched = await Promise.race([
    solanaPool().call('getSignaturesForAddress', (client) =>
      client.getSignaturesForAddress(pubkey, { limit: CATCHUP_LIMIT }),
    ),
    sleep(8_000).then(() => null),
  ]);
  if (!fetched) throw new Error('getSignaturesForAddress timed out');
  const entries = fetched.value ?? [];
  if (entries.length === 0) return;

  const now = Date.now();
  for (const entry of entries) {
    if (entry.err) continue;
    // Skip stale history — live onLogs already covers the hot path.
    if (entry.blockTime && now - entry.blockTime * 1000 > maxAgeMs) continue;
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
 * Fetch tx at `confirmed` commitment only.
 * Connection default is `confirmed`; requesting `processed` throws
 * "method requires at least confirmed" and took Helius out of rotation.
 */
async function fetchParsedTransaction(
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 1; attempt <= TX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const fetched = await Promise.race([
        solanaPool().call('getParsedTransaction', (client) =>
          client.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
            commitment: 'confirmed',
          }),
        ),
        sleep(5_000).then(() => null),
      ]);
      if (fetched?.value) return fetched.value;
    } catch (error) {
      log.debug({ signature, attempt, err: error }, 'Parsed tx fetch error');
    }
    if (attempt === TX_FETCH_ATTEMPTS) break;
    const delay = TX_FETCH_BASE_DELAY_MS * attempt;
    log.debug({ signature, attempt, delay, commitment: 'confirmed' }, 'Parsed tx not ready; retrying');
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
  touchSolanaProcessed(slot);

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
  const [token, market, firstBuy, open, strategyBundle, openPositionCount, traderAlreadyBought] =
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
    getStrategyConfigFor(trader.userId, Chain.SOLANA),
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
  const config = strategyBundle.config;
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
