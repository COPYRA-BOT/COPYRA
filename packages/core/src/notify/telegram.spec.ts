import { describe, expect, it } from 'vitest';
import { HttpError } from '../util/retry.js';
import { parseTelegramMigrateTo } from './telegram.js';

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
