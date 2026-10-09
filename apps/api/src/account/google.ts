import { OAuth2Client } from 'google-auth-library';
import { env } from '@copyra/core';

export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

/**
 * Public OAuth Web client id (embedded in the browser GIS button).
 * Prefer `GOOGLE_CLIENT_ID` from the environment; this fallback keeps sign-in
 * working if App Platform env sync lags. Never put the client secret here.
 */
export const COPYRA_GOOGLE_CLIENT_ID =
  '262135154840-d5tr76fnjatnkg7qdjmptmj7jcbcjpbv.apps.googleusercontent.com';

/** Strip accidental `https://` / quotes pasted into DO env (causes invalid_client). */
export function normalizeGoogleClientId(raw: string | undefined | null): string {
  let v = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!v) return '';
  v = v.replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim();
  const match = v.match(/(\d+[a-z0-9-]*\.apps\.googleusercontent\.com)/i);
  return match?.[1] || v;
}

export function resolveGoogleClientId(): string {
  return (
    normalizeGoogleClientId(env.GOOGLE_CLIENT_ID) ||
    normalizeGoogleClientId(COPYRA_GOOGLE_CLIENT_ID)
  );
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  const clientId = resolveGoogleClientId();
  if (!clientId) return null;
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: clientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) return null;
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    return null;
  }
  if (payload.email_verified !== true) return null;
  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name ?? null,
  };
}
