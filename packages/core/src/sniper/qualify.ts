import { SkipReason } from '@copyra/db';
import type { SniperConfig, SniperDiscoveryEvent, SniperEnrichment, SniperQualifyResult } from './types.js';

const STALE_DEFAULT_MS = 30_000;

/**
 * Fail-closed sniper qualification. Missing / stale / inconsistent safety data
 * rejects the token — never bypassed to increase trade frequency.
 *
 * Runtime modes:
 *  - monitor: full filters run; never qualifies for buy (recorded for the terminal)
 *  - onchain: may qualify; execute path will not broadcast
 *  - live: may qualify and buy when host SNIPER_ENABLED is true
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

  // --- new / old token age scope ---
  if (enrich.tokenAgeMin == null) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: 'Token age unknown — cannot apply new/old token filter (fail-closed).',
    };
  }
  if (config.tokenScope === 'NEW' && enrich.tokenAgeMin > config.maxTokenAgeMin) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_ACTIVITY,
      detail: `Token age ${enrich.tokenAgeMin.toFixed(1)}m exceeds new-token max ${config.maxTokenAgeMin}m.`,
    };
  }
  if (config.tokenScope === 'OLD' && enrich.tokenAgeMin < config.minTokenAgeMin) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_ACTIVITY,
      detail: `Token age ${enrich.tokenAgeMin.toFixed(1)}m below old-token min ${config.minTokenAgeMin}m.`,
    };
  }
  if (config.tokenScope === 'BOTH') {
    if (enrich.tokenAgeMin < config.minTokenAgeMin || enrich.tokenAgeMin > config.maxTokenAgeMin) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_ACTIVITY,
        detail: `Token age ${enrich.tokenAgeMin.toFixed(1)}m outside window ${config.minTokenAgeMin}–${config.maxTokenAgeMin}m.`,
      };
    }
  }

  // Migrated filter
  if (config.migratedOnly === true && !enrich.migrated) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_NO_ROUTE,
      detail: 'Only migrated tokens are allowed; this launch is still on the bonding curve.',
    };
  }
  if (config.migratedOnly === false && enrich.migrated) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_NO_ROUTE,
      detail: 'Bonding-curve only mode — migrated / PumpSwap tokens are rejected.',
    };
  }

  // Socials / profile
  if (config.requireTwitter) {
    if (enrich.hasTwitter == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Twitter/X link required but social data is unavailable.',
      };
    }
    if (!enrich.hasTwitter) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_ACTIVITY,
        detail: 'Twitter/X profile required — none found.',
      };
    }
  }
  if (config.requireWebsite) {
    if (enrich.hasWebsite == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Website required but profile data is unavailable.',
      };
    }
    if (!enrich.hasWebsite) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_ACTIVITY,
        detail: 'Website required — none found.',
      };
    }
  }
  if (config.requireSocials || config.requireProfile) {
    if (enrich.hasProfile == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Social/profile data unavailable (fail-closed).',
      };
    }
    if (!enrich.hasProfile) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_ACTIVITY,
        detail: 'At least one social or profile link is required.',
      };
    }
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

  if (config.minVolume24hUsd > 0) {
    if (enrich.volume24hUsd == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Volume required by filter but unavailable.',
      };
    }
    if (enrich.volume24hUsd < config.minVolume24hUsd) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_ACTIVITY,
        detail: `Volume $${Math.round(enrich.volume24hUsd).toLocaleString()} below min $${Math.round(config.minVolume24hUsd).toLocaleString()}.`,
      };
    }
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

  // Holders
  if (config.minHolders > 0 || config.maxHolders > 0) {
    if (enrich.holderCount == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Holder count unavailable (fail-closed).',
      };
    }
    if (config.minHolders > 0 && enrich.holderCount < config.minHolders) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_HOLDER_RISK,
        detail: `Holders ${enrich.holderCount} below min ${config.minHolders}.`,
      };
    }
    if (config.maxHolders > 0 && enrich.holderCount > config.maxHolders) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_HOLDER_RISK,
        detail: `Holders ${enrich.holderCount} above max ${config.maxHolders}.`,
      };
    }
  }

  const topCap = config.maxTopHolderPct > 0 ? config.maxTopHolderPct : 35;
  if (enrich.topHolderPct != null && enrich.topHolderPct > topCap) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_HOLDER_RISK,
      detail: `Top holder controls ${enrich.topHolderPct.toFixed(1)}% (>${topCap}%).`,
    };
  }
  if (enrich.topHolderPct == null && topCap < 100) {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
      detail: 'Top-holder % unavailable (fail-closed).',
    };
  }

  if (config.maxSniperPct > 0) {
    if (enrich.sniperPct == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Early sniper concentration unavailable (fail-closed).',
      };
    }
    if (enrich.sniperPct > config.maxSniperPct) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_HOLDER_RISK,
        detail: `Early sniper concentration ${enrich.sniperPct.toFixed(1)}% exceeds max ${config.maxSniperPct}%.`,
      };
    }
  }

  if (config.maxDevHoldingPct > 0) {
    if (enrich.devHoldingPct == null) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_DATA_UNAVAILABLE,
        detail: 'Dev holding % unavailable (fail-closed).',
      };
    }
    if (enrich.devHoldingPct > config.maxDevHoldingPct) {
      return {
        qualified: false,
        reason: SkipReason.SNIPER_HOLDER_RISK,
        detail: `Dev holding ${enrich.devHoldingPct.toFixed(1)}% exceeds max ${config.maxDevHoldingPct}%.`,
      };
    }
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

  // Runtime gate last — so the pending terminal shows real filter failures first.
  if (config.runtimeMode === 'monitor') {
    return {
      qualified: false,
      reason: SkipReason.SNIPER_DISABLED,
      detail:
        'Monitor only — token passed filters; discovery recorded in pending, no buy.',
    };
  }

  let risk = 20;
  risk += Math.min(30, (enrich.marketCapUsd / config.maxMarketCapUsd) * 20);
  risk += Math.min(20, enrich.topHolderPct != null ? enrich.topHolderPct * 0.4 : 10);
  risk += enrich.migrated ? 0 : 8;
  const riskScore = Math.round(Math.min(100, risk) * 10) / 10;

  return { qualified: true, riskScore };
}
