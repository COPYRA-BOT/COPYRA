/**
 * Redaction applied to every log record and every persisted SystemEvent before
 * it leaves the process. Defence in depth: the signer never hands out key
 * material, and if something ever did, this stops it reaching a log sink,
 * Sentry, or a Telegram message.
 */

const SENSITIVE_KEYS = [
  'privatekey',
  'secretkey',
  'secret',
  'mnemonic',
  'seedphrase',
  'seed',
  'password',
  'passwd',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'sessionsecret',
  'x-api-key',
  'bearer',
  'keypair',
  'signingkey',
  'dsn',
  'databaseurl',
  'database_url',
  'connectionstring',
];

/** Patterns that look like credentials regardless of the key they sit under. */
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/api-key=[0-9a-fA-F-]{8,}/g, 'api-key=[REDACTED]'],
  [/\/v2\/[A-Za-z0-9_-]{16,}/g, '/v2/[REDACTED]'],
  [/\bjup_[0-9a-zA-Z]{20,}/g, '[REDACTED_JUPITER_KEY]'],
  [/\balch_[A-Za-z0-9_-]{16,}/g, '[REDACTED_ALCHEMY_KEY]'],
  [/\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/g, '[REDACTED_TELEGRAM_TOKEN]'],
  [/\bre_[A-Za-z0-9_]{6,}_[A-Za-z0-9]{12,}/g, '[REDACTED_RESEND_KEY]'],
  [/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/g, 'postgresql://[REDACTED]@'],
  [/redis:\/\/[^:\s]+:[^@\s]+@/g, 'redis://[REDACTED]@'],
  [/\b0x[0-9a-fA-F]{64}\b/g, '[REDACTED_32B_HEX]'],
  [/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED_PEM]'],
  // base58 blobs of key length (Solana secret keys are 87-88 chars).
  [/\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g, '[REDACTED_BASE58_KEY]'],
  // JSON byte arrays of keypair length.
  [/\[\s*(?:\d{1,3}\s*,\s*){60,}\d{1,3}\s*\]/g, '[REDACTED_KEY_BYTES]'],
];

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.some((s) => k.includes(s.replace(/[-_]/g, '')));
}

/**
 * Deep-redacts an arbitrary value. Cycles are handled; depth is bounded so a
 * pathological object cannot stall the logger.
 */
export function redact<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]' as unknown as T;

  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[CIRCULAR]' as unknown as T;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen)) as unknown as T;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    } as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(inner, depth + 1, seen);
  }
  return out as unknown as T;
}

/** Host-only form of an RPC URL, safe to store and display. */
export function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[invalid-url]';
  }
}
