import { PublicKey } from '@solana/web3.js';
import { Chain } from '@copyra/db';
import { getMarketSnapshot } from '../market/index.js';
import { componentLogger } from '../obs/logger.js';
import { solanaPool, WRAPPED_SOL_MINT_STR } from '../solana/connection.js';
import { getJupiterQuote } from '../solana/jupiter.js';
import { bondingCurvePda, probePumpBondingCurve, resolveSniperExecutionRoute } from './pump-adapter.js';
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

async function readHolderStats(
  mint: string,
  opts: { creatorAddress: string | null; bondingCurve: string | null },
): Promise<{
  topHolderPct: number | null;
  holderCount: number | null;
  devHoldingPct: number | null;
  sniperPct: number | null;
}> {
  try {
    const largest = await solanaPool().call('getTokenLargestAccounts', (c) =>
      c.getTokenLargestAccounts(new PublicKey(mint)),
    );
    const rows = largest.value.value ?? [];
    if (!rows.length) {
      return { topHolderPct: null, holderCount: null, devHoldingPct: null, sniperPct: null };
    }

    type Row = { address: string; amount: number; uiAmount: number };
    const parsed: Row[] = rows
      .map((r: { address: string; amount?: string; uiAmount?: number | null }) => ({
        address: r.address,
        amount: Number(r.amount ?? 0),
        uiAmount: Number(r.uiAmount ?? 0),
      }))
      .filter((r: Row) => Number.isFinite(r.uiAmount) && r.uiAmount > 0);

    const total = parsed.reduce((a, b) => a + b.uiAmount, 0);
    if (!(total > 0)) {
      return { topHolderPct: null, holderCount: parsed.length, devHoldingPct: null, sniperPct: null };
    }

    const exclude = new Set(
      [opts.bondingCurve].filter((x): x is string => Boolean(x)).map((a) => a),
    );
    // Token largest accounts return token-account addresses, not wallets — we
    // still use concentration of the top accounts as a risk proxy.
    const ranked = [...parsed].sort((a, b) => b.uiAmount - a.uiAmount);
    const nonCurve = ranked.filter((r) => !exclude.has(r.address));
    const top = (nonCurve[0] ?? ranked[0])!;
    const topHolderPct = (top.uiAmount / total) * 100;

    // Early sniper concentration ≈ top 3 non-curve accounts.
    const early = nonCurve.slice(0, 3).reduce((a, b) => a + b.uiAmount, 0);
    const sniperPct = (early / total) * 100;

    let devHoldingPct: number | null = null;
    if (opts.creatorAddress) {
      // Creator match is best-effort; token accounts ≠ owner wallets on this RPC call.
      // Leave null unless we later resolve ATA owners (fail-closed when required).
      devHoldingPct = null;
    }

    return {
      topHolderPct,
      holderCount: parsed.length,
      devHoldingPct,
      sniperPct,
    };
  } catch (error) {
    log.warn({ mint, err: error }, 'holder stats read failed');
    return { topHolderPct: null, holderCount: null, devHoldingPct: null, sniperPct: null };
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

  let bondingCurve: string | null = null;
  try {
    bondingCurve = bondingCurvePda(mint, config.pumpFunProgramId).toBase58();
  } catch {
    bondingCurve = null;
  }

  const [market, authorities, holders, pump] = await Promise.all([
    getMarketSnapshot(Chain.SOLANA, mint).catch((error: unknown) => {
      errors.push(`market:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
    readMintAuthorities(mint),
    readHolderStats(mint, {
      creatorAddress: event.creatorAddress,
      bondingCurve,
    }),
    probePumpBondingCurve(mint, { programId: config.pumpFunProgramId }).catch((error: unknown) => {
      errors.push(`pump:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }),
  ]);

  let marketAgeMs = market && !market.missing ? 0 : null;
  if (!market || market.missing) errors.push('market:missing');

  let priceUsd = market && !market.missing && market.priceUsd > 0 ? market.priceUsd : null;
  const marketCapUsd = market?.marketCapUsd ?? null;
  let liquidityUsd = market?.liquidityUsd ?? null;
  const volume24hUsd = market?.volume24hUsd ?? null;
  let marketSource = market?.source ?? null;

  if (pump?.tradeable && pump.virtualSol != null) {
    try {
      const solMarket = await getMarketSnapshot(Chain.SOLANA, WRAPPED_SOL_MINT_STR).catch(
        () => null,
      );
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

  // Token age: prefer Dexscreener pairCreatedAt; for create events fall back to observedAt.
  let tokenAgeMin: number | null = null;
  let pairCreatedAt: string | null = null;
  if (market?.pairCreatedAt) {
    pairCreatedAt = market.pairCreatedAt.toISOString();
    tokenAgeMin = Math.max(0, (Date.now() - market.pairCreatedAt.getTime()) / 60_000);
  } else if (event.eventKind === 'create') {
    pairCreatedAt = event.observedAt.toISOString();
    tokenAgeMin = Math.max(0, (Date.now() - event.observedAt.getTime()) / 60_000);
  }

  const hasTwitter = market && !market.missing ? Boolean(market.hasTwitter) : null;
  const hasWebsite = market && !market.missing ? Boolean(market.hasWebsite) : null;
  const hasTelegram = market && !market.missing ? Boolean(market.hasTelegram) : null;
  const hasProfile =
    hasTwitter == null && hasWebsite == null && hasTelegram == null
      ? null
      : Boolean(hasTwitter || hasWebsite || hasTelegram || market?.imageUrl);

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

  let buyRouteOk: boolean | null = routed.buyRouteOk;
  let sellRouteOk: boolean | null = routed.sellRouteOk;
  if (routed.route === 'pump.fun' && !jupiterBuyOk) {
    buyRouteOk = false;
    sellRouteOk = false;
    errors.push('route:pump-curve-active-awaiting-jupiter-or-pumpswap');
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
      swapActivityOk = vol > 0;
      if (!swapActivityOk) errors.push('activity:zero-volume');
    }
  } else if (pump?.tradeable && event.eventKind === 'create') {
    swapActivityOk = null;
    errors.push('activity:create-without-verified-swaps');
  }

  if (authorities.mintAuthority === 'unknown') errors.push('mintAuthority:unread');
  if (authorities.freezeAuthority === 'unknown') errors.push('freezeAuthority:unread');

  const hardErrors = errors.filter(
    (e) =>
      !e.startsWith('route:pump-curve-active') &&
      !e.startsWith('activity:create-without') &&
      !e.startsWith('buyRoute:') &&
      !e.startsWith('sellRoute:'),
  );

  const migrated = Boolean(event.migrated || pump?.complete === true);

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
    tokenAgeMin,
    pairCreatedAt,
    imageUrl: market?.imageUrl ?? null,
    hasTwitter,
    hasWebsite,
    hasTelegram,
    hasProfile,
    mintAuthority:
      authorities.mintAuthority === 'unknown' ? 'unknown' : authorities.mintAuthority,
    freezeAuthority:
      authorities.freezeAuthority === 'unknown' ? 'unknown' : authorities.freezeAuthority,
    topHolderPct: holders.topHolderPct,
    holderCount: holders.holderCount,
    devHoldingPct: holders.devHoldingPct,
    sniperPct: holders.sniperPct,
    migrated,
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
