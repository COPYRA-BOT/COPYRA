import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';

const log = componentLogger('redis');

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    });
    client.on('error', (error: Error) => log.error({ err: error }, 'Redis error'));
    client.on('reconnecting', () => log.warn({}, 'Redis reconnecting'));
    client.on('ready', () => log.info({}, 'Redis ready'));
  }
  return client;
}

/** Separate connection: BullMQ blocking commands cannot share a client. */
export function newRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export class LockHeldError extends Error {
  readonly code = 'LOCK_HELD';
  constructor(key: string) {
    super(`Lock already held: ${key}`);
    this.name = 'LockHeldError';
  }
}

/**
 * Single-holder lease via SET NX PX.
 *
 * This is the first of two layers preventing duplicate execution. It is fast
 * but not authoritative — Redis can be flushed or lost. The authoritative layer
 * is the unique constraints in Postgres (`signals`, `trades.idempotencyKey`,
 * `positions_one_open_per_token`). Both are required: Redis keeps hot
 * duplicates from ever reaching the executor, Postgres guarantees correctness.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await redis().set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

/** Releases only if still the holder, so a lapsed lease cannot free a new one. */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end`;
  const released = await redis().eval(script, 1, `lock:${key}`, token);
  return released === 1;
}

export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const token = await acquireLock(key, ttlMs);
  if (!token) throw new LockHeldError(key);
  try {
    return await fn();
  } finally {
    await releaseLock(key, token).catch((error: unknown) => {
      log.warn({ key, err: error }, 'Failed to release lock');
    });
  }
}

/**
 * Returns true the first time a key is seen within the window. Used as the hot
 * path duplicate-signal guard before any RPC work is done.
 */
export async function markSeenOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis().set(`seen:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

const AUTH_NONCE_TTL_SEC = 600;

/** One-time SIWE/SIWS nonce in Redis (GETDEL on consume). */
export async function storeAuthNonce(
  address: string,
  chain: string,
  nonce: string,
  ttlSec = AUTH_NONCE_TTL_SEC,
): Promise<{ expiresAt: Date }> {
  const key = `auth:nonce:${chain}:${address}`;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  await redis().set(key, nonce, 'EX', ttlSec);
  return { expiresAt };
}

/**
 * Atomically read + delete the nonce for address/chain.
 * Returns the nonce string if present and unexpired, else null.
 */
export async function consumeAuthNonce(address: string, chain: string): Promise<string | null> {
  const key = `auth:nonce:${chain}:${address}`;
  const client = redis();
  // GETDEL is Redis 6.2+; fallback to GET + DEL pipeline when unavailable.
  try {
    const value = (await client.call('GETDEL', key)) as string | null;
    return value || null;
  } catch {
    const value = await client.get(key);
    if (!value) return null;
    await client.del(key);
    return value;
  }
}

export async function peekAuthNonce(address: string, chain: string): Promise<string | null> {
  return redis().get(`auth:nonce:${chain}:${address}`);
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
