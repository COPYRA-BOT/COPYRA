/**
 * Number and text formatting for COPYRA notifications.
 *
 * Matches the message layout in the project spec exactly: compact market caps
 * ("MC $4.2M"), truncated addresses with a single-character ellipsis
 * ("7xKp…3fQ"), and prices rendered with enough significant digits that a
 * sub-cent memecoin price is still readable.
 */

/** "$4.2M", "$310K", "$1,128". */
export function compactUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `$${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `$${trim(value / 1_000)}K`;
  return `$${value.toFixed(2)}`;
}

/** "$1,128" — full dollars with thousands separators. */
export function plainUsd(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function trim(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * Token price with adaptive precision.
 *
 * A memecoin at $0.0000231 and a blue chip at $121.44 both have to read
 * correctly, so precision follows magnitude rather than a fixed decimal count.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1) return `$${trimTrailingZeros(value.toFixed(4))}`;
  if (abs >= 0.01) return `$${trimTrailingZeros(value.toFixed(5))}`;
  if (abs >= 0.0001) return `$${trimTrailingZeros(value.toFixed(7))}`;
  // Keep 3 significant digits for very small prices, then drop leftover zeros
  // so $0.0000231 stays $0.0000231 rather than $0.00002310.
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.min(18, Math.abs(exponent) + 3);
  return `$${trimTrailingZeros(value.toFixed(decimals))}`;
}

/** Token amount in human units, with magnitude-appropriate precision. */
export function formatAmount(value: number | null | undefined, symbol?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  let text: string;
  if (abs >= 1_000_000) text = `${(value / 1_000_000).toFixed(2)}M`;
  else if (abs >= 1_000) text = value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  else if (abs >= 1) text = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  else if (abs >= 0.0001) text = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  else text = value.toExponential(2);
  return symbol ? `${text} ${symbol}` : text;
}

/** Native-asset amount: 4 decimals is the readable convention for SOL/ETH. */
export function formatNative(value: number | null | undefined, symbol: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return `n/a ${symbol}`;
  const abs = Math.abs(value);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 2 : 6;
  return `${trimTrailingZeros(value.toFixed(decimals))} ${symbol}`;
}

/** Signed amount for P&L lines: "+0.26 SOL", "-0.13 SOL". */
export function formatSignedNative(value: number, symbol: string): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '+';
  return `${sign}${formatNative(Math.abs(value), symbol)}`;
}

export function formatSignedPct(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

export function formatPct(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(decimals)}%`;
}

/** "7xKp…3fQ" — the spec's shortened-address style. */
export function shortAddress(address: string, lead = 4, tail = 3): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** "1.8s" — measured execution speed, never a claim. */
export function formatSpeed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'not measured';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** "7m 12s" — position hold time. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'n/a';
  const totalSeconds = Math.floor(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Converts a base-unit string plus decimals into a human number. */
export function fromRaw(amountRaw: string | null | undefined, decimals: number | null | undefined): number | null {
  if (!amountRaw || decimals === null || decimals === undefined) return null;
  try {
    const raw = BigInt(amountRaw);
    const divisor = 10 ** decimals;
    return Number(raw) / divisor;
  } catch {
    return null;
  }
}

/** Converts a human number into base units without float drift in the integer part. */
export function toRaw(amount: number, decimals: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '0';
  const [whole = '0', fraction = ''] = amount.toFixed(Math.min(decimals, 20)).split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0')).toString();
}
