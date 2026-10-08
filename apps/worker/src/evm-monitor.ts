import {
  chainConfig,
  clearSeen,
  componentLogger,
  decodeEvmTransaction,
  evmPool,
  getMarketSnapshot,
  getStrategyConfig,
  handleQualifiedCopy,
  isEvmQuoteAsset,
  markSeenOnce,
  qualifySignal,
  renderDetection,
  renderSkip,
  sleep,
  telegram,
  traderHasPriorBuyOfToken,
} from '@copyra/core';
import { Chain, prisma, SignalStatus, TxClassification } from '@copyra/db';
import { getAddress } from 'viem';
import { touchEvmProcessed, touchEvmTick } from './activity.js';

const log = componentLogger('evm-monitor');

/** All executable EVM venues COPYRA can copy-trade on. */
const POLL_CHAINS: Chain[] = [Chain.ETHEREUM, Chain.BASE, Chain.ARBITRUM, Chain.BSC];
/** Fast poll so detect→qualify stays on the sub-second path with WS-class RPCs. */
const EVM_POLL_MS = 250;

interface AssetTransfer {
  hash: string;
  from: string;
  to: string;
  category: string;
  blockNum: string;
  metadata?: { blockTimestamp?: string };
}

/**
 * Polls Alchemy `alchemy_getAssetTransfers` for enabled EVM traders.
 * Base is always first. Arbitrum and BNB are included only when those chains
 * are enabled in strategy settings.
 */
