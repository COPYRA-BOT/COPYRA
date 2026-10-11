import { PublicKey } from '@solana/web3.js';
import { Chain } from '@copyra/db';
import { getMarketSnapshot } from '../market/index.js';
import { componentLogger } from '../obs/logger.js';
import { solanaPool, WRAPPED_SOL_MINT_STR } from '../solana/connection.js';
import { getJupiterQuote } from '../solana/jupiter.js';
import { probePumpBondingCurve, resolveSniperExecutionRoute } from './pump-adapter.js';
import type { SniperConfig, SniperDiscoveryEvent, SniperEnrichment } from './types.js';

const log = componentLogger('sniper-enrich');

async function readMintAuthorities(
  mint: string,
): Promise<{ mintAuthority: string | null; freezeAuthority: string | null; decimals: number | null }> {
  try {
    const info = await solanaPool().call('getParsedAccountInfo', (c) =>
      c.getParsedAccountInfo(new PublicKey(mint)),
    );
    const account = info.value.value;
    const parsed = (account?.data as { parsed?: { info?: Record<string, unknown> } } | undefined)
      ?.parsed?.info;
    if (!parsed) return { mintAuthority: 'unknown', freezeAuthority: 'unknown', decimals: null };
    const mintAuth = parsed.mintAuthority;
    const freezeAuth = parsed.freezeAuthority;
    const decimals = typeof parsed.decimals === 'number' ? parsed.decimals : null;
    return {
      mintAuthority: mintAuth ? String(mintAuth) : null,
      freezeAuthority: freezeAuth ? String(freezeAuth) : null,
      decimals,
    };
  } catch (error) {
    log.warn({ mint, err: error }, 'mint authority read failed');
    return { mintAuthority: 'unknown', freezeAuthority: 'unknown', decimals: null };
  }
}

async function readTopHolderPct(mint: string): Promise<number | null> {
  try {
    const largest = await solanaPool().call('getTokenLargestAccounts', (c) =>
      c.getTokenLargestAccounts(new PublicKey(mint)),
    );
    const rows = largest.value.value ?? [];
    if (!rows.length) return null;
    const amounts = rows
      .map((r: { uiAmount?: number | null }) => Number(r.uiAmount ?? 0))
      .filter((n: number) => Number.isFinite(n));
    const total = amounts.reduce((a: number, b: number) => a + b, 0);
    if (!(total > 0)) return null;
    return (amounts[0]! / total) * 100;
  } catch (error) {
    log.warn({ mint, err: error }, 'top holder read failed');
    return null;
  }
}

/**
 * Enrich a discovery with market + mint safety + Pump.fun curve probe.
 * Failures surface as nulls / enrichErrors so qualify can reject (fail closed).
 */
