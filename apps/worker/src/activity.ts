/**
 * Shared activity clocks for the 24/7 watchdog + ops clarity.
 * - Sync/tick clocks prove the monitor loop is alive.
 * - Processed clocks prove events were handled (quiet markets are OK).
 * Never treat "no processed trades" alone as a stalled worker.
 */
import { writeFileSync } from 'node:fs';

export const workerActivity = {
  /** Last time Solana catch-up / sync finished (success or partial). */
  lastSolanaSyncAt: 0,
  /** Last time any Solana signature was handled (including UNKNOWN). */
  lastSolanaProcessedAt: 0,
  /** Last time an onLogs WebSocket callback fired (any trader). */
  lastSolanaWsEventAt: 0,
  /** Last Solana slot observed from a WS/catch-up handle. */
  lastSolanaSlot: 0,
  /** Last time an EVM poll tick completed. */
  lastEvmTickAt: 0,
  /** Last time any EVM hash was handled. */
  lastEvmProcessedAt: 0,
};

export function touchSolanaSync(): void {
  workerActivity.lastSolanaSyncAt = Date.now();
}

export function touchSolanaProcessed(slot?: number): void {
  workerActivity.lastSolanaProcessedAt = Date.now();
  if (typeof slot === 'number' && slot > 0) workerActivity.lastSolanaSlot = slot;
}

export function touchSolanaWsEvent(slot?: number): void {
  workerActivity.lastSolanaWsEventAt = Date.now();
  if (typeof slot === 'number' && slot > 0) workerActivity.lastSolanaSlot = slot;
}

export function touchEvmTick(): void {
  workerActivity.lastEvmTickAt = Date.now();
}

export function touchEvmProcessed(): void {
  workerActivity.lastEvmProcessedAt = Date.now();
}

/** Write a small status file for worker-health.mjs (best-effort). */
export function writeWorkerStatusFile(extra: Record<string, unknown> = {}): void {
  try {
    writeFileSync(
      '/tmp/copyra-worker-status.json',
      JSON.stringify({
        at: Date.now(),
        ...workerActivity,
        ...extra,
      }),
    );
  } catch {
    /* ignore */
  }
}
