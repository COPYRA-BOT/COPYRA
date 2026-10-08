import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { redis } from '../util/redis.js';
import { telegram } from './telegram.js';

const log = componentLogger('ops-alerts');

/** Default: do not re-send the same alert kind more than once per 15 minutes. */
const DEFAULT_COOLDOWN_SEC = 15 * 60;

/**
 * Operator Telegram alerts for outages / stops.
 * Uses Redis NX cooldown so a flapping fault cannot spam the chat.
 */
export async function alertOps(
  kind: string,
  text: string,
  opts: { cooldownSec?: number; awaitDelivery?: boolean } = {},
): Promise<boolean> {
  const cooldownSec = opts.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
  const key = `ops:alert:${kind}`;
  try {
    const ok = await redis().set(key, '1', 'EX', cooldownSec, 'NX');
    if (ok !== 'OK') {
      log.debug({ kind }, 'Ops alert suppressed by cooldown');
      return false;
    }
  } catch (error) {
    // Still try to deliver if Redis is down — better one extra ping than silence.
    log.warn({ kind, err: error }, 'Ops alert cooldown check failed; sending anyway');
  }

  const body = `🚨 <b>COPYRA ALERT</b>\n${text}\n<i>${env.PUBLIC_WEB_URL}</i>`;

  if (opts.awaitDelivery) {
    return telegram.sendNow(body, { kind: `ops-${kind}` });
  }
  telegram.send(body, { kind: `ops-${kind}` });
  return true;
}

export async function alertOpsCleared(kind: string, text: string): Promise<void> {
  try {
    await redis().del(`ops:alert:${kind}`);
  } catch {
    /* ignore */
  }
  telegram.send(`✅ <b>COPYRA RECOVERED</b>\n${text}\n<i>${env.PUBLIC_WEB_URL}</i>`, {
    kind: `ops-clear-${kind}`,
  });
}
