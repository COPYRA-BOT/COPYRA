/**
 * Shared activity clock for the 24/7 watchdog.
 * Monitors bump these timestamps so a silent stall can force a clean respawn.
 */

export const workerActivity = {
  /** Last time Solana catch-up / sync finished (success or partial). */
  lastSolanaSyncAt: 0,
  /** Last time any Solana signature was handled (including UNKNOWN). */
  lastSolanaProcessedAt: 0,
  /** Last time an EVM poll tick completed. */
  lastEvmTickAt: 0,
  /** Last time any EVM hash was handled. */
  lastEvmProcessedAt: 0,
};

export function touchSolanaSync(): void {
  workerActivity.lastSolanaSyncAt = Date.now();
}

export function touchSolanaProcessed(): void {
  workerActivity.lastSolanaProcessedAt = Date.now();
}

export function touchEvmTick(): void {
  workerActivity.lastEvmTickAt = Date.now();
}

export function touchEvmProcessed(): void {
  workerActivity.lastEvmProcessedAt = Date.now();
}
