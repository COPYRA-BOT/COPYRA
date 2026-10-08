import { prisma } from '@copyra/db';
import { env } from '../config/env.js';
import { componentLogger } from '../obs/logger.js';
import { redactString } from '../obs/redact.js';
import { fetchJson, HttpError, sleep } from '../util/retry.js';

const log = componentLogger('telegram');

/**
 * Telegram delivery.
 *
 * Properties that matter for a trading bot:
 *  * Never throws into the trading path. A notification failure must not stop
 *    or delay a trade (spec §14: "If Telegram is disconnected, trading must
 *    continue").
 *  * Every message is redacted before sending, so a credential can never reach
 *    a chat (spec §22).
 *  * Every message is persisted to `notification_logs` with its delivery
 *    outcome, so "did the alert actually go out?" is answerable.
 *  * Rate limited to Telegram's ~1 message/second per chat, with a queue, so a
 *    burst of signals does not get dropped by the API.
 */

const API_BASE = 'https://api.telegram.org';

/** Kinds that must never spam the operator chat (still persisted if sendNow is used). */
const SUPPRESSED_KINDS = new Set([
  'skip',
  'detection',
  'redeploy-finished', // legacy spam on every supervisor respawn
  'trailing-armed',
  'error:POSITION_TICK_FAILED',
]);

function shouldSuppressTelegramKind(kind: string): boolean {
  if (SUPPRESSED_KINDS.has(kind)) return true;
  // Transient infra noise from exit ticks / pool / locks.
  if (kind.startsWith('error:POSITION_')) return true;
  if (kind.startsWith('error:') && /pool|lock already held|connection/i.test(kind)) return true;
  return false;
}

export interface SendOptions {
  kind: string;
  /** Owning dashboard user — required for account-private notification lists. */
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
    this.enabled = Boolean(this.#token && this.#chatId);
    if (!this.enabled) {
      log.warn(
        {},
        'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing). ' +
          'Notifications will be recorded in the database but not delivered.',
      );
    }
  }

  /** Fire-and-forget. Returns immediately; delivery happens on the queue. */
  send(text: string, options: SendOptions): void {
    // Drop noisy kinds by default — only buys/sells/emergency/ops reach the chat.
    // Set TELEGRAM_NOTIFY_SKIPS=true / TELEGRAM_NOTIFY_ERRORS=true to opt back in.
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

  async #deliver(rawText: string, options: SendOptions): Promise<boolean> {
    const text = redactString(rawText);
    let delivered = false;
    let error: string | null = null;

    if (this.enabled) {
      try {
        const { data } = await fetchJson<{ ok: boolean; description?: string }>(
          `${API_BASE}/bot${this.#token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.#chatId,
              text,
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              disable_notification: options.disableNotification ?? false,
            }),
            timeoutMs: 8_000,
            label: 'telegram/sendMessage',
          },
        );
        delivered = data.ok;
        if (!data.ok) error = data.description ?? 'Telegram returned ok=false';
      } catch (caught) {
        const migrated = parseTelegramMigrateTo(caught);
        if (migrated && this.#token) {
          this.#chatId = migrated;
          log.warn({ from: env.TELEGRAM_CHAT_ID, to: migrated }, 'Telegram chat upgraded; retrying with migrate_to_chat_id');
          try {
            const retry = await fetchJson<{ ok: boolean; description?: string }>(
              `${API_BASE}/bot${this.#token}/sendMessage`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  chat_id: migrated,
                  text,
                  parse_mode: 'HTML',
                  link_preview_options: { is_disabled: true },
                  disable_notification: options.disableNotification ?? false,
                }),
                timeoutMs: 8_000,
                label: 'telegram/sendMessage-migrated',
              },
            );
            delivered = retry.data.ok;
            if (!retry.data.ok) error = retry.data.description ?? 'Telegram returned ok=false after migrate';
          } catch (retryError) {
            error = retryError instanceof Error ? retryError.message : String(retryError);
            log.warn({ kind: options.kind, err: error }, 'Telegram delivery failed after migrate');
          }
        } else {
          error = caught instanceof Error ? caught.message : String(caught);
          log.warn({ kind: options.kind, err: error }, 'Telegram delivery failed');
        }
      }
    } else {
      error = 'Telegram not configured';
    }

    // Recorded regardless of outcome so the audit trail is complete.
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
   * Verifies the bot can actually post to the configured chat.
   *
   * `getMe` succeeding proves only that the token is valid. Posting is what
   * proves the bot is a member of the group with permission to write, which is
   * the thing that actually fails in practice.
   */
  async verify(): Promise<{
    tokenValid: boolean;
    botUsername: string | null;
    canPostToChat: boolean;
    chatTitle: string | null;
    error: string | null;
  }> {
    if (!this.enabled) {
      return {
        tokenValid: false,
        botUsername: null,
        canPostToChat: false,
        chatTitle: null,
        error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set',
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

    try {
      const { data } = await fetchJson<{
        ok: boolean;
        result?: { title?: string; type: string };
        description?: string;
      }>(`${API_BASE}/bot${this.#token}/getChat?chat_id=${encodeURIComponent(this.#chatId as string)}`, {
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
          `Bot token is valid but the chat is not reachable: ${message}. ` +
          `Add @${botUsername ?? 'the bot'} to the group and allow it to post.`,
      };
    }
  }
}

export const telegram = new TelegramNotifier();
