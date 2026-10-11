import { SkipReason } from '@copyra/db';
import type { SniperConfig, SniperDiscoveryEvent, SniperEnrichment, SniperQualifyResult } from './types.js';

const STALE_DEFAULT_MS = 30_000;

/**
 * Fail-closed sniper qualification. Missing / stale / inconsistent safety data
 * rejects the token — never bypassed to increase trade frequency.
 */
export function qualifySniperToken(input: {
  event: SniperDiscoveryEvent;
  enrich: SniperEnrichment;
  config: SniperConfig;
  openSniperPositions: number;
  existingSniperPositionForToken: boolean;
  deployedSol: number;
  dailyLossSol: number;
}): SniperQualifyResult {
  const { event, enrich, config } = input;

  if (!config.enabled || config.emergencyStop || !config.engineOn) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DISABLED,
      detail: !config.enabled
        ? 'SNIPER_ENABLED is false on the host.'
        : config.emergencyStop
          ? 'Emergency stop is engaged.'
          : 'Sniper mode engine is not ON.',
    };
  }

  if (config.runtimeMode === 'monitor') {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DISABLED,
      detail: 'Sniper runtime mode is monitor-only — discoveries are recorded, never bought.',
    };
  }

  if (!config.allowedLaunchpads.includes(event.launchpad)) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_NO_ROUTE,
      detail: `Launchpad ${event.launchpad} is not in the allowed list.`,
    };
  }

  if (enrich.blacklistHit) {
    return {
      qualified: false,
      reason: SkipReason.BLACKLISTED,
      detail: 'Token matched the sniper blacklist.',
    };
  }

  if (input.existingSniperPositionForToken) {
    return {
      qualified: false,
      reason: SkipReason.POSITION_ALREADY_OPEN,
      detail: 'A sniper position is already open for this token.',
    };
  }

  if (input.openSniperPositions >= config.maxOpenPositions) {
    return {
      qualified: false,
      reason: SkipReason.MAX_POSITIONS_REACHED,
      detail: `${input.openSniperPositions}/${config.maxOpenPositions} sniper positions already open.`,
    };
  }

  if (input.dailyLossSol >= config.dailyLossLimitSol && config.dailyLossLimitSol > 0) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DAILY_LOSS,
      detail: `Daily sniper loss ${input.dailyLossSol.toFixed(4)} SOL reached the ${config.dailyLossLimitSol} SOL limit.`,
    };
  }

  if (input.deployedSol >= config.maxDeployedSol && config.maxDeployedSol > 0) {
    return {
      qualified: false,
      reason: SkipReason.MAX_DEPLOYMENT_REACHED,
      detail: `Deployed ${input.deployedSol.toFixed(4)} SOL at/above max ${config.maxDeployedSol} SOL.`,
    };
  }

  // --- fail closed on missing market data ---
  if (
    enrich.priceUsd == null ||
    enrich.marketCapUsd == null ||
    enrich.liquidityUsd == null ||
    !(enrich.priceUsd > 0) ||
    !(enrich.marketCapUsd > 0) ||
    !(enrich.liquidityUsd > 0)
  ) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail:
        'Reliable price / market cap / liquidity is missing. Sniper rejects by default when valuation data is unavailable.',
    };
  }

  const maxAge = config.marketDataMaxAgeMs || STALE_DEFAULT_MS;
  if (enrich.marketAgeMs == null || enrich.marketAgeMs > maxAge) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: `Market data is stale or age unknown (ageMs=${enrich.marketAgeMs ?? 'n/a'}, max=${maxAge}).`,
    };
  }

  if (enrich.enrichErrors.length > 0) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: `Enrichment inconsistent: ${enrich.enrichErrors.join('; ')}`,
    };
  }

  if (enrich.marketCapUsd > config.maxMarketCapUsd) {
    return {
      qualified: false,
      reason: SkipReason.MARKET_CAP_TOO_HIGH,
      detail: `Market cap $${Math.round(enrich.marketCapUsd).toLocaleString()} exceeds max $${Math.round(config.maxMarketCapUsd).toLocaleString()}.`,
    };
  }

  if (enrich.liquidityUsd < config.minLiquidityUsd) {
    return {
      qualified: false,
      reason: SkipReason.INSUFFICIENT_LIQUIDITY,
      detail: `Liquidity $${Math.round(enrich.liquidityUsd).toLocaleString()} below min $${Math.round(config.minLiquidityUsd).toLocaleString()}.`,
    };
  }

  if (enrich.mintAuthority || enrich.freezeAuthority) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_TOKEN_CONTROLS,
      detail: `Mint/freeze authority still set (mint=${enrich.mintAuthority ?? 'none'}, freeze=${enrich.freezeAuthority ?? 'none'}).`,
    };
  }

  if (enrich.decimals == null) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: 'Token decimals unavailable — cannot size safely.',
    };
  }

  if (enrich.topHolderPct != null && enrich.topHolderPct > 35) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_HOLDER_RISK,
      detail: `Top holder controls ${enrich.topHolderPct.toFixed(1)}% (>35%).`,
    };
  }

  if (enrich.swapActivityOk === false) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_ACTIVITY,
      detail: 'No genuine swap activity detected (or wash-volume safeguards failed).',
    };
  }

  if (enrich.swapActivityOk == null) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: 'Swap activity could not be verified.',
    };
  }

  if (enrich.buyRouteOk !== true || enrich.sellRouteOk !== true) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_NO_ROUTE,
      detail: `Buyability/exit route missing (buy=${enrich.buyRouteOk}, sell=${enrich.sellRouteOk}).`,
    };
  }

  if (enrich.priceImpactBps == null || enrich.expectedSlippageBps == null) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: 'Price impact / slippage estimate unavailable.',
    };
  }

  if (enrich.priceImpactBps > config.maxPriceImpactBps) {
    return {
      qualified: false,
      reason: SkipReason.PRICE_IMPACT_TOO_HIGH,
      detail: `Price impact ${enrich.priceImpactBps} bps exceeds max ${config.maxPriceImpactBps} bps.`,
    };
  }

  if (enrich.expectedSlippageBps > config.maxSlippageBps) {
    return {
      qualified: false,
      reason: SkipReason.SLIPPAGE_TOO_HIGH,
      detail: `Expected slippage ${enrich.expectedSlippageBps} bps exceeds max ${config.maxSlippageBps} bps.`,
    };
  }

  // Risk score 0–100 (lower is safer) — informational for audit.
  let risk = 20;
  risk += Math.min(30, (enrich.marketCapUsd / config.maxMarketCapUsd) * 20);
  risk += Math.min(20, enrich.topHolderPct != null ? enrich.topHolderPct * 0.4 : 10);
  risk += event.migrated ? 0 : 8;
  const riskScore = Math.round(Math.min(100, risk) * 10) / 10;

  return { qualified: true, riskScore };
}
