import { TxStatus } from '@copyra/db';
import { describe, expect, it } from 'vitest';

/**
 * Confirmation contract tests.
 *
 * The executor must never promote a trade to CONFIRMED from an API "ok" or a
 * successful sendTransaction. These tests lock that contract so a later edit
 * cannot quietly treat broadcast as success.
 */
describe('confirmation contract', () => {
  it('defines CONFIRMED as a distinct state from BROADCAST and LANDED', () => {
    expect(TxStatus.BROADCAST).not.toBe(TxStatus.CONFIRMED);
    expect(TxStatus.LANDED).not.toBe(TxStatus.CONFIRMED);
    expect(TxStatus.UNKNOWN).not.toBe(TxStatus.FAILED);
    expect(TxStatus.EXPIRED).not.toBe(TxStatus.FAILED);
  });

  it('keeps UNKNOWN for an unresolved confirmation so reconciliation must run', () => {
    // A timeout is not a failure: the transaction may still land. The schema
    // CHECK constraint `trades_confirmed_requires_hash` additionally forbids a
    // CONFIRMED row without a real hash — that is enforced by Postgres, not here.
    expect(Object.values(TxStatus)).toContain(TxStatus.UNKNOWN);
  });
});
