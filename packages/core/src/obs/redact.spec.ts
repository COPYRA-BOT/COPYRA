import { describe, expect, it } from 'vitest';
import { redact, redactString, safeEndpoint } from './redact.js';

describe('redactString', () => {
  it('strips Helius, Alchemy, Jupiter, Telegram and Resend credential shapes', () => {
    const input =
      'url=https://mainnet.helius-rpc.com/?api-key=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee ' +
      'alchemy=/v2/alch_thisIsALongAlchemyKeyValue jup_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ' +
      'bot=99999999:AAThisIsNotARealTelegramTokenValueXXXX re_testdata_0123456789abcdef ' +
      'db=postgresql://doadmin:hunter2@host:25060/db';
    const out = redactString(input);
    expect(out).not.toMatch(/aaaaaaaa-bbbb-cccc/);
    expect(out).not.toMatch(/alch_/);
    expect(out).not.toMatch(/jup_0123/);
    expect(out).not.toMatch(/AAEfV9T59RbauTuc/);
    expect(out).not.toMatch(/re_abcDEF12/);
    expect(out).not.toMatch(/hunter2/);
    expect(out).toMatch(/\[REDACTED/);
  });

  it('strips a 32-byte hex string that could be a signing key', () => {
    const hex = `0x${'ab'.repeat(32)}`;
    expect(redactString(`key=${hex}`)).not.toContain(hex);
  });
});

describe('redact', () => {
  it('replaces values under sensitive keys regardless of shape', () => {
    const out = redact({
      privateKey: 'should-never-appear',
      apiKey: 'also-hidden',
      nested: { seedPhrase: 'twelve words' },
      safe: 'ok',
    });
    expect(out.privateKey).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as { seedPhrase: string }).seedPhrase).toBe('[REDACTED]');
    expect(out.safe).toBe('ok');
  });

  it('handles cycles and errors without throwing', () => {
    const cyclic: { self?: unknown; message: string } = { message: 'ok' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    const err = new Error('api-key=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const redacted = redact(err) as { message: string };
    expect(redacted.message).not.toMatch(/aaaaaaaa/);
  });
});

describe('safeEndpoint', () => {
  it('returns host only so an API key in the query string never reaches a log', () => {
    expect(safeEndpoint('https://mainnet.helius-rpc.com/?api-key=secret')).toBe(
      'https://mainnet.helius-rpc.com',
    );
  });
});
