import { describe, expect, it } from 'vitest';
import { COPYRA_GOOGLE_CLIENT_ID, normalizeGoogleClientId } from './google.js';

describe('normalizeGoogleClientId', () => {
  it('keeps a clean client id', () => {
    expect(normalizeGoogleClientId(COPYRA_GOOGLE_CLIENT_ID)).toBe(COPYRA_GOOGLE_CLIENT_ID);
  });

  it('strips https:// pasted into DO env (invalid_client root cause)', () => {
    expect(
      normalizeGoogleClientId(`https://${COPYRA_GOOGLE_CLIENT_ID}`),
    ).toBe(COPYRA_GOOGLE_CLIENT_ID);
  });

  it('strips quotes and trailing slash', () => {
    expect(normalizeGoogleClientId(`"${COPYRA_GOOGLE_CLIENT_ID}/"`)).toBe(COPYRA_GOOGLE_CLIENT_ID);
  });
});
