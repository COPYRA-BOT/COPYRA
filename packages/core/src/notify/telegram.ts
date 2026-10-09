import { prisma } from '@copyra/db';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { redactString } from '../obs/redact.js';
import { fetchJson, HttpError, sleep } from '../util/retry.js';

const log = componentLogger('telegram');

/**
 * Telegram delivery.
 *
 * Routing (shared COPYRA bot token; chat targets differ):
 *  * Platform `TELEGRAM_CHAT_ID` (admin) — EVERY worker/backend notification:
 *    detections, skips, buys, sells, failures, ops/watchdog, worker-online, etc.
 *  * Per-user `User.telegramChatId` — that account's BUY/SELL confirmed alerts only
 *    (+ telegram-link ack when they connect their chat).
 *  * Never throws into the trading path; every attempt is logged to `notification_logs`
 *    so Recent Activity stays accurate per account.
 */

const API_BASE = 'https://api.telegram.org';

/**
 * Pure noise — never Telegram (still may be skipped before queue).
 * Skips/detections/failures MUST reach the admin chat.
 */
const SUPPRESSED_KINDS = new Set([
  'redeploy-finished',
  'error:POSITION_TICK_FAILED',
]);

/** Linked end-user chats: confirmed fills + link confirmation only. */
const USER_CHAT_KINDS = new Set(['buy-confirmed', 'sell-confirmed', 'telegram-link']);

export function shouldSuppressTelegramKind(kind: string): boolean {
  if (SUPPRESSED_KINDS.has(kind)) return true;
  if (kind.startsWith('error:POSITION_')) return true;
  if (kind.startsWith('error:') && /pool|lock already held|connection/i.test(kind)) return true;
  return false;
}

/**
 * Pure routing helper (unit-tested).
 * Admin gets all non-suppressed kinds; users only buy/sell(+link).
 */
export function resolveTelegramTargets(input: {
  kind: string;
  adminChat: string | null | undefined;
  userChat: string | null | undefined;
}): string[] {
  const targets = new Set<string>();
  const admin = input.adminChat?.trim() || null;
  const user = input.userChat?.trim() || null;

  if (shouldSuppressTelegramKind(input.kind)) return [];

  if (admin) targets.add(admin);

  if (user && USER_CHAT_KINDS.has(input.kind)) {
    targets.add(user);
  }

  return [...targets];
}

export interface SendOptions {
  kind: string;
  /** Owning dashboard user — required for account-private notification lists + user TG. */
  userId?: string;
  tradeId?: string;
  positionId?: string;
  disableNotification?: boolean;
}

interface QueueItem {
  text: string;
  options: SendOptions;
}

export function parseTelegramMigrateTo(error: unknown): string | null {
  if (!(error instanceof HttpError)) return null;
  try {
    const parsed = JSON.parse(error.body) as {
      parameters?: { migrate_to_chat_id?: number | string };
    };
    const id = parsed.parameters?.migrate_to_chat_id;
    return id === undefined || id === null ? null : String(id);
  } catch {
    return null;
  }
}

/** Accept personal chat ids (123) and group ids (-100…). */
export function normalizeTelegramChatId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^-?\d{5,20}$/.test(trimmed)) return null;
  return trimmed;
}

class TelegramNotifier {
  readonly enabled: boolean;
  readonly #token: string | undefined;
  #chatId: string | undefined;
  readonly #queue: QueueItem[] = [];
  #draining = false;
  #lastSentAt = 0;

