import { chainConfig, fetchJson, getDexscreenerMarket } from '@copyra/core';
import { Chain, prisma, PositionStatus, TradeSide, TradingMode, TxStatus } from '@copyra/db';

const GECKO = 'https://api.geckoterminal.com/api/v2';

const NETWORK: Partial<Record<Chain, string>> = {
  [Chain.SOLANA]: 'solana',
  [Chain.ETHEREUM]: 'eth',
  [Chain.BASE]: 'base',
  [Chain.ARBITRUM]: 'arbitrum',
  [Chain.BSC]: 'bsc',
  [Chain.POLYGON]: 'polygon_pos',
  [Chain.OPTIMISM]: 'optimism',
};

export type ChartTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const TF: Record<
  ChartTimeframe,
  { timeframe: 'minute' | 'hour' | 'day'; aggregate: number; limit: number }
> = {
  '1m': { timeframe: 'minute', aggregate: 1, limit: 180 },
  '5m': { timeframe: 'minute', aggregate: 5, limit: 200 },
  '15m': { timeframe: 'minute', aggregate: 15, limit: 200 },
  '1h': { timeframe: 'hour', aggregate: 1, limit: 168 },
  '4h': { timeframe: 'hour', aggregate: 4, limit: 180 },
  '1d': { timeframe: 'day', aggregate: 1, limit: 90 },
};

export interface ChartCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ChartMarker {
  kind: 'trader_entry' | 'user_entry' | 'user_exit';
  at: string;
  priceUsd: number | null;
  label: string;
  txHash: string | null;
  explorerUrl: string | null;
}

function geckoNetwork(chain: Chain): string | null {
  return NETWORK[chain] ?? null;
}

async function fetchOhlcv(
  network: string,
  tokenAddress: string,
  pairAddress: string | null,
  tf: ChartTimeframe,
): Promise<ChartCandle[]> {
  const spec = TF[tf];
  const paths = [
    pairAddress
      ? `${GECKO}/networks/${network}/pools/${pairAddress}/ohlcv/${spec.timeframe}?aggregate=${spec.aggregate}&limit=${spec.limit}&currency=usd`
      : null,
    `${GECKO}/networks/${network}/tokens/${tokenAddress}/ohlcv/${spec.timeframe}?aggregate=${spec.aggregate}&limit=${spec.limit}&currency=usd`,
  ].filter((u): u is string => Boolean(u));

  for (const url of paths) {
    try {
      const { data } = await fetchJson<{
        data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
      }>(url, { timeoutMs: 8_000, label: 'geckoterminal/ohlcv', headers: { accept: 'application/json' } });
      const list = data.data?.attributes?.ohlcv_list ?? [];
      if (!list.length) continue;
      return list
        .map(([t, o, h, l, c, v]) => ({
          t: t * (t < 1e12 ? 1000 : 1),
          o,
          h,
          l,
          c,
          v,
        }))
        .filter((c) => c.c > 0 && c.h > 0)
        .sort((a, b) => a.t - b.t);
    } catch {
      /* try next path */
    }
  }
  return [];
}

/**
 * Live chart payload for one open (or recently closed) position:
 * candles from GeckoTerminal + Dexscreener mark, plus trader/user trade markers.
 */