export async function startEvmMonitor(): Promise<() => void> {
  const cursors = new Map<string, string>();
  let stopped = false;
  /** Never overlap ticks — stacked 250ms polls were hanging the whole worker. */
  let ticking = false;

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // Poll every EVM chain that has an RPC + enabled traders.
      // Do not gate detection on strategy.enabledChains — that list controls
      // execution only; missing BASE/ETH traders previously looked like “EVM dead”.
      const traders = await prisma.trader.findMany({
        where: { chain: { in: POLL_CHAINS }, enabled: true },
      });
      const pollable = traders.filter((t) => Boolean(chainConfig(t.chain).rpcUrl));
      if (pollable.length === 0) {
        touchEvmTick();
        return;
      }

      // Parallel polls across traders — sequential 4s loops were the EVM detect floor.
      await Promise.all(
        pollable.map(async (trader) => {
          if (stopped) return;
          try {
            await pollTrader(trader.chain, trader.id, trader.address, cursors);
          } catch (error) {
            log.error({ err: error, trader: trader.label, chain: trader.chain }, 'EVM poll failed');
          }
        }),
      );
      touchEvmTick();
    } finally {
      ticking = false;
    }
  };

  await tick();
  const timer = setInterval(() => {
    void tick();
  }, EVM_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function pollTrader(
  chain: Chain,
  traderId: string,
  address: string,
  cursors: Map<string, string>,
): Promise<void> {
  const config = chainConfig(chain);
  if (!config.rpcUrl) return;
  const key = `${chain}:${address}`;
  const params: Record<string, unknown> = {
    fromAddress: getAddress(address),
    category: ['external', 'erc20', 'internal'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x14',
    order: 'asc',
  };
  const cursor = cursors.get(key);
  if (cursor) params.fromBlock = cursor;

  // Hard timeout — a hung Alchemy socket previously stalled every subsequent tick.
  const response = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [params],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`alchemy_getAssetTransfers HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: { transfers?: AssetTransfer[]; pageKey?: string };
    error?: { message: string };
  };
  if (body.error) throw new Error(body.error.message);

  const transfers = body.result?.transfers ?? [];
  let maxBlock = cursor ?? '0x0';
  const seen = new Set<string>();
  for (const transfer of transfers) {
    if (BigInt(transfer.blockNum) > BigInt(maxBlock)) maxBlock = transfer.blockNum;
    if (seen.has(transfer.hash)) continue;
    seen.add(transfer.hash);
    await handleEvmHash(chain, traderId, transfer.hash);
  }
  cursors.set(key, maxBlock);
}

async function fetchEvmReceipt(chain: Chain, hash: string) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const receiptResult = await evmPool(chain).call('getTransactionReceipt', (client) =>
      client.getTransactionReceipt({ hash: hash as `0x${string}` }),
    );
    if (receiptResult.value) return receiptResult.value;
    if (attempt === 5) break;
    await sleep(40 * attempt);
  }
  return null;
}

async function handleEvmHash(chain: Chain, traderId: string, hash: string): Promise<void> {
  const first = await markSeenOnce(`evm:${hash}:${traderId}`, 86_400);
  if (!first) return;
  const existing = await prisma.processedSignature.findUnique({
    where: { chain_signature_traderId: { chain, signature: hash, traderId } },
  });
  if (existing && existing.outcome !== 'receipt-not-found') return;
  if (existing?.outcome === 'receipt-not-found') {
    await prisma.processedSignature.delete({
      where: { chain_signature_traderId: { chain, signature: hash, traderId } },
    });
  }

  const trader = await prisma.trader.findUnique({ where: { id: traderId } });
  if (!trader || !trader.enabled) return;
  touchEvmProcessed();

  const receipt = await fetchEvmReceipt(chain, hash);
  if (!receipt) {
    await clearSeen(`evm:${hash}:${traderId}`);
    await prisma.processedSignature.upsert({
      where: { chain_signature_traderId: { chain, signature: hash, traderId } },
      create: { chain, signature: hash, traderId, outcome: 'receipt-not-found' },
      update: { outcome: 'receipt-not-found', processedAt: new Date() },
    });
    return;
  }

  const txResult = await evmPool(chain).call('getTransaction', (client) =>
    client.getTransaction({ hash: hash as `0x${string}` }),
  );
  const tx = txResult.value;
  const decoded = await decodeEvmTransaction({
    chain,
    receipt,
    traderAddress: trader.address,
    nativeValue: tx?.value ?? 0n,
    blockTimestamp: null,
    toAddress: tx?.to ?? receipt.to ?? null,
  });

  const detection = await prisma.detectedTransaction.create({
    data: {
      chain,
      txHash: hash,
      traderId: trader.id,
      blockNumber: receipt.blockNumber,
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
    data: { lastActivityAt: new Date(), lastSignature: hash },
  });

  const tokenAddress = decoded.tokenOut?.address ?? decoded.tokenIn?.address ?? null;
  const silent =
    decoded.classification === TxClassification.UNKNOWN ||
    decoded.classification === TxClassification.TRANSFER_IN ||
    decoded.classification === TxClassification.TRANSFER_OUT ||
    decoded.classification === TxClassification.APPROVAL ||
    !tokenAddress;
  if (!silent) {
    telegram.send(
      renderDetection({
        chain,
        traderLabel: trader.label,
        traderAddress: trader.address,
        classification: decoded.classification,
        tokenSymbol: decoded.tokenOut?.symbol ?? decoded.tokenIn?.symbol ?? null,
        tokenAddress,
        sourceTxHash: hash,
        detectLatencyMs: null,
      }),
      { kind: 'detection', userId: trader.userId },
    );
  }

  if (!tokenAddress || decoded.classification !== TxClassification.BUY) {
    await prisma.processedSignature.upsert({
      where: { chain_signature_traderId: { chain, signature: hash, traderId } },
      create: { chain, signature: hash, traderId, outcome: decoded.classification },
      update: { outcome: decoded.classification, processedAt: new Date() },
    });
    return;
  }

  const [token, market, firstBuy, open, config, openPositionCount, traderAlreadyBought] =
    await Promise.all([
    prisma.token.upsert({
      where: { chain_address: { chain, address: tokenAddress } },
      create: {
        chain,
        address: tokenAddress,
        symbol: decoded.tokenOut?.symbol ?? null,
        decimals: decoded.tokenOut?.decimals ?? null,
      },
      update: { decimals: decoded.tokenOut?.decimals ?? undefined },
    }),
    getMarketSnapshot(chain, tokenAddress),
    prisma.tokenFirstBuy.findUnique({
      where: { chain_tokenAddress: { chain, tokenAddress } },
    }),
    prisma.position.findFirst({
      where: {
        userId: trader.userId,
        chain,
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
      chain,
      tokenAddress,
      excludeTxHash: hash,
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
    chainCanExecute: chainConfig(chain).canExecute,
    correlatedTraderCount: (firstBuy?.correlatedBuys ?? 0) + 1,
    spendLegIsQuoteAsset: Boolean(decoded.tokenIn && isEvmQuoteAsset(chain, decoded.tokenIn.address)),
  });

  if (!qualification.qualified) {
    await prisma.signal.create({
      data: {
        userId: trader.userId,
        chain,
        traderId: trader.id,
        tokenId: token.id,
        tokenAddress,
        detectionId: detection.id,
        sourceTxHash: hash,
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
        chain,
        tokenSymbol: market.symbol,
        tokenAddress,
        traderLabel: trader.label,
        traderAddress: trader.address,
        reason: qualification.reason,
        detail: qualification.detail,
        marketCapUsd: market.marketCapUsd,
        liquidityUsd: market.liquidityUsd,
        sourceTxHash: hash,
      }),
      { kind: 'skip', userId: trader.userId },
    );
    await prisma.processedSignature.create({
      data: { chain, signature: hash, traderId, outcome: `skipped:${qualification.reason}` },
    });
    return;
  }

  const result = await handleQualifiedCopy({
    chain,
    trader,
    token,
    tokenAddress,
    decoded,
    market,
    signalStrength: qualification.signalStrength,
    marketCapTier: qualification.marketCapTier,
    detectionId: detection.id,
    sourceTxHash: hash,
    observedAt: new Date(),
  });

  await prisma.processedSignature.create({
    data: { chain, signature: hash, traderId, outcome: result.status },
  });
  log.info({ hash, trader: trader.label, token: tokenAddress, status: result.status }, 'Processed EVM trader transaction');
}

export { TxClassification };
