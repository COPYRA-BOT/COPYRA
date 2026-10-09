import { describe, expect, it } from 'vitest';
import { HttpError } from '../util/retry.js';
import {
  parseTelegramMigrateTo,
  resolveTelegramTargets,
  shouldSuppressTelegramKind,
} from './telegram.js';

describe('parseTelegramMigrateTo', () => {
  it('reads migrate_to_chat_id from a Telegram HTTP 400 body', () => {
    const error = new HttpError(
      400,
      'telegram/sendMessage',
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup',
        parameters: { migrate_to_chat_id: -1003993140088 },
      }),
    );
    expect(parseTelegramMigrateTo(error)).toBe('-1003993140088');
  });

  it('returns null when the body has no migrate parameter', () => {
    const error = new HttpError(400, 'telegram/sendMessage', '{"ok":false,"description":"chat not found"}');
    expect(parseTelegramMigrateTo(error)).toBeNull();
  });
});

describe('resolveTelegramTargets', () => {
  const admin = '-5389164510';
  const user = '123456789';

  it('sends skips and detections to admin only', () => {
    expect(resolveTelegramTargets({ kind: 'skip', adminChat: admin, userChat: user })).toEqual([
      admin,
    ]);
    expect(resolveTelegramTargets({ kind: 'detection', adminChat: admin, userChat: user })).toEqual([
      admin,
    ]);
  });

  it('sends buy/sell confirmed to admin and linked user', () => {
    expect(
      resolveTelegramTargets({ kind: 'buy-confirmed', adminChat: admin, userChat: user }),
    ).toEqual([admin, user]);
    expect(
      resolveTelegramTargets({ kind: 'sell-confirmed', adminChat: admin, userChat: user }),
    ).toEqual([admin, user]);
  });

  it('does not send buy/sell to user when they have no linked chat', () => {
    expect(
      resolveTelegramTargets({ kind: 'buy-confirmed', adminChat: admin, userChat: null }),
    ).toEqual([admin]);
  });

  it('sends failures and ops kinds to admin only', () => {
    expect(
      resolveTelegramTargets({ kind: 'buy-failed', adminChat: admin, userChat: user }),
    ).toEqual([admin]);
    expect(
      resolveTelegramTargets({ kind: 'ops-worker-watchdog-solana', adminChat: admin, userChat: user }),
    ).toEqual([admin]);
    expect(
      resolveTelegramTargets({ kind: 'worker-online', adminChat: admin, userChat: null }),
    ).toEqual([admin]);
  });

  it('suppresses pool noise everywhere', () => {
    expect(shouldSuppressTelegramKind('error:POSITION_TICK_FAILED')).toBe(true);
    expect(
      resolveTelegramTargets({
        kind: 'error:POSITION_TICK_FAILED',
        adminChat: admin,
        userChat: user,
      }),
    ).toEqual([]);
  });
});