  constructor() {
    this.#token = env.TELEGRAM_BOT_TOKEN;
    this.#chatId = env.TELEGRAM_CHAT_ID;
    // Bot token alone is enough to DM users; platform chat is optional for ops.
    this.enabled = Boolean(this.#token);
    if (!this.enabled) {
      log.warn(
        {},
        'Telegram is not configured (TELEGRAM_BOT_TOKEN missing). ' +
          'Notifications will be recorded in the database but not delivered.',
      );
    }
  }

  get adminChatConfigured(): boolean {
    return Boolean(this.#token && this.#chatId);
  }

  /** Fire-and-forget. Returns immediately; delivery happens on the queue. */
  send(text: string, options: SendOptions): void {
    if (shouldSuppressTelegramKind(options.kind)) {
      log.debug({ kind: options.kind }, 'Telegram kind suppressed');
      return;
    }
    this.#queue.push({ text, options });
    void this.#drain();
  }

  /** Awaits actual delivery. Used by the health check and by tests. */
  async sendNow(text: string, options: SendOptions): Promise<boolean> {
    return this.#deliver(text, options);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift();
        if (!item) break;

        // Telegram allows roughly one message per second per chat.
        const elapsed = Date.now() - this.#lastSentAt;
        if (elapsed < 1_100) await sleep(1_100 - elapsed);

        await this.#deliver(item.text, item.options);
        this.#lastSentAt = Date.now();
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Resolve destination chat ids.
   * - Admin TELEGRAM_CHAT_ID ← all worker/backend kinds (skip, detect, buy, sell, ops, errors)
   * - User telegramChatId ← buy-confirmed / sell-confirmed / telegram-link only
   */
  async #resolveTargets(options: SendOptions): Promise<string[]> {
    let userChat: string | null = null;
    if (options.userId && USER_CHAT_KINDS.has(options.kind)) {
      const user = await prisma.user.findUnique({
        where: { id: options.userId },
        select: { telegramChatId: true },
      });
      userChat = user?.telegramChatId?.trim() || null;
    }

    return resolveTelegramTargets({
      kind: options.kind,
      adminChat: this.#chatId,
      userChat,
    });
  }

  async #postToChat(chatId: string, text: string, disableNotification: boolean): Promise<void> {
    const { data } = await fetchJson<{ ok: boolean; description?: string }>(
      `${API_BASE}/bot${this.#token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          disable_notification: disableNotification,
        }),
        timeoutMs: 8_000,
        label: 'telegram/sendMessage',
      },
    );
    if (!data.ok) {
      throw new Error(data.description ?? 'Telegram returned ok=false');
    }
  }

  async #deliver(rawText: string, options: SendOptions): Promise<boolean> {
    const text = redactString(rawText);
    let delivered = false;
    let error: string | null = null;

    if (!this.enabled) {
      error = 'Telegram not configured';
    } else {
      try {
        const targets = await this.#resolveTargets(options);
        if (targets.length === 0) {
          // Persist for Recent Activity; no chat is supposed to receive this kind.
          error = null;
          delivered = false;
          log.debug({ kind: options.kind, userId: options.userId ?? null }, 'Telegram: no target chat');
        } else {
          const errors: string[] = [];
          for (const chatId of targets) {
            try {
              await this.#postToChat(chatId, text, options.disableNotification ?? false);
              delivered = true;
            } catch (caught) {
              const migrated = parseTelegramMigrateTo(caught);
              if (migrated && chatId === this.#chatId) {
                this.#chatId = migrated;
                log.warn(
                  { from: env.TELEGRAM_CHAT_ID, to: migrated },
                  'Telegram admin chat upgraded; retrying with migrate_to_chat_id',
                );
                try {
                  await this.#postToChat(migrated, text, options.disableNotification ?? false);
                  delivered = true;
                  continue;
                } catch (retryError) {
                  errors.push(retryError instanceof Error ? retryError.message : String(retryError));
                  continue;
                }
              }
              errors.push(caught instanceof Error ? caught.message : String(caught));
            }
          }
          if (!delivered && errors.length) error = errors.join('; ');
          if (delivered && errors.length) {
            log.warn({ kind: options.kind, err: errors.join('; ') }, 'Telegram partial delivery');
          }
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        log.warn({ kind: options.kind, err: error }, 'Telegram delivery failed');
      }
    }

    // Always persist so per-account Recent Activity stays complete.
    try {
      await prisma.notificationLog.create({
        data: {
          userId: options.userId ?? null,
          channel: 'telegram',
          kind: options.kind,
          body: text,
          tradeId: options.tradeId ?? null,
          positionId: options.positionId ?? null,
          delivered,
          error,
        },
      });
    } catch (dbError) {
      log.error({ err: dbError }, 'Could not persist notification log');
    }

    return delivered;
  }

  /**
   * Verifies the bot can actually post to the configured admin chat.
   */
  async verify(): Promise<{
    tokenValid: boolean;
    botUsername: string | null;
    canPostToChat: boolean;
    chatTitle: string | null;
    error: string | null;
  }> {
    if (!this.#token) {
      return {
        tokenValid: false,
        botUsername: null,
        canPostToChat: false,
        chatTitle: null,
        error: 'TELEGRAM_BOT_TOKEN is not set',
      };
    }

    let botUsername: string | null = null;
    try {
      const { data } = await fetchJson<{ ok: boolean; result?: { username: string } }>(
        `${API_BASE}/bot${this.#token}/getMe`,
        { timeoutMs: 6_000, label: 'telegram/getMe' },
      );
      if (!data.ok) {
        return {
          tokenValid: false,
          botUsername: null,
          canPostToChat: false,
          chatTitle: null,
          error: 'Bot token rejected by Telegram',
        };
      }
      botUsername = data.result?.username ?? null;
    } catch (caught) {
      return {
        tokenValid: false,
        botUsername: null,
        canPostToChat: false,
        chatTitle: null,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }

    if (!this.#chatId) {
      return {
        tokenValid: true,
        botUsername,
        canPostToChat: false,
        chatTitle: null,
        error: 'TELEGRAM_CHAT_ID is not set (admin ops chat). User BUY/SELL DMs still work when linked.',
      };
    }

    try {
      const { data } = await fetchJson<{
        ok: boolean;
        result?: { title?: string; type: string };
        description?: string;
      }>(`${API_BASE}/bot${this.#token}/getChat?chat_id=${encodeURIComponent(this.#chatId)}`, {
        timeoutMs: 6_000,
        label: 'telegram/getChat',
      });
      return {
        tokenValid: true,
        botUsername,
        canPostToChat: data.ok,
        chatTitle: data.result?.title ?? null,
        error: data.ok ? null : (data.description ?? null),
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        tokenValid: true,
        botUsername,
        canPostToChat: false,
        chatTitle: null,
        error:
          `Bot token is valid but the admin chat is not reachable: ${message}. ` +
          `Add @${botUsername ?? 'the bot'} to the group and allow it to post.`,
      };
    }
  }
}

export const telegram = new TelegramNotifier();