export async function enrichSniperToken(
  event: SniperDiscoveryEvent,
  config: SniperConfig,
  sizeSol: number,
): Promise<SniperEnrichment> {
  const errors: string[] = [];
  const mint = event.tokenAddress;
  const blacklistHit = config.tokenBlacklist.some(
    (b) => b === mint.toLowerCase() || b === mint,
  );

  const [market, authorities, topHolderPct, pump] = await Promise.all([
    getMarketSnapshot(Chain.SOLANA, mint).catch((error: unknown) => {
      errors.push(`market:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    readMintAuthorities(mint),
    readTopHolderPct(mint),
    probePumpBondingCurve(mint, { programId: config.pumpFunProgramId }).catch((error: unknown) => {
      errors.push(`pump:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
  ]);

  // Fresh snapshot from our cache/RPC path — age 0 when present.
  let marketAgeMs = market && !market.missing ? 0 : null;
  if (!market || market.missing) errors.push('market:missing');

  // Prefer DexScreener/market; USD from curve only when we also have SOL/USD.
  let priceUsd = market && !market.missing && market.priceUsd > 0 ? market.priceUsd : null;
  const marketCapUsd = market?.marketCapUsd ?? null;
  let liquidityUsd = market?.liquidityUsd ?? null;
  const volume24hUsd = market?.volume24hUsd ?? null;
  let marketSource = market?.source ?? null;

  if (pump?.tradeable && pump.virtualSol != null) {
    try {
      const solMarket = await getMarketSnapshot(
        Chain.SOLANA,
        WRAPPED_SOL_MINT_STR,
      ).catch(() => null);
      const solUsd =
        solMarket && !solMarket.missing && solMarket.priceUsd > 0 ? solMarket.priceUsd : null;
      if (solUsd != null) {
        const curveLiq = pump.virtualSol * solUsd;
        if (liquidityUsd == null || !(liquidityUsd > 0)) {
          liquidityUsd = curveLiq;
          marketSource = marketSource ? `${marketSource}+pump.curve` : 'pump.curve';
          marketAgeMs = 0;
        }
        if ((priceUsd == null || !(priceUsd > 0)) && pump.priceSolEstimate != null) {
          priceUsd = pump.priceSolEstimate * solUsd;
          marketSource = marketSource ? `${marketSource}+pump.curve` : 'pump.curve';
          marketAgeMs = 0;
        }
      }
    } catch (error) {
      errors.push(`solUsd:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const lamports = Math.max(1, Math.floor(sizeSol * 1e9));
  let jupiterBuyOk = false;
  let jupiterSellOk = false;
  let priceImpactBps: number | null = null;
  let expectedSlippageBps: number | null = null;

  try {
    const buy = await getJupiterQuote({
      inputMint: WRAPPED_SOL_MINT_STR,
      outputMint: mint,
      amountRaw: String(lamports),
      slippageBps: config.maxSlippageBps,
    });
    jupiterBuyOk = Boolean(buy.quote?.outAmount && BigInt(buy.quote.outAmount) > 0n);
    if (buy.priceImpactPct != null && Number.isFinite(buy.priceImpactPct)) {
      priceImpactBps = Math.round(buy.priceImpactPct * 100);
    }
    expectedSlippageBps = config.maxSlippageBps;
    if (!jupiterBuyOk) errors.push('buyRoute:empty');
  } catch (error) {
    jupiterBuyOk = false;
    errors.push(`buyRoute:${error instanceof Error ? error.message : String(error)}`);
  }

  if (authorities.decimals != null && jupiterBuyOk) {
    try {
      const sellAmount = String(10 ** Math.min(authorities.decimals, 6));
      const sell = await getJupiterQuote({
        inputMint: mint,
        outputMint: WRAPPED_SOL_MINT_STR,
        amountRaw: sellAmount,
        slippageBps: config.maxSlippageBps,
      });
      jupiterSellOk = Boolean(sell.quote?.outAmount && BigInt(sell.quote.outAmount) > 0n);
      if (!jupiterSellOk) errors.push('sellRoute:empty');
    } catch (error) {
      jupiterSellOk = false;
      errors.push(`sellRoute:${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (jupiterBuyOk) {
    errors.push('sellRoute:decimals-unknown');
  }

  const routed = resolveSniperExecutionRoute({
    jupiterBuyOk,
    jupiterSellOk,
    pump,
  });

  // Pump.fun curve alone is not enough for live broadcast until Jupiter/PumpSwap
  // can quote — keep fail-closed for execution, but record curve tradeability.
  let buyRouteOk: boolean | null = routed.buyRouteOk;
  let sellRouteOk: boolean | null = routed.sellRouteOk;
  if (routed.route === 'pump.fun' && !jupiterBuyOk) {
    // Curve is live but we require a simulatable Jupiter/PumpSwap quote for broadcast.
    buyRouteOk = false;
    sellRouteOk = false;
    errors.push('route:pump-curve-active-awaiting-jupiter-or-pumpswap');
  }

  // Impact/slippage required — if only pump path and no Jupiter quote, leave null (reject).
  if (priceImpactBps == null && routed.route === 'jupiter') {
    errors.push('impact:missing');
  }
  if (expectedSlippageBps == null && jupiterBuyOk) {
    expectedSlippageBps = config.maxSlippageBps;
  }

  let swapActivityOk: boolean | null = null;
  if (market && !market.missing) {
    const vol = market.volume24hUsd;
    if (vol == null) {
      swapActivityOk = null;
      errors.push('activity:volume-unknown');
    } else {
      // Genuine activity: require positive volume; brand-new creates often have 0 → reject.
      swapActivityOk = vol > 0;
      if (!swapActivityOk) errors.push('activity:zero-volume');
    }
  } else if (pump?.tradeable && event.eventKind === 'create') {
    // Create event itself is on-chain activity, but volume is unverified — fail closed.
    swapActivityOk = null;
    errors.push('activity:create-without-verified-swaps');
  }

  if (authorities.mintAuthority === 'unknown') errors.push('mintAuthority:unread');
  if (authorities.freezeAuthority === 'unknown') errors.push('freezeAuthority:unread');

  // Soft notes (route awaiting Jupiter, holder unread) are not enrichErrors —
  // qualify handles buyRouteOk / topHolderPct null ("where data is available").
  const hardErrors = errors.filter(
    (e) =>
      !e.startsWith('route:pump-curve-active') &&
      !e.startsWith('activity:create-without') &&
      !e.startsWith('buyRoute:') &&
      !e.startsWith('sellRoute:'),
  );

  return {
    symbol: market?.symbol ?? null,
    name: market?.name ?? null,
    decimals: authorities.decimals,
    priceUsd,
    marketCapUsd,
    liquidityUsd,
    volume24hUsd,
    marketSource,
    marketAgeMs,
    mintAuthority:
      authorities.mintAuthority === 'unknown' ? 'unknown' : authorities.mintAuthority,
    freezeAuthority:
      authorities.freezeAuthority === 'unknown' ? 'unknown' : authorities.freezeAuthority,
    topHolderPct,
    holderCount: null,
    swapActivityOk,
    buyRouteOk,
    sellRouteOk,
    executionRoute: routed.route === 'none' ? 'none' : jupiterBuyOk ? 'jupiter' : routed.route,
    priceImpactBps,
    expectedSlippageBps,
    blacklistHit,
    enrichErrors: hardErrors,
  };
}
