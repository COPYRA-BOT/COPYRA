import { SkipReason } from '@copyra/db';
import type { MarketCapTier, SizingBasis, SizingInput, SizingResult } from './types.js';

/**
 * How much of the pool a single trade may consume, as a fraction of pool
 * liquidity. Trading more than this against a small pool guarantees a bad fill
 * regardless of what the aggregator quotes, so it is capped before the quote is
 * even requested. The quote's own `priceImpactPct` is still checked afterwards
 * — this is a pre-filter, not a replacement.
 */
const MAX_POOL_SHARE = 0.01;

export function tierMaxPct(tier: MarketCapTier, config: SizingInput['config']): number {
  switch (tier) {
    case 1:
      return config.tier1MaxPct;
    case 2:
      return config.tier2MaxPct;
    case 3:
      return config.tier3MaxPct;
    case 4:
      return config.tier4MaxPct;
  }
}

/**
 * Position sizing (spec §7, §8).
 *
 * Resolution order, each a hard ceiling on the one before:
 *   1. trading balance, valued in USD at the live quote-asset price
 *   2. minus the protected reserve (spec §8 — never consumed)
 *   3. capped by total deployment headroom (80% of trading balance, spec §7)
 *   4. capped by the market-cap tier percentage (spec §7)
 *   5. capped by pool-liquidity share
 *   6. capped by MAX_TRADE_USD, the operator's absolute backstop
 * then scaled within the tier cap by signal strength, which can only ever
 * reduce — never raise — the ceiling.
 *
 * Pure function. `basis` records every input so a size can be re-derived from
 * the database months later.
 */
export function calculatePositionSize(input: SizingInput): SizingResult {
  const { config, portfolio, market, tier } = input;

  const tradingBalanceUsd = portfolio.tradingBalanceQuote * portfolio.quotePriceUsd;
  const reserveUsd = tradingBalanceUsd * (config.reservePct / 100);
  const availableUsd = Math.max(0, tradingBalanceUsd - reserveUsd);

  const maxDeploymentUsd = tradingBalanceUsd * (config.maxDeploymentPct / 100);
  const deploymentHeadroomUsd = Math.max(0, maxDeploymentUsd - portfolio.deployedUsd);

  const pct = tierMaxPct(tier, config);
  const tierCapUsd = tradingBalanceUsd * (pct / 100);

  const liquidityCapUsd =
    market.liquidityUsd !== null ? market.liquidityUsd * MAX_POOL_SHARE : null;

  // Signal strength scales within the tier cap. 1.0 -> 2/3 of the cap,
  // 1.5 (max) -> the full cap. It can never exceed the cap.
  const strengthScale = Math.min(1, (2 / 3) * Math.min(1.5, Math.max(1, input.signalStrength)));
  const strengthAdjustedTierUsd = tierCapUsd * strengthScale;

  const allocPct = Math.min(100, Math.max(1, config.tradeAllocationPct || 100));
  const allocationCapUsd = availableUsd * (allocPct / 100);

  const candidates: Array<{ label: string; value: number }> = [
    { label: 'available balance after reserve', value: availableUsd },
    { label: `trade allocation (${allocPct}% of available)`, value: allocationCapUsd },
    { label: 'max deployment headroom (80%)', value: deploymentHeadroomUsd },
    { label: `tier ${tier} cap (${pct}%)`, value: strengthAdjustedTierUsd },
    { label: 'absolute max trade size', value: input.absoluteMaxUsd },
  ];
  if (liquidityCapUsd !== null) {
    candidates.push({ label: 'pool liquidity share (1%)', value: liquidityCapUsd });
  }

  let binding = candidates[0] as { label: string; value: number };
  for (const candidate of candidates) {
    if (candidate.value < binding.value) binding = candidate;
  }
  let chosenUsd = Math.max(0, binding.value);
  let bindingLabel = binding.label;

  // Soft caps (tier % × signal strength, allocation) can undershoot the saved
  // minimum even when the wallet can afford a min-size buy. Floor to minTradeUsd
  // against hard ceilings only — never invent size above available / headroom /
  // liquidity / absolute max. Fixes BELOW_MIN skips on ~$0.30 wallets that still
  // clear a ~$0.12 minimum after reserve.
  const hardCeilUsd = Math.min(
    availableUsd,
    deploymentHeadroomUsd,
    input.absoluteMaxUsd,
    liquidityCapUsd ?? Number.POSITIVE_INFINITY,
  );
  if (chosenUsd < config.minTradeUsd && hardCeilUsd >= config.minTradeUsd) {
    chosenUsd = config.minTradeUsd;
    bindingLabel = `min trade floor (was ${binding.label})`;
  }

  const basis: SizingBasis = {
    tradingBalanceQuote: portfolio.tradingBalanceQuote,
    quotePriceUsd: portfolio.quotePriceUsd,
    tradingBalanceUsd,
    reservePct: config.reservePct,
    reserveUsd,
    availableUsd,
    maxDeploymentPct: config.maxDeploymentPct,
    maxDeploymentUsd,
    alreadyDeployedUsd: portfolio.deployedUsd,
    deploymentHeadroomUsd,
    tier,
    tierMaxPct: pct,
    tierCapUsd,
    liquidityCapUsd,
    absoluteMaxUsd: input.absoluteMaxUsd,
    minTradeUsd: config.minTradeUsd,
    chosenUsd,
    bindingConstraint: bindingLabel,
  };

  if (portfolio.quotePriceUsd <= 0) {
    return {
      ok: false,
      reason: SkipReason.RPC_UNAVAILABLE,
      detail: 'Quote-asset USD price is unavailable; the trade cannot be sized safely.',
      basis,
    };
  }
  if (availableUsd <= 0) {
    return {
      ok: false,
      reason: SkipReason.RESERVE_PROTECTED,
      detail: `Entire $${tradingBalanceUsd.toFixed(2)} trading balance is inside the ${config.reservePct}% reserve.`,
      basis,
    };
  }
  if (deploymentHeadroomUsd <= 0) {
    return {
      ok: false,
      reason: SkipReason.MAX_DEPLOYMENT_REACHED,
      detail: `$${portfolio.deployedUsd.toFixed(2)} already deployed against a $${maxDeploymentUsd.toFixed(
        2,
      )} ceiling (${config.maxDeploymentPct}%).`,
      basis,
    };
  }
  if (chosenUsd < config.minTradeUsd) {
    return {
      ok: false,
      reason: SkipReason.INSUFFICIENT_BALANCE,
      detail:
        `Trading balance $${tradingBalanceUsd.toFixed(2)} (available $${availableUsd.toFixed(2)} after ${config.reservePct}% reserve) ` +
        `cannot fund the $${config.minTradeUsd} minimum` +
        (bindingLabel !== 'available balance after reserve' ? ` (soft cap was ${binding.label})` : '') +
        '. Deposit more SOL to custody trading balance.',
      basis,
    };
  }

  const sizeQuote = chosenUsd / portfolio.quotePriceUsd;
  if (sizeQuote > portfolio.tradingBalanceQuote) {
    return {
      ok: false,
      reason: SkipReason.INSUFFICIENT_BALANCE,
      detail: `Computed size ${sizeQuote.toFixed(6)} exceeds the on-chain balance ${portfolio.tradingBalanceQuote.toFixed(6)}.`,
      basis,
    };
  }

  return { ok: true, sizeQuote, sizeUsd: chosenUsd, basis };
}
