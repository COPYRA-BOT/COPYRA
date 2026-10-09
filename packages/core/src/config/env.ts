import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Walk up from cwd to find the monorepo root `.env`, so every app shares one. */
function loadRootEnv(): void {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadDotenv();
}

loadRootEnv();

/**
 * Accept SOL_TRADING_ENABLED / EVM_TRADING_ENABLED from App Platform.
 * Master TRADING_ENABLED stays the hard host kill switch.
 *
 * Empty strings (common DO UI glitch) are treated as unset — never as false.
 * In production, unset TRADING_ENABLED defaults to true so a missing injection
 * cannot silently disable the whole engine (explicit "false" still wins).
 */
function normalizeTradingFlags(): void {
  const truthy = (v: string | undefined) => {
    if (v === undefined) return false;
    const n = v.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes' || n === 'on';
  };
  const isPresent = (v: string | undefined) => v !== undefined && v.trim() !== '';

  // Blank App Platform values → unset (do not coerce "" to false).
  for (const key of ['TRADING_ENABLED', 'SOL_TRADING_ENABLED', 'EVM_TRADING_ENABLED'] as const) {
    if (process.env[key] !== undefined && !isPresent(process.env[key])) {
      delete process.env[key];
    }
  }

  const sol = process.env.SOL_TRADING_ENABLED;
  const evm = process.env.EVM_TRADING_ENABLED;
  if (!isPresent(process.env.TRADING_ENABLED) && (isPresent(sol) || isPresent(evm))) {
    process.env.TRADING_ENABLED = truthy(sol) || truthy(evm) ? 'true' : 'false';
  }
  if (!isPresent(process.env.TRADING_ENABLED) && process.env.NODE_ENV === 'production') {
    process.env.TRADING_ENABLED = 'true';
  }
  // DigitalOcean / UI sometimes stores TRUE / True — normalize before Zod.
  for (const key of ['TRADING_ENABLED', 'SOL_TRADING_ENABLED', 'EVM_TRADING_ENABLED'] as const) {
    const raw = process.env[key];
    if (isPresent(raw)) process.env[key] = truthy(raw) ? 'true' : 'false';
  }
}
normalizeTradingFlags();

