import { OAuth2Client } from 'google-auth-library';
import { env, componentLogger } from '@copyra/core';

const log = componentLogger('google-auth');

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

function audienceList(): string | string[] {
  const primary = resolveGoogleClientId();
  const fallback = normalizeGoogleClientId(COPYRA_GOOGLE_CLIENT_ID);
  const list = [...new Set([primary, fallback].filter(Boolean))];
  return list.length <= 1 ? primary : list;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity | null> {
  const clientId = resolveGoogleClientId();
  if (!clientId) return null;
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: audienceList(),
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      return null;
    }
    // GIS normally sends boolean true; tolerate string forms just in case.
    const verified =
      payload.email_verified === true || String(payload.email_verified).toLowerCase() === 'true';
    if (!verified) return null;
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: true,
      name: payload.name ?? null,
    };
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Google ID token verification failed',
    );
    return null;
  }
}
