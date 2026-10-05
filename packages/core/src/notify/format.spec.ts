import { describe, expect, it } from 'vitest';
import {
  compactUsd,
  escapeHtml,
  formatDuration,
  formatNative,
  formatPrice,
  formatSignedNative,
  formatSignedPct,
  formatSpeed,
  fromRaw,
  shortAddress,
  toRaw,
} from './format.js';

describe('compactUsd', () => {
  it('matches the spec compact market-cap style', () => {
    expect(compactUsd(4_200_000)).toBe('$4.2M');
    expect(compactUsd(310_000)).toBe('$310K');
    expect(compactUsd(1_128)).toBe('$1.1K');
    expect(compactUsd(null)).toBe('n/a');
  });
});

describe('formatPrice', () => {
  it('keeps sub-cent memecoin prices readable', () => {
    expect(formatPrice(0.0000231)).toBe('$0.0000231');
    expect(formatPrice(121.44)).toBe('$121.44');
    expect(formatPrice(0)).toBe('n/a');
  });
});

describe('shortAddress / speed / duration', () => {
  it('shortens an address the way the Telegram spec shows', () => {
    expect(shortAddress('7xKpABCDEFGHIJKLMNOPQRSTUVWXYZ123fQ')).toBe('7xKp…3fQ');
  });

  it('renders measured speed and hold time, and refuses to invent them', () => {
    expect(formatSpeed(1800)).toBe('1.8s');
    expect(formatSpeed(null)).toBe('not measured');
    expect(formatDuration(7 * 60_000 + 12_000)).toBe('7m 12s');
  });
});

describe('signed figures', () => {
  it('prefixes profit and loss the way the Telegram templates require', () => {
    expect(formatSignedNative(0.26, 'SOL')).toBe('+0.26 SOL');
    expect(formatSignedNative(-0.13, 'SOL')).toBe('-0.13 SOL');
    expect(formatSignedPct(20.8)).toBe('+20.8%');
    expect(formatSignedPct(-10.4)).toBe('-10.4%');
    expect(formatNative(1.25, 'SOL')).toBe('1.25 SOL');
  });
});

describe('fromRaw / toRaw', () => {
  it('round-trips base units without inventing decimals', () => {
    expect(fromRaw('1250000000', 9)).toBe(1.25);
    expect(toRaw(1.25, 9)).toBe('1250000000');
    expect(fromRaw('1', null)).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes markup so a token symbol cannot break Telegram HTML', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
  });
});
