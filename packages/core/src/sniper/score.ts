import type { SniperEnrichment } from './types.js';

/** Minimum entry score (0–100) for automatic live sniper buys. */
export const SNIPER_AUTO_EXEC_MIN_SCORE = 90;

/**
 * Quality entry score for Discovery UI (higher = better).
 * Independent of fail-closed qualify — used for ranking + auto-exec gate.
 */
export function computeSniperEntryScore(enrich: SniperEnrichment): number {
  let score = 42;

  const liq = enrich.liquidityUsd;
  if (liq != null && Number.isFinite(liq)) {
    if (liq >= 100_000) score += 18;
    else if (liq >= 50_000) score += 14;
    else if (liq >= 20_000) score += 10;
    else if (liq >= 10_000) score += 6;
    else score -= 8;
  } else {
    score -= 10;
  }

  const mc = enrich.marketCapUsd;
  if (mc != null && Number.isFinite(mc)) {
    if (mc >= 50_000 && mc <= 1_000_000) score += 12;
    else if (mc > 1_000_000 && mc <= 5_000_000) score += 6;
    else if (mc < 50_000) score += 2;
    else score -= 4;
  }

  const vol = enrich.volume24hUsd;
  if (vol != null && Number.isFinite(vol)) {
    if (vol >= 300_000) score += 12;
    else if (vol >= 100_000) score += 8;
    else if (vol >= 20_000) score += 4;
    else if (vol <= 0) score -= 6;
  }

  const holders = enrich.holderCount;
  if (holders != null && Number.isFinite(holders)) {
    if (holders >= 2000) score += 10;
    else if (holders >= 500) score += 8;
    else if (holders >= 100) score += 4;
    else score -= 4;
  } else {
    score -= 6;
  }

  if (enrich.hasTwitter || enrich.hasWebsite || enrich.hasTelegram) score += 6;
  if (enrich.hasProfile) score += 3;

  const snip = enrich.sniperPct;
  if (snip != null) {
    if (snip <= 15) score += 8;
    else if (snip <= 30) score += 3;
    else if (snip > 50) score -= 12;
    else score -= 4;
  }

  const dev = enrich.devHoldingPct;
  if (dev != null) {
    if (dev <= 5) score += 6;
    else if (dev <= 15) score += 2;
    else if (dev > 30) score -= 14;
    else score -= 6;
  }

  const top = enrich.topHolderPct;
  if (top != null) {
    if (top <= 20) score += 6;
    else if (top <= 35) score += 2;
    else if (top > 50) score -= 12;
    else score -= 4;
  }

  if (enrich.mintAuthority === 'none') score += 4;
  else if (enrich.mintAuthority === 'present') score -= 20;
  if (enrich.freezeAuthority === 'none') score += 3;
  else if (enrich.freezeAuthority === 'present') score -= 12;

  if (enrich.buyRouteOk === true && enrich.sellRouteOk === true) score += 8;
  else if (enrich.buyRouteOk === true) score += 2;
  else score -= 10;

  if (enrich.migrated) score += 4;
  if (enrich.blacklistHit) score = Math.min(score, 15);

  return Math.max(0, Math.min(100, Math.round(score)));
}

export type DiscoveryStatus =
  | 'ENTRY_SIGNAL'
  | 'ACCUMULATION'
  | 'WATCHING'
  | 'REJECTED';

export function discoveryStatusFor(input: {
  entryScore: number;
  qualified: boolean;
  rejected: boolean;
}): DiscoveryStatus {
  if (input.rejected) return 'REJECTED';
  if (input.entryScore >= SNIPER_AUTO_EXEC_MIN_SCORE && input.qualified) return 'ENTRY_SIGNAL';
  if (input.entryScore >= 60) return 'ACCUMULATION';
  return 'WATCHING';
}
