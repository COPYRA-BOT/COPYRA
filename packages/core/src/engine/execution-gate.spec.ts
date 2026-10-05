import { SignalStatus } from '@copyra/db';
import { describe, expect, it } from 'vitest';
import { executionGate, fractionOfRaw, wholeUnits } from './execution-gate.js';

describe('executionGate', () => {
  it('allows execution only when trading is on and a signer exists', () => {
    expect(
      executionGate({
        signerAvailable: true,
        tradingEnabled: true,
        emergencyStop: false,
        emergencyStopReason: null,
      }),
    ).toEqual({ ok: true });
  });

  it('blocks without a signer and never implies a broadcast', () => {
    const gate = executionGate({
      signerAvailable: false,
      tradingEnabled: true,
      emergencyStop: false,
      emergencyStopReason: null,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(SignalStatus.BLOCKED_NO_SIGNER);
    expect(gate.detail).toMatch(/No transaction was broadcast/);
  });

  it('blocks when the host trading guard is off', () => {
    const gate = executionGate({
      signerAvailable: true,
      tradingEnabled: false,
      emergencyStop: false,
      emergencyStopReason: null,
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(SignalStatus.BLOCKED_DISABLED);
  });

  it('blocks emergency stop ahead of the signer check', () => {
    const gate = executionGate({
      signerAvailable: false,
      tradingEnabled: true,
      emergencyStop: true,
      emergencyStopReason: 'operator',
    });
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.status).toBe(SignalStatus.BLOCKED_DISABLED);
    expect(gate.detail).toMatch(/operator/);
  });
});

describe('fractionOfRaw', () => {
  it('sells the entire raw amount at fraction 1', () => {
    expect(fractionOfRaw('1000', 1)).toBe('1000');
  });

  it('sells half with integer math', () => {
    expect(fractionOfRaw('1000', 0.5)).toBe('500');
  });

  it('returns zero for a non-positive fraction', () => {
    expect(fractionOfRaw('1000', 0)).toBe('0');
  });
});

describe('wholeUnits', () => {
  it('converts lamports to SOL', () => {
    expect(wholeUnits('1500000000', 9)).toBe(1.5);
  });
});
