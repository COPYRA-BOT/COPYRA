import { describe, expect, it } from 'vitest';

/**
 * Mirrors normalizeTradingFlags from env.ts — keep in sync.
 * Empty DO values must not become false; production unset defaults to true.
 */
function normalizeTradingFlags(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const truthy = (v: string | undefined) => {
    if (v === undefined) return false;
    const n = v.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes' || n === 'on';
  };
  const isPresent = (v: string | undefined) => v !== undefined && v.trim() !== '';

  for (const key of ['TRADING_ENABLED', 'SOL_TRADING_ENABLED', 'EVM_TRADING_ENABLED'] as const) {
    if (out[key] !== undefined && !isPresent(out[key])) delete out[key];
  }
  if (!isPresent(out.TRADING_ENABLED) && (isPresent(out.SOL_TRADING_ENABLED) || isPresent(out.EVM_TRADING_ENABLED))) {
    out.TRADING_ENABLED =
      truthy(out.SOL_TRADING_ENABLED) || truthy(out.EVM_TRADING_ENABLED) ? 'true' : 'false';
  }
  if (!isPresent(out.TRADING_ENABLED) && out.NODE_ENV === 'production') {
    out.TRADING_ENABLED = 'true';
  }
  for (const key of ['TRADING_ENABLED', 'SOL_TRADING_ENABLED', 'EVM_TRADING_ENABLED'] as const) {
    if (isPresent(out[key])) out[key] = truthy(out[key]) ? 'true' : 'false';
  }
  return out;
}

describe('normalizeTradingFlags', () => {
  it('does not coerce empty TRADING_ENABLED to false', () => {
    const out = normalizeTradingFlags({
      NODE_ENV: 'production',
      TRADING_ENABLED: '',
      SOL_TRADING_ENABLED: 'true',
      EVM_TRADING_ENABLED: 'true',
    });
    expect(out.TRADING_ENABLED).toBe('true');
  });

  it('defaults TRADING_ENABLED to true in production when unset', () => {
    const out = normalizeTradingFlags({ NODE_ENV: 'production' });
    expect(out.TRADING_ENABLED).toBe('true');
  });

  it('honors explicit false', () => {
    const out = normalizeTradingFlags({
      NODE_ENV: 'production',
      TRADING_ENABLED: 'false',
    });
    expect(out.TRADING_ENABLED).toBe('false');
  });

  it('normalizes TRUE casing', () => {
    const out = normalizeTradingFlags({ TRADING_ENABLED: 'TRUE' });
    expect(out.TRADING_ENABLED).toBe('true');
  });
});