export async function buildPositionChart(
  userId: string,
  positionId: string,
  timeframe: ChartTimeframe = '15m',
): Promise<Record<string, unknown>> {
  const position = await prisma.position.findFirst({
    where: { id: positionId, userId },
    include: {
      token: true,
      trades: {
        where: { status: TxStatus.CONFIRMED },
        orderBy: { createdAt: 'asc' },
        take: 40,
      },
      signals: {
        include: { trader: true, detection: true },
        orderBy: { createdAt: 'asc' },
        take: 8,
      },
    },
  });
  if (!position) {
    throw Object.assign(new Error('Position not found'), { statusCode: 404 });
  }

  const chain = position.chain;
  const tokenAddress = position.tokenAddress;
  const network = geckoNetwork(chain);
  const cfg = chainConfig(chain);

  const market = await getDexscreenerMarket(chain, tokenAddress).catch(() => null);
  const pairAddress = market?.pairAddress ?? null;

  const candles =
    network != null
      ? await fetchOhlcv(network, tokenAddress, pairAddress, timeframe)
      : [];

  const signal = position.signals[0] ?? null;
  const trader = signal?.trader ?? null;
  const markers: ChartMarker[] = [];

  if (signal) {
    markers.push({
      kind: 'trader_entry',
      at: (signal.detection?.blockTime ?? signal.createdAt).toISOString(),
      priceUsd: signal.priceUsdAtSignal != null ? Number(signal.priceUsdAtSignal) : null,
      label: trader?.label ? `${trader.label} buy` : 'Copy trader buy',
      txHash: signal.sourceTxHash,
      explorerUrl: signal.sourceTxHash ? `${cfg.explorerTxBase}${signal.sourceTxHash}` : null,
    });
  }

  for (const trade of position.trades) {
    const isBuy = trade.side === TradeSide.BUY;
    markers.push({
      kind: isBuy ? 'user_entry' : 'user_exit',
      at: (trade.confirmedAt ?? trade.createdAt).toISOString(),
      priceUsd: trade.executionPriceUsd != null ? Number(trade.executionPriceUsd) : null,
      label: isBuy
        ? 'Your entry'
        : `Your exit${trade.reason ? ` · ${String(trade.reason).replaceAll('_', ' ')}` : ''}`,
      txHash: trade.txHash,
      explorerUrl: trade.explorerUrl ?? (trade.txHash ? `${cfg.explorerTxBase}${trade.txHash}` : null),
    });
  }

  const entry = position.entryPriceUsd != null ? Number(position.entryPriceUsd) : null;
  const last = position.lastPriceUsd != null ? Number(position.lastPriceUsd) : market?.priceUsd ?? null;
  const modeRow = await prisma.userModeSettings
    .findFirst({
      where: {
        userId,
        mode: chain === Chain.SOLANA ? TradingMode.SOL : TradingMode.EVM,
      },
    })
    .catch(() => null);

  return {
    position: {
      id: position.id,
      status: position.status,
      chain,
      tokenAddress,
      tokenSymbol: position.tokenSymbol ?? position.token?.symbol ?? tokenAddress.slice(0, 6),
      tokenName: position.token?.name ?? null,
      entryPriceUsd: entry,
      lastPriceUsd: last,
      entryMarketCapUsd: position.entryMarketCapUsd != null ? Number(position.entryMarketCapUsd) : null,
      entryLiquidityUsd: position.entryLiquidityUsd != null ? Number(position.entryLiquidityUsd) : null,
      entryValueUsd: position.entryValueUsd != null ? Number(position.entryValueUsd) : null,
      unrealizedPnlPct: position.unrealizedPnlPct != null ? Number(position.unrealizedPnlPct) : null,
      stopLossPriceUsd: position.stopLossPriceUsd != null ? Number(position.stopLossPriceUsd) : null,
      takeProfitPriceUsd:
        position.takeProfitPriceUsd != null ? Number(position.takeProfitPriceUsd) : null,
      exitStrategy: position.exitStrategy,
      openedAt: position.openedAt?.toISOString() ?? position.createdAt.toISOString(),
      open: (
        [
          PositionStatus.OPEN,
          PositionStatus.PARTIALLY_CLOSED,
          PositionStatus.PENDING_OPEN,
        ] as PositionStatus[]
      ).includes(position.status),
    },
    trader: trader
      ? {
          id: trader.id,
          label: trader.label,
          address: trader.address,
        }
      : null,
    market: {
      priceUsd: market && !market.missing ? market.priceUsd : last,
      marketCapUsd: market?.marketCapUsd ?? null,
      liquidityUsd: market?.liquidityUsd ?? null,
      symbol: market?.symbol ?? position.tokenSymbol,
      name: market?.name ?? position.token?.name,
      pairAddress,
      dexId: market?.dexId ?? null,
      source: market?.source ?? null,
      changePct:
        entry && last && entry > 0 ? ((last - entry) / entry) * 100 : null,
    },
    strategy: {
      exitStrategy: position.exitStrategy,
      takeProfitPct: modeRow ? Number(modeRow.takeProfitPct) : null,
      stopLossPct: modeRow ? Number(modeRow.stopLossPct) : null,
      tradeAllocationPct: modeRow ? Number(modeRow.tradeAllocationPct) : null,
      firstBuyOnly: modeRow?.firstBuyOnly ?? null,
      maxSlippageBps: modeRow?.maxSlippageBps ?? null,
      sizingQuote:
        position.actualQuoteRaw != null
          ? Number(position.actualQuoteRaw) / 10 ** cfg.quoteAssetDecimals
          : null,
      quoteSymbol: cfg.quoteAssetSymbol,
    },
    markers,
    candles,
    timeframe,
    explorer: {
      token: `${cfg.explorerTokenBase}${tokenAddress}`,
      name: cfg.explorerName,
    },
    refreshedAt: new Date().toISOString(),
  };
}
