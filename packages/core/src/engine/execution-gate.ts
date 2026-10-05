import { SignalStatus, SkipReason } from '@copyra/db';

export type ExecutionGate =
  | { ok: true }
  | { ok: false; status: SignalStatus; reason: SkipReason; detail: string };

/**
 * Execution is a separate gate from market qualification.
 *
 * Observe-only hosts still qualify first-buys against live market data. They
 * must not broadcast. This function is the only place that decision is made, so
 * the Solana and EVM monitors cannot drift.
 */
export function executionGate(input: {
  signerAvailable: boolean;
  tradingEnabled: boolean;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
}): ExecutionGate {
  if (input.emergencyStop) {
    return {
      ok: false,
      status: SignalStatus.BLOCKED_DISABLED,
      reason: SkipReason.TRADER_DISABLED,
      detail: `Emergency stop engaged${input.emergencyStopReason ? `: ${input.emergencyStopReason}` : ''}.`,
    };
  }
  if (!input.tradingEnabled) {
    return {
      ok: false,
      status: SignalStatus.BLOCKED_DISABLED,
      reason: SkipReason.TRADER_DISABLED,
      detail: 'Qualified against live market data, but trading is disabled by the host or settings guard. No transaction was broadcast.',
    };
  }
  if (!input.signerAvailable) {
    return {
      ok: false,
      status: SignalStatus.BLOCKED_NO_SIGNER,
      reason: SkipReason.TRADER_DISABLED,
      detail:
        'Qualified, but no server-side signing key is configured. No transaction was broadcast.',
    };
  }
  return { ok: true };
}

/** Integer fraction of a raw on-chain amount. Never uses floating token units. */
export function fractionOfRaw(amountRaw: string, fraction: number): string {
  if (fraction <= 0) return '0';
  if (fraction >= 1) return amountRaw;
  const total = BigInt(amountRaw);
  const bps = BigInt(Math.round(fraction * 10_000));
  const sold = (total * bps) / 10_000n;
  return sold < 0n ? '0' : sold.toString();
}

export function wholeUnits(amountRaw: string, decimals: number): number {
  if (decimals < 0) return 0;
  const raw = BigInt(amountRaw);
  const base = 10n ** BigInt(decimals);
  return Number(raw) / Number(base);
}
