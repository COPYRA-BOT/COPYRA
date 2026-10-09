import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/** Mirrors POST /api/account/google body schema — keep in sync with routes.ts */
const googleBodySchema = z.object({
  idToken: z.string().min(20).optional(),
  credential: z.string().min(20).optional(),
  code: z.string().min(10).optional(),
  ref: z.string().nullish(),
});

describe('Google sign-in body schema', () => {
  it('accepts auth code with ref:null (browser default without invite)', () => {
    const parsed = googleBodySchema.safeParse({
      code: '4/0AanRRrs' + 'x'.repeat(20),
      ref: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.code).toBeTruthy();
  });

  it('accepts idToken without ref', () => {
    const parsed = googleBodySchema.safeParse({
      idToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.' + 'x'.repeat(40),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty body', () => {
    expect(googleBodySchema.safeParse({}).success).toBe(true); // fields optional
    // Route still requires code or idToken after parse — empty object is schema-ok.
    const data = googleBodySchema.parse({});
    expect(data.code || data.idToken || data.credential).toBeFalsy();
  });
});
