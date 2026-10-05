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

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

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
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  API_PORT: z.coerce.number().int().positive().default(41717),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: csv,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PUBLIC_API_URL: z.string().default('http://127.0.0.1:41717'),
  PUBLIC_WEB_URL: z.string().default('http://127.0.0.1:43127'),

  SOLANA_RPC_URL: optionalUrl,
  SOLANA_WS_URL: optionalUrl,
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

  TRADING_ENABLED: bool,
  MAX_TRADE_USD: z.coerce.number().positive().default(25),

  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_CHAT_ID: z.string().trim().optional(),
  SENTRY_DSN: z.string().trim().optional(),
  RESEND_API_KEY: z.string().trim().optional(),
  ALERT_EMAIL_TO: z.string().trim().optional(),
  ALERT_EMAIL_FROM: z.string().trim().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
}

export const env = parsed.data;
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