const bool = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v.trim() === '') return false;
    const n = v.trim().toLowerCase();
    return n === 'true' || n === '1' || n === 'yes' || n === 'on';
  });

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : undefined;
  });

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** TLS Redis (`rediss://`) is required for DigitalOcean Managed Redis. */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  /**
   * Local / explicit port. DigitalOcean App Platform also injects `PORT` —
   * see `listenPort` below, which prefers `PORT` when set.
   */
  API_PORT: z.coerce.number().int().positive().default(41717),
  /** Must be 0.0.0.0 on App Platform so health checks can reach the process. */
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: csv,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_API_URL: z.string().default('http://127.0.0.1:41717'),
  PUBLIC_WEB_URL: z.string().default('http://127.0.0.1:43127'),
  /** DigitalOcean `*.ondigitalocean.app` URL — same deploy as copyra.fun for testing. */
  PUBLIC_PLATFORM_URL: optionalUrl,

  /** Legacy admin wallets — grant isAdmin on sign-in; not a deposit gate when multi-user custody is on. */
  OWNER_WALLET_SOLANA: z.string().trim().optional(),
  OWNER_WALLET_EVM: z.string().trim().optional(),

  /** Per-user derived custody wallets (default on). */
  MULTI_USER_CUSTODY: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return true;
      const n = v.trim().toLowerCase();
      return n === 'true' || n === '1' || n === 'yes' || n === 'on';
    }),
  /** Optional override; defaults to SESSION_SECRET when unset. */
  CUSTODY_DERIVATION_SECRET: z.string().trim().optional(),
  PER_USER_DEPOSIT_CAP_USD: z.coerce.number().nonnegative().default(0),
  GLOBAL_DEPOSIT_CAP_USD: z.coerce.number().nonnegative().default(0),
  WITHDRAW_DAILY_LIMIT_USD: z.coerce.number().nonnegative().default(0),
  WITHDRAW_NEW_ADDRESS_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(0),
  GLOBAL_CUSTODY_EMERGENCY_STOP: bool,
  SANCTIONS_BLOCKLIST_ENABLED: bool,
  ADDRESS_DENY_LIST: csv,

  SOLANA_RPC_URL: optionalUrl,
  SOLANA_WS_URL: optionalUrl,
  /** QuickNode (or other) paid backup — preferred over public fallbacks. */
  SOLANA_BACKUP_RPC_URL: optionalUrl,
  SOLANA_BACKUP_WS_URL: optionalUrl,
  SOLANA_RPC_FALLBACK_URLS: csv,
  JUPITER_API_KEY: z.string().trim().optional(),
  JUPITER_API_BASE: z.string().default('https://api.jup.ag'),
  SOLANA_MAX_PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().nonnegative().default(1_000_000),
  SOLANA_COMPUTE_UNIT_LIMIT: z.coerce.number().int().positive().default(400_000),

  EVM_ETHEREUM_RPC_URL: optionalUrl,
  EVM_ETHEREUM_WS_URL: optionalUrl,
  EVM_BASE_RPC_URL: optionalUrl,
  EVM_BASE_WS_URL: optionalUrl,
  EVM_ARBITRUM_RPC_URL: optionalUrl,
  EVM_ARBITRUM_WS_URL: optionalUrl,
  EVM_BSC_RPC_URL: optionalUrl,
  EVM_BSC_WS_URL: optionalUrl,
  EVM_BSC_BACKUP_RPC_URL: optionalUrl,
  EVM_BSC_BACKUP_WS_URL: optionalUrl,
  EVM_POLYGON_RPC_URL: optionalUrl,
  EVM_POLYGON_WS_URL: optionalUrl,
  EVM_OPTIMISM_RPC_URL: optionalUrl,
  EVM_OPTIMISM_WS_URL: optionalUrl,
  EVM_ARC_RPC_URL: optionalUrl,
  EVM_ARC_WS_URL: optionalUrl,
  EVM_ROBINHOOD_RPC_URL: optionalUrl,
  EVM_ROBINHOOD_WS_URL: optionalUrl,
  EVM_HYPERLIQUID_RPC_URL: optionalUrl,
  EVM_HYPERLIQUID_WS_URL: optionalUrl,
  EVM_TRON_RPC_URL: optionalUrl,

  KYBERSWAP_CLIENT_ID: z.string().default('copyra'),
  /** Optional 0x API key — used as EVM quote fallback when KyberSwap fails. */
  ZERO_EX_API_KEY: z.string().trim().optional(),

  TRADING_ENABLED: bool,
  SOL_TRADING_ENABLED: bool,
  EVM_TRADING_ENABLED: bool,
  MAX_TRADE_USD: z.coerce.number().positive().default(25),

  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_CHAT_ID: z.string().trim().optional(),
  SENTRY_DSN: z.string().trim().optional(),
  RESEND_API_KEY: z.string().trim().optional(),
  ALERT_EMAIL_TO: z.string().trim().optional(),
  ALERT_EMAIL_FROM: z.string().trim().optional(),

  /** Account layer (feat/accounts) — optional until Google / email sign-in is enabled. */
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
  ACCOUNT_EMAIL_FROM: z.string().trim().optional(),
  WEBAUTHN_RP_ID: z.string().trim().optional(),
  WEBAUTHN_RP_NAME: z.string().trim().optional(),
  REFERRAL_MIN_CLAIM_USD: z.coerce.number().nonnegative().default(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(
    `Invalid environment configuration:\n${issues}\n\n` +
      `On DigitalOcean App Platform, set these as encrypted App-Level env vars ` +
      `(never commit them): DATABASE_URL, REDIS_URL (public rediss:// host), ` +
      `SESSION_SECRET (>=32 chars), plus RPC/Telegram vars from .env.example.\n` +
      `Use the PUBLIC Redis hostname (without private-). See docs/DEPLOY.md.`,
  );
}

/** Prefer platform `PORT` (App Platform / Railway / Cloud Run) over API_PORT. */
function resolveListenPort(apiPort: number): number {
  const raw = process.env.PORT?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return apiPort;
}

export const env = {
  ...parsed.data,
  /** Host the HTTP server binds to. Always force a public bind in production. */
  API_HOST: parsed.data.NODE_ENV === 'production' ? '0.0.0.0' : parsed.data.API_HOST,
  /** Actual listen port: `PORT` env if set, otherwise `API_PORT`. */
  listenPort: resolveListenPort(parsed.data.API_PORT),
  /** Solana execution guard. Defaults to master TRADING_ENABLED when unset. */
  SOL_TRADING_ENABLED:
    process.env.SOL_TRADING_ENABLED === undefined
      ? parsed.data.TRADING_ENABLED
      : parsed.data.SOL_TRADING_ENABLED,
  /** EVM execution guard. Defaults to master TRADING_ENABLED when unset. */
  EVM_TRADING_ENABLED:
    process.env.EVM_TRADING_ENABLED === undefined
      ? parsed.data.TRADING_ENABLED
      : parsed.data.EVM_TRADING_ENABLED,
};
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Bot signing material. Read here so a single module owns the only reference,
 * and re-exported ONLY to `security/signer.ts`. `scripts/audit-secrets.mjs`
 * fails CI if any other file names these variables.
 *
 * Deliberately not part of `env`: nothing can accidentally serialise it by
 * logging the config object.
 */
export function readSigningKeyMaterial(): {
  solana: string | undefined;
  evm: string | undefined;
} {
  const solana = process.env.SOLANA_BOT_PRIVATE_KEY?.trim();
  const evm = process.env.EVM_BOT_PRIVATE_KEY?.trim();
  return {
    solana: solana && solana.length > 0 ? solana : undefined,
    evm: evm && evm.length > 0 ? evm : undefined,
  };
}
